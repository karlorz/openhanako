import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPresentSkillPackageMembership,
  discoverClaudeSkillDirs,
  installClaudeSkillsFromPackage,
  inspectClaudePackageWarnings,
  readClaudeSkillsInstallRecord,
  reconcileClaudeSkillsInstallRecord,
  uninstallClaudeSkillsInstallRecord,
  writeClaudeSkillsInstallRecord,
} from "../lib/plugin-marketplace-claude-skills.ts";
import { PluginMarketplaceService } from "../lib/plugin-marketplace-service.ts";
import { parseMarketplaceCatalogAuto } from "../lib/plugin-marketplace-detect.ts";

const tempDirs: string[] = [];
function makeTemp(prefix = "hana-claude-skills-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function writeSkill(dir: string, name: string, description = "test skill") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

describe("discoverClaudeSkillDirs", () => {
  it("finds multiple SKILL.md packages under a Claude package root", () => {
    const root = makeTemp();
    writeSkill(path.join(root, "wiki-query"), "wiki-query");
    writeSkill(path.join(root, "wiki-ingest"), "wiki-ingest");
    fs.writeFileSync(path.join(root, "README.md"), "x", "utf8");
    const found = discoverClaudeSkillDirs(root);
    expect(found).toHaveLength(2);
    expect(found.map((p) => path.basename(p)).sort()).toEqual(["wiki-ingest", "wiki-query"]);
  });

  it("uses plugin.json skills field when present", () => {
    const root = makeTemp();
    const skillsContainer = path.join(root, "skills");
    writeSkill(path.join(skillsContainer, "alpha"), "alpha");
    writeSkill(path.join(skillsContainer, "beta"), "beta");
    // decoy outside skills/
    writeSkill(path.join(root, "other"), "other");
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "demo", skills: "./skills/" }),
      "utf8",
    );
    const found = discoverClaudeSkillDirs(root);
    expect(found.map((p) => path.basename(p)).sort()).toEqual(["alpha", "beta"]);
  });
});

describe("installClaudeSkillsFromPackage", () => {
  it("installs each skill into installDir and writes provenance", () => {
    const packageRoot = makeTemp("pkg-");
    writeSkill(path.join(packageRoot, "wiki-query"), "wiki-query");
    writeSkill(path.join(packageRoot, "wiki-ingest"), "wiki-ingest");
    const installDir = makeTemp("skills-");
    const home = makeTemp("home-");

    const result = installClaudeSkillsFromPackage({
      packageRoot,
      installDir,
      owner: "user",
    });
    expect(result.installed.map((s) => s.name).sort()).toEqual(["wiki-ingest", "wiki-query"]);
    expect(fs.existsSync(path.join(installDir, "wiki-query", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(installDir, "wiki-ingest", "SKILL.md"))).toBe(true);

    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      packagePath: "packages/skills",
      resolvedRevision: "abc",
      skills: result.installed.map((s) => s.name),
      installedAt: new Date().toISOString(),
    });
    const rec = readClaudeSkillsInstallRecord(home, "llm-wiki", "skillwiki");
    expect(rec?.skills.sort()).toEqual(["wiki-ingest", "wiki-query"]);
    expect(rec?.kind).toBe("claude-skills");
  });

  it("preserves an existing installed skill on marketplace name collision", () => {
    const packageRoot = makeTemp("pkg-collision-");
    writeSkill(path.join(packageRoot, "wiki-query"), "wiki-query", "marketplace version");
    const installDir = makeTemp("skills-collision-");
    writeSkill(path.join(installDir, "wiki-query"), "wiki-query", "existing user version");
    const before = fs.readFileSync(path.join(installDir, "wiki-query", "SKILL.md"), "utf8");

    const result = installClaudeSkillsFromPackage({
      packageRoot,
      installDir,
      owner: "user",
    });

    expect(result.installed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/already exists/i);
    expect(fs.readFileSync(path.join(installDir, "wiki-query", "SKILL.md"), "utf8")).toBe(before);
  });

  it("reports unsupported Claude components and package dependency signals", () => {
    const packageRoot = makeTemp("pkg-warnings-");
    writeSkill(path.join(packageRoot, "skills", "wiki-query"), "wiki-query");
    fs.mkdirSync(path.join(packageRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ skills: "./skills", hooks: { PostToolUse: [] }, mcpServers: { demo: {} } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ bin: { skillwiki: "bin/skillwiki.js" }, scripts: { postinstall: "node setup.js" }, dependencies: { zx: "^8.0.0" } }),
      "utf8",
    );
    fs.mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });

    const warnings = inspectClaudePackageWarnings(packageRoot);
    expect(warnings).toEqual(expect.arrayContaining([
      "unsupported Claude component not installed: hooks",
      "unsupported Claude component not installed: mcpServers",
      "package declares external CLI binaries; Hana does not install or execute them",
      "package declares npm scripts; Hana does not run package lifecycle or helper scripts",
      "package declares npm dependencies; Hana imports skills without running package installation",
      "package contains scripts/ resources outside imported skills; Hana does not execute them",
    ]));

    const installDir = makeTemp("skills-warnings-");
    const result = installClaudeSkillsFromPackage({ packageRoot, installDir });
    expect(result.installed.map((s) => s.name)).toEqual(["wiki-query"]);
    expect(result.warnings).toEqual(warnings);
  });
});

