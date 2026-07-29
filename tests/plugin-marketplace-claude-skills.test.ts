import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverClaudeSkillDirs,
  installClaudeSkillsFromPackage,
  readClaudeSkillsInstallRecord,
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
});

describe("PluginMarketplaceService.installClaudePluginSkills", () => {
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
    expect(result.resolvedRevision).toBe("dddddddddddddddddddddddddddddddddddddddd");
    expect(fs.existsSync(path.join(skillsDir, "wiki-query", "SKILL.md"))).toBe(true);
    const rec = readClaudeSkillsInstallRecord(home, "llm-wiki", "skillwiki");
    expect(rec?.skills.sort()).toEqual(["wiki-query", "wiki-sync"]);
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
});