describe("marketplace Claude skills lifecycle", () => {
  function writeRecord(home: string, skills: string[]) {
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      packagePath: "packages/skills",
      resolvedRevision: "abc",
      skills,
      installedAt: "2026-07-31T00:00:00.000Z",
    });
  }

  it("reconciles absent, installed, partial, and stale records", () => {
    const home = makeTemp("lifecycle-home-");
    const skillsDir = path.join(home, "skills");
    expect(reconcileClaudeSkillsInstallRecord(home, "llm-wiki", "skillwiki", skillsDir).state)
      .toBe("not-installed");

    writeRecord(home, ["wiki-query", "wiki-sync"]);
    writeSkill(path.join(skillsDir, "wiki-query"), "wiki-query");
    writeSkill(path.join(skillsDir, "wiki-sync"), "wiki-sync");
    expect(reconcileClaudeSkillsInstallRecord(home, "llm-wiki", "skillwiki", skillsDir)).toMatchObject({
      state: "installed",
      present: ["wiki-query", "wiki-sync"],
      missing: [],
    });

    fs.rmSync(path.join(skillsDir, "wiki-sync"), { recursive: true, force: true });
    expect(reconcileClaudeSkillsInstallRecord(home, "llm-wiki", "skillwiki", skillsDir)).toMatchObject({
      state: "partial",
      present: ["wiki-query"],
      missing: ["wiki-sync"],
    });

    fs.rmSync(path.join(skillsDir, "wiki-query"), { recursive: true, force: true });
    expect(reconcileClaudeSkillsInstallRecord(home, "llm-wiki", "skillwiki", skillsDir).state)
      .toBe("stale-record");
  });

  it("deletes all recorded directories including modified skills and clears a stale record", () => {
    const home = makeTemp("uninstall-home-");
    const skillsDir = path.join(home, "skills");
    writeRecord(home, ["wiki-query", "wiki-sync"]);
    writeSkill(path.join(skillsDir, "wiki-query"), "wiki-query", "modified after install");

    const result = uninstallClaudeSkillsInstallRecord({
      hanakoHome: home,
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      userSkillsDir: skillsDir,
    });

    expect(result).toMatchObject({
      complete: true,
      deleted: ["wiki-query"],
      alreadyMissing: ["wiki-sync"],
      failed: [],
    });
    expect(fs.existsSync(path.join(skillsDir, "wiki-query"))).toBe(false);
    expect(readClaudeSkillsInstallRecord(home, "llm-wiki", "skillwiki")).toBeNull();
  });

  it("fails closed on invalid names and rewrites a partial record to unresolved skills", () => {
    const home = makeTemp("uninstall-partial-home-");
    const skillsDir = path.join(home, "skills");
    writeRecord(home, ["wiki-query", "wiki-sync", "../outside"]);
    writeSkill(path.join(skillsDir, "wiki-query"), "wiki-query");
    writeSkill(path.join(skillsDir, "wiki-sync"), "wiki-sync");
    const outside = path.join(home, "outside");
    writeSkill(outside, "outside");

    const result = uninstallClaudeSkillsInstallRecord({
      hanakoHome: home,
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      userSkillsDir: skillsDir,
      removeDir(dir) {
        if (dir.endsWith("wiki-sync")) throw new Error("busy");
        fs.rmSync(dir, { recursive: true, force: true });
      },
    });

    expect(result).toMatchObject({
      complete: false,
      deleted: ["wiki-query"],
      failed: [
        { name: "wiki-sync", error: "busy" },
        { name: "../outside", error: "invalid recorded skill name" },
      ],
    });
    expect(fs.existsSync(outside)).toBe(true);
    expect(readClaudeSkillsInstallRecord(home, "llm-wiki", "skillwiki")?.skills)
      .toEqual(["wiki-sync", "../outside"]);
  });
});

describe("PluginMarketplaceService.installClaudePluginSkills", () => {
  it("rejects stale refresh preconditions before source acquisition", async () => {
    const home = makeTemp("svc-refresh-stale-home-");
    const fetchImpl = vi.fn();
    const svc = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: { fetchImpl: fetchImpl as any },
    });
    svc.registry.addSource({
      id: "team-market",
      name: "Team Market",
      kind: "url",
      url: "https://example.com/team-market.json",
    });

    await expect(svc.refreshSource("team-market", {
      isStudioOwner: true,
      expectedRevision: 0,
    })).rejects.toMatchObject({ code: "PLUGIN_MARKETPLACE_REGISTRY_STALE", status: 409 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("materializes relative package via mocked git and installs skills", async () => {
    const home = makeTemp("svc-home-");
    const skillsDir = makeTemp("svc-skills-");
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });

    // Publish a Claude catalog snapshot for llm-wiki without real addSource
    const catalog = {
      name: "llm-wiki",
      owner: { name: "karlorz" },
      plugins: [{
        name: "skillwiki",
        version: "0.1.0",
        source: "./packages/skills",
      }],
    };
    const parsed = parseMarketplaceCatalogAuto(JSON.stringify(catalog), {
      marketplaceId: "llm-wiki",
      sourceKind: "git",
    });
    svc.snapshots.publish("llm-wiki", {
      sourceId: "llm-wiki",
      sourceFingerprint: "f".repeat(64),
      catalogSha256: parsed.catalogSha256,
      fetchedAt: new Date().toISOString(),
      plugins: parsed.plugins,
    });
    // Register git source in registry (snapshot already published — skip re-acquire)
    svc.registry.addSource({
      id: "llm-wiki",
      name: "llm-wiki",
      kind: "git",
      gitUrl: "https://github.com/karlorz/llm-wiki.git",
      gitRef: "refs/heads/main",
    });

    const execGit = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === "clone") {
        const dest = args[args.length - 1] as string;
        fs.mkdirSync(dest, { recursive: true });
        // package path materialize expects packages/skills under dest
        writeSkill(path.join(dest, "packages", "skills", "wiki-query"), "wiki-query");
        writeSkill(path.join(dest, "packages", "skills", "wiki-sync"), "wiki-sync");
        return "";
      }
      if (args.includes("sparse-checkout")) return "";
      if (args.includes("rev-parse")) return "dddddddddddddddddddddddddddddddddddddddd\n";
      if (args.includes("checkout")) return "";
      return "";
    });

    const result = await svc.installClaudePluginSkills("skillwiki", "llm-wiki", {
      userSkillsDir: skillsDir,
      isStudioOwner: true,
      execGit: execGit as any,
    });

    expect(result.skills.sort()).toEqual(["wiki-query", "wiki-sync"]);
    expect(result.warnings).toEqual([]);
    expect(result.resolvedRevision).toBe("dddddddddddddddddddddddddddddddddddddddd");
    expect(fs.existsSync(path.join(skillsDir, "wiki-query", "SKILL.md"))).toBe(true);
    const rec = readClaudeSkillsInstallRecord(home, "llm-wiki", "skillwiki");
    expect(rec?.skills.sort()).toEqual(["wiki-query", "wiki-sync"]);
    expect(rec?.warnings).toBeUndefined();
  });

  it("installs a contained relative package from an authorized local marketplace", async () => {
    const home = makeTemp("svc-local-home-");
    const allowedRoot = path.join(home, "plugin-marketplaces-local");
    const sourceDir = path.join(allowedRoot, "local-claude");
    const skillsDir = path.join(home, "skills");
    fs.mkdirSync(sourceDir, { recursive: true });
    writeSkill(path.join(sourceDir, "packages", "skills", "hello-safe"), "hello-safe");

    const svc = new PluginMarketplaceService({
      hanakoHome: home,
      localAllowedRoot: allowedRoot,
      env: {},
    });
    const parsed = parseMarketplaceCatalogAuto(JSON.stringify({
      name: "local-claude",
      owner: { name: "fixture" },
      plugins: [{ name: "hello-plugin", version: "1.0.0", source: "./packages/skills" }],
    }), {
      marketplaceId: "local-claude",
      sourceKind: "local",
    });
    svc.snapshots.publish("local-claude", {
      sourceId: "local-claude",
      sourceFingerprint: "f".repeat(64),
      catalogSha256: parsed.catalogSha256,
      fetchedAt: new Date().toISOString(),
      plugins: parsed.plugins,
    });
    svc.registry.addSource({
      id: "local-claude",
      name: "Local Claude",
      kind: "local",
      path: "local-claude",
    });

    const result = await svc.installClaudePluginSkills("hello-plugin", "local-claude", {
      userSkillsDir: skillsDir,
      isStudioOwner: true,
    });

    expect(result).toMatchObject({
      marketplaceId: "local-claude",
      pluginId: "hello-plugin",
      skills: ["hello-safe"],
      resolvedRevision: null,
    });
    expect(fs.existsSync(path.join(skillsDir, "hello-safe", "SKILL.md"))).toBe(true);
    expect(readClaudeSkillsInstallRecord(home, "local-claude", "hello-plugin")).toMatchObject({
      packagePath: "packages/skills",
      resolvedRevision: null,
      skills: ["hello-safe"],
    });
  });

  it("rejects a local package root that escapes through a symlink", async () => {
    const home = makeTemp("svc-local-escape-home-");
    const allowedRoot = path.join(home, "plugin-marketplaces-local");
    const sourceDir = path.join(allowedRoot, "local-claude");
    const outside = makeTemp("svc-local-escape-outside-");
    fs.mkdirSync(sourceDir, { recursive: true });
    writeSkill(path.join(outside, "hello-safe"), "hello-safe");
    fs.mkdirSync(path.join(sourceDir, "packages"), { recursive: true });
    fs.symlinkSync(outside, path.join(sourceDir, "packages", "skills"), "dir");

    const svc = new PluginMarketplaceService({
      hanakoHome: home,
      localAllowedRoot: allowedRoot,
      env: {},
    });
    const parsed = parseMarketplaceCatalogAuto(JSON.stringify({
      name: "local-claude",
      owner: { name: "fixture" },
      plugins: [{ name: "hello-plugin", version: "1.0.0", source: "./packages/skills" }],
    }), {
      marketplaceId: "local-claude",
      sourceKind: "local",
    });
    svc.snapshots.publish("local-claude", {
      sourceId: "local-claude",
      sourceFingerprint: "f".repeat(64),
      catalogSha256: parsed.catalogSha256,
      fetchedAt: new Date().toISOString(),
      plugins: parsed.plugins,
    });
    svc.registry.addSource({
      id: "local-claude",
      name: "Local Claude",
      kind: "local",
      path: "local-claude",
    });

    await expect(svc.installClaudePluginSkills("hello-plugin", "local-claude", {
      userSkillsDir: path.join(home, "skills"),
      isStudioOwner: true,
    })).rejects.toMatchObject({ code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN" });
    expect(readClaudeSkillsInstallRecord(home, "local-claude", "hello-plugin")).toBeNull();
  });

  it("fails zero-success marketplace skill installs and does not write provenance", async () => {
    const home = makeTemp("svc-empty-home-");
    const skillsDir = makeTemp("svc-empty-skills-");
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    const catalog = {
      name: "llm-wiki",
      owner: { name: "karlorz" },
      plugins: [{
        name: "skillwiki",
        version: "0.1.0",
        source: "./packages/skills",
      }],
    };
    const parsed = parseMarketplaceCatalogAuto(JSON.stringify(catalog), {
      marketplaceId: "llm-wiki",
      sourceKind: "git",
    });
    svc.snapshots.publish("llm-wiki", {
      sourceId: "llm-wiki",
      sourceFingerprint: "f".repeat(64),
      catalogSha256: parsed.catalogSha256,
      fetchedAt: new Date().toISOString(),
      plugins: parsed.plugins,
    });
    svc.registry.addSource({
      id: "llm-wiki",
      name: "llm-wiki",
      kind: "git",
      gitUrl: "https://github.com/karlorz/llm-wiki.git",
      gitRef: "refs/heads/main",
    });
    writeSkill(path.join(skillsDir, "wiki-query"), "wiki-query", "existing user version");
    const before = fs.readFileSync(path.join(skillsDir, "wiki-query", "SKILL.md"), "utf8");

    const execGit = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === "clone") {
        const dest = args[args.length - 1] as string;
        fs.mkdirSync(dest, { recursive: true });
        writeSkill(path.join(dest, "packages", "skills", "wiki-query"), "wiki-query", "marketplace version");
        return "";
      }
      if (args.includes("sparse-checkout")) return "";
      if (args.includes("rev-parse")) return "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n";
      if (args.includes("checkout")) return "";
      return "";
    });

    await expect(
      svc.installClaudePluginSkills("skillwiki", "llm-wiki", {
        userSkillsDir: skillsDir,
        isStudioOwner: true,
        execGit: execGit as any,
      }),
    ).rejects.toMatchObject({
      code: "PLUGIN_MARKETPLACE_SKILLS_INSTALL_EMPTY",
      status: 409,
    });
    expect(fs.readFileSync(path.join(skillsDir, "wiki-query", "SKILL.md"), "utf8")).toBe(before);
    expect(readClaudeSkillsInstallRecord(home, "llm-wiki", "skillwiki")).toBeNull();
  });

  it("rejects install without studio.owner", async () => {
    const home = makeTemp("svc-deny-");
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    await expect(
      svc.installClaudePluginSkills("skillwiki", "llm-wiki", {
        userSkillsDir: makeTemp(),
        isStudioOwner: false,
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN" });
  });

  it("uninstalls exact recorded skills, cleans activations, and leaves plugin directories untouched", () => {
    const home = makeTemp("svc-uninstall-home-");
    const skillsDir = path.join(home, "skills");
    writeSkill(path.join(skillsDir, "wiki-query"), "wiki-query", "modified");
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      packagePath: "packages/skills",
      resolvedRevision: "abc",
      skills: ["wiki-query", "wiki-sync"],
      installedAt: "2026-07-31T00:00:00.000Z",
    });
    const nativeDir = path.join(home, "plugins", "skillwiki");
    const devDir = path.join(home, "plugin-dev", "skillwiki");
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, "keep.txt"), "native", "utf8");
    fs.writeFileSync(path.join(devDir, "keep.txt"), "dev", "utf8");

    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    svc.registry.addSource({
      id: "llm-wiki",
      name: "llm-wiki",
      kind: "url",
      url: "https://example.com/llm-wiki.json",
    });
    svc.registry.addSource({
      id: "team",
      name: "team",
      kind: "url",
      url: "https://example.com/team.json",
    });
    svc.registry.setControlPlaneActivations({
      marketplaceSkills: {
        "wiki-query@llm-wiki/skillwiki": { enabled: true },
        "other@team/pack": { enabled: true },
      },
      marketplaceSkillPackages: {
        "skillwiki@llm-wiki": { enabled: false },
        "other@team": { enabled: true },
      },
      agentSkillOverrides: {
        "agent-a": {
          "wiki-query@llm-wiki/skillwiki": { enabled: false },
          "other@team/pack": { enabled: false },
        },
      },
      runtimePlugins: {
        "native-page@team": { enabled: true },
      },
      agentPluginAccess: {
        "agent-a": {
          "native-page@team": { enabled: false },
        },
      },
    });
    expect(svc.installedMarketplaceSkillRefs()).toEqual(["wiki-query@llm-wiki/skillwiki"]);

    const result = svc.uninstallClaudePluginSkills("skillwiki", "llm-wiki", {
      userSkillsDir: skillsDir,
      isStudioOwner: true,
    });

    expect(result).toMatchObject({
      complete: true,
      deleted: ["wiki-query"],
      alreadyMissing: ["wiki-sync"],
    });
    expect(svc.registry.getControlPlaneActivations()).toEqual({
      marketplaceSkills: { "other@team/pack": { enabled: true } },
      marketplaceSkillPackages: { "other@team": { enabled: true } },
      agentSkillOverrides: { "agent-a": { "other@team/pack": { enabled: false } } },
      runtimePlugins: { "native-page@team": { enabled: true } },
      agentPluginAccess: { "agent-a": { "native-page@team": { enabled: false } } },
    });
    expect(fs.readFileSync(path.join(nativeDir, "keep.txt"), "utf8")).toBe("native");
    expect(fs.readFileSync(path.join(devDir, "keep.txt"), "utf8")).toBe("dev");
  });

  it("retains package-gate record on partial uninstall while cleaning handled skill activations", () => {
    const home = makeTemp("svc-uninstall-partial-home-");
    const skillsDir = path.join(home, "skills");
    writeSkill(path.join(skillsDir, "wiki-query"), "wiki-query");
    writeSkill(path.join(skillsDir, "wiki-sync"), "wiki-sync");
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      packagePath: "packages/skills",
      resolvedRevision: "abc",
      skills: ["wiki-query", "wiki-sync"],
      installedAt: "2026-07-31T00:00:00.000Z",
    });

    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    svc.registry.addSource({
      id: "llm-wiki",
      name: "llm-wiki",
      kind: "url",
      url: "https://example.com/llm-wiki.json",
    });
    svc.registry.addSource({
      id: "team",
      name: "team",
      kind: "url",
      url: "https://example.com/team.json",
    });
    svc.registry.setControlPlaneActivations({
      marketplaceSkills: {
        "wiki-query@llm-wiki/skillwiki": { enabled: true },
        "wiki-sync@llm-wiki/skillwiki": { enabled: true },
      },
      marketplaceSkillPackages: {
        "skillwiki@llm-wiki": { enabled: false },
      },
    });

    const result = svc.uninstallClaudePluginSkills("skillwiki", "llm-wiki", {
      userSkillsDir: skillsDir,
      isStudioOwner: true,
      removeDir(dir) {
        if (dir.endsWith("wiki-sync")) throw new Error("busy");
        fs.rmSync(dir, { recursive: true, force: true });
      },
    });

    expect(result).toMatchObject({
      complete: false,
      deleted: ["wiki-query"],
      failed: [{ name: "wiki-sync", error: "busy" }],
    });
    // Only handled (deleted/alreadyMissing) skill activations are cleaned; package gate retained.
    expect(svc.registry.getControlPlaneActivations()).toEqual({
      marketplaceSkills: {
        "wiki-sync@llm-wiki/skillwiki": { enabled: true },
      },
      marketplaceSkillPackages: {
        "skillwiki@llm-wiki": { enabled: false },
      },
    });
    expect(readClaudeSkillsInstallRecord(home, "llm-wiki", "skillwiki")?.skills)
      .toEqual(["wiki-sync"]);
  });

  it("rejects marketplace skills uninstall without studio.owner before deletion", () => {
    const home = makeTemp("svc-uninstall-deny-");
    const skillsDir = path.join(home, "skills");
    writeSkill(path.join(skillsDir, "wiki-query"), "wiki-query");
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      packagePath: "packages/skills",
      resolvedRevision: "abc",
      skills: ["wiki-query"],
      installedAt: "2026-07-31T00:00:00.000Z",
    });
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });

    expect(() => svc.uninstallClaudePluginSkills("skillwiki", "llm-wiki", {
      userSkillsDir: skillsDir,
      isStudioOwner: false,
    })).toThrow(/studio\.owner/i);
    expect(fs.existsSync(path.join(skillsDir, "wiki-query"))).toBe(true);
  });

  it("toggles only one exact package gate while preserving all activation roots", () => {
    const home = makeTemp("svc-toggle-home-");
    const skillsDir = path.join(home, "skills");
    writeSkill(path.join(skillsDir, "wiki-query"), "wiki-query");
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      packagePath: "packages/skills",
      resolvedRevision: "abc",
      skills: ["wiki-query"],
      installedAt: "2026-07-31T00:00:00.000Z",
    });
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    svc.registry.addSource({
      id: "llm-wiki",
      name: "llm-wiki",
      kind: "url",
      url: "https://example.com/llm-wiki.json",
    });
    svc.registry.addSource({
      id: "team",
      name: "team",
      kind: "url",
      url: "https://example.com/team.json",
    });
    svc.registry.setControlPlaneActivations({
      marketplaceSkillPackages: { "other@team": { enabled: true } },
      marketplaceSkills: { "wiki-query@llm-wiki/skillwiki": { enabled: false } },
      runtimePlugins: { "native-page@team": { enabled: true } },
      agentSkillOverrides: {
        "agent-a": { "wiki-query@llm-wiki/skillwiki": { enabled: false } },
      },
      agentPluginAccess: { "agent-a": { "native-page@team": { enabled: false } } },
    });
    const status = svc.getRegistryStatus();

    const result = svc.setMarketplaceSkillPackageEnabled("skillwiki", "llm-wiki", false, {
      isStudioOwner: true,
      expectedRevision: status.revision,
      expectedDigest: status.digest,
    });

    expect(result).toMatchObject({
      identity: "skillwiki@llm-wiki",
      enabled: false,
      revision: status.revision + 1,
    });
    expect(svc.registry.getControlPlaneActivations()).toEqual({
      marketplaceSkillPackages: {
        "other@team": { enabled: true },
        "skillwiki@llm-wiki": { enabled: false },
      },
      marketplaceSkills: { "wiki-query@llm-wiki/skillwiki": { enabled: false } },
      runtimePlugins: { "native-page@team": { enabled: true } },
      agentSkillOverrides: {
        "agent-a": { "wiki-query@llm-wiki/skillwiki": { enabled: false } },
      },
      agentPluginAccess: { "agent-a": { "native-page@team": { enabled: false } } },
    });

    const unchangedStatus = svc.getRegistryStatus();
    const unchanged = svc.setMarketplaceSkillPackageEnabled("skillwiki", "llm-wiki", false, {
      isStudioOwner: true,
      expectedRevision: unchangedStatus.revision,
      expectedDigest: unchangedStatus.digest,
    });
    expect(unchanged).toMatchObject({ changed: false, revision: unchangedStatus.revision });
    expect(svc.getRegistryStatus().revision).toBe(unchangedStatus.revision);
  });

  it("builds deterministic remote-safe uninstall facts", () => {
    const home = makeTemp("svc-uninstall-facts-home-");
    const skillsDir = path.join(home, "skills");
    writeSkill(path.join(skillsDir, "wiki-query"), "wiki-query");
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      packagePath: "packages/skills",
      resolvedRevision: "abc",
      skills: ["wiki-sync", "wiki-query", "../outside"],
      installedAt: "2026-07-31T00:00:00.000Z",
    });
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    const facts = svc.getMarketplaceSkillPackageUninstallFacts("skillwiki", "llm-wiki", {
      userSkillsDir: skillsDir,
    });

    expect(facts).toMatchObject({
      pluginId: "skillwiki",
      marketplaceId: "llm-wiki",
      identity: "skillwiki@llm-wiki",
      state: "partial",
      recordedSkills: ["../outside", "wiki-query", "wiki-sync"],
      presentSkills: ["wiki-query"],
      missingSkills: ["wiki-sync"],
      invalidSkills: ["../outside"],
      cleanupTargets: ["wiki-query", "wiki-sync"],
      registry: { revision: expect.any(Number), digest: expect.any(String) },
    });
    expect(JSON.stringify(facts)).not.toContain(home);
    expect(svc.getMarketplaceSkillPackageUninstallFacts("skillwiki", "llm-wiki", {
      userSkillsDir: skillsDir,
    })).toEqual(facts);
  });
});

describe("buildPresentSkillPackageMembership", () => {
  it("maps present skills to their package identity", () => {
    const home = makeTemp("membership-home-");
    const skillsDir = path.join(home, "skills");
    writeSkill(path.join(skillsDir, "wiki-query"), "wiki-query");
    writeSkill(path.join(skillsDir, "wiki-sync"), "wiki-sync");
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      packagePath: "packages/skills",
      resolvedRevision: "abc",
      skills: ["wiki-query", "wiki-sync", "missing-skill"],
      installedAt: "2026-07-31T00:00:00.000Z",
    });

    const map = buildPresentSkillPackageMembership(home, skillsDir);
    expect([...map.keys()].sort()).toEqual(["wiki-query", "wiki-sync"]);
    expect(map.get("wiki-query")).toEqual({
      pluginId: "skillwiki",
      marketplaceId: "llm-wiki",
      identity: "skillwiki@llm-wiki",
    });
    expect(map.has("missing-skill")).toBe(false);
  });

  it("keeps lexicographically smaller package identity on skill name collision", () => {
    const home = makeTemp("membership-collision-");
    const skillsDir = path.join(home, "skills");
    writeSkill(path.join(skillsDir, "shared-skill"), "shared-skill");
    // larger identity: zebra@mkt-b
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "mkt-b",
      pluginId: "zebra",
      packagePath: "packages/zebra",
      resolvedRevision: null,
      skills: ["shared-skill"],
      installedAt: "2026-07-31T00:00:00.000Z",
    });
    // smaller identity: apple@mkt-a — wins on collision
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "mkt-a",
      pluginId: "apple",
      packagePath: "packages/apple",
      resolvedRevision: null,
      skills: ["shared-skill"],
      installedAt: "2026-07-31T00:00:00.000Z",
    });

    const map = buildPresentSkillPackageMembership(home, skillsDir);
    expect(map.get("shared-skill")).toEqual({
      pluginId: "apple",
      marketplaceId: "mkt-a",
      identity: "apple@mkt-a",
    });
    // Documented: the non-winning package must not claim the skill for enable/ownership.
    // SkillManager (Task 4) should only treat the map entry's package as owner of the skill.
  });
});
