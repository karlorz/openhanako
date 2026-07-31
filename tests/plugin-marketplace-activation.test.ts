import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeMarketplaceSkillPackageActivation } from "../lib/plugin-marketplace-activation.ts";
import { PluginMarketplaceService } from "../lib/plugin-marketplace-service.ts";
import { MarketplaceSnapshotStore } from "../lib/plugin-marketplace-snapshots.ts";
import { parseMarketplaceCatalogStrict } from "../lib/plugin-marketplace-schema.ts";
import { writeClaudeSkillsInstallRecord } from "../lib/plugin-marketplace-claude-skills.ts";

const tempDirs: string[] = [];

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mkt-activation-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeRegistry(home: string, value: unknown) {
  fs.writeFileSync(path.join(home, "plugin-marketplaces.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeInstalledSkill(home: string, name: string) {
  const dir = path.join(home, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
}

function seedSnapshot(home: string, marketplaceId: string, plugins: any[]) {
  const store = new MarketplaceSnapshotStore({ hanakoHome: home });
  const parsed = parseMarketplaceCatalogStrict({ schemaVersion: 1, plugins }, {
    marketplaceId,
    sourceKind: "url",
  });
  store.publish(marketplaceId, {
    sourceId: marketplaceId,
    sourceFingerprint: "1".repeat(64),
    catalogSha256: parsed.catalogSha256,
    fetchedAt: new Date().toISOString(),
    plugins: parsed.plugins,
  });
}

function nativePlugin(id: string, contributions = ["tools"]) {
  return {
    schemaVersion: 1,
    id,
    name: id,
    publisher: "Team",
    version: "1.0.0",
    description: id,
    repository: "https://example.com/plugin",
    compatibility: {},
    trust: "restricted",
    permissions: [],
    contributions,
    distribution: {
      kind: "release",
      packageUrl: "https://example.com/plugin.zip",
      sha256: "a".repeat(64),
    },
  };
}

function claudeSkillPlugin(id: string) {
  return {
    schemaVersion: 1,
    id,
    name: id,
    publisher: "Team",
    version: "1.0.0",
    description: id,
    repository: "https://example.com/plugin",
    compatibility: {},
    trust: "restricted",
    permissions: [],
    contributions: [],
    install: {
      catalogFormat: "claude",
      sourceKind: "relative",
      source: "packages/skills",
      canInstall: true,
    },
  };
}

describe("marketplace exact activation and native Agent Plugin Access", () => {
  it("keeps duplicate package names from different marketplaces independent", () => {
    const home = makeHome();
    writeRegistry(home, {
      schemaVersion: 2,
      revision: 3,
      sources: [
        { id: "team-a", name: "Team A", kind: "url", url: "https://example.com/a.json" },
        { id: "team-b", name: "Team B", kind: "url", url: "https://example.com/b.json" },
      ],
      activations: {
        runtimePlugins: {
          "demo@team-a": { enabled: true },
          "demo@team-b": { enabled: false },
        },
      },
    });
    seedSnapshot(home, "team-a", [nativePlugin("demo")]);
    seedSnapshot(home, "team-b", [nativePlugin("demo")]);
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    svc.records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "team-a",
      artifactDigest: "a".repeat(64),
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: "a".repeat(64),
      artifactPath: path.join(home, "plugins", "demo-a"),
      action: "install",
      result: "ok",
    });

    expect(svc.getRuntimePluginActivation("demo", "team-a")).toMatchObject({
      identity: "demo@team-a",
      state: "enabled",
      enabled: true,
      requested: true,
    });
    expect(svc.getRuntimePluginActivation("demo", "team-b")).toMatchObject({
      identity: "demo@team-b",
      state: "disabled",
      enabled: false,
      requested: false,
    });
  });

  it("treats source disable as an ancestor block without deleting retained artifacts", () => {
    const home = makeHome();
    writeRegistry(home, {
      schemaVersion: 2,
      revision: 1,
      sources: [{ id: "team-a", name: "Team A", kind: "url", url: "https://example.com/a.json" }],
      activations: { runtimePlugins: { "demo@team-a": { enabled: true } } },
    });
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    svc.records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "team-a",
      artifactDigest: "b".repeat(64),
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: "b".repeat(64),
      artifactPath: path.join(home, "plugins", "demo"),
      action: "install",
      result: "ok",
    });

    svc.setSourceEnabled("team-a", false, { isStudioOwner: true });
    expect(svc.getRuntimePluginActivation("demo", "team-a")).toMatchObject({
      state: "blocked-by-source",
      reason: expect.stringContaining("disabled"),
    });
    expect(svc.records.get("demo")?.retained?.["team-a"]?.["b".repeat(64)]).toBeTruthy();

    svc.setSourceEnabled("team-a", true, { isStudioOwner: true });
    expect(svc.getRuntimePluginActivation("demo", "team-a")).toMatchObject({
      state: "enabled",
      enabled: true,
    });
  });

  it("reports desired-not-installed without fetching, installing, or activating content implicitly", async () => {
    const home = makeHome();
    writeRegistry(home, {
      schemaVersion: 2,
      revision: 1,
      sources: [{ id: "team-a", name: "Team A", kind: "url", url: "https://example.com/a.json" }],
      activations: {
        runtimePlugins: { "demo@team-a": { enabled: true } },
        marketplaceSkills: { "review@team-a/demo": { enabled: true } },
      },
    });
    const svc = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: { fetchImpl: vi.fn() as any },
    });
    const installSpy = vi.spyOn(svc, "installClaudePluginSkills");

    expect(svc.getRuntimePluginActivation("demo", "team-a")).toMatchObject({
      state: "desired-not-installed",
      requested: true,
    });
    expect(svc.getMarketplaceSkillActivation("review", "team-a", "demo")).toMatchObject({
      state: "desired-not-installed",
      requested: true,
    });
    expect(svc.installedRuntimePluginRefs()).toEqual([]);
    expect(svc.installedMarketplaceSkillRefs()).toEqual([]);
    expect((svc as any).fetchOptions.fetchImpl).not.toHaveBeenCalled();
    expect(installSpy).not.toHaveBeenCalled();
  });

  it("keeps per-Agent marketplace skill activation separate from native plugin access", () => {
    const home = makeHome();
    writeRegistry(home, {
      schemaVersion: 2,
      revision: 1,
      sources: [{ id: "team-a", name: "Team A", kind: "url", url: "https://example.com/a.json" }],
      activations: {
        marketplaceSkills: { "review@team-a/skill-pack": { enabled: true } },
        agentSkillOverrides: {
          agentB: { "review@team-a/skill-pack": { enabled: false } },
        },
        agentPluginAccess: {
          agentA: { "native-tools@team-a": { enabled: true, contributions: ["tools"] } },
        },
      },
    });
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "team-a",
      pluginId: "skill-pack",
      packagePath: "packages/skills",
      resolvedRevision: "abc123",
      skills: ["review"],
      installedAt: new Date().toISOString(),
    });
    writeInstalledSkill(home, "review");
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    svc.records.retainAndActivate({
      pluginId: "native-tools",
      marketplaceId: "team-a",
      artifactDigest: "c".repeat(64),
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: "c".repeat(64),
      artifactPath: path.join(home, "plugins", "native-tools"),
      action: "install",
      result: "ok",
    });

    expect(svc.getMarketplaceSkillActivation("review", "team-a", "skill-pack", { agentId: "agentA" })).toMatchObject({
      identity: "review@team-a/skill-pack",
      state: "enabled",
    });
    expect(svc.getMarketplaceSkillActivation("review", "team-a", "skill-pack", { agentId: "agentB" })).toMatchObject({
      identity: "review@team-a/skill-pack",
      state: "disabled",
    });
    expect(svc.getNativeAgentPluginAccess("agentA", "native-tools", "team-a", ["tools"])).toMatchObject({
      identity: "native-tools@team-a",
      state: "enabled",
      allowedContributions: ["tools"],
    });
    expect(svc.getNativeAgentPluginAccess("agentB", "native-tools", "team-a", ["tools"])).toMatchObject({
      identity: "native-tools@team-a",
      state: "disabled",
      allowedContributions: [],
    });
  });

  it("warns that server-global native contributions remain owner-reviewed outside Agent Plugin Access", () => {
    const home = makeHome();
    writeRegistry(home, {
      schemaVersion: 2,
      revision: 1,
      sources: [{ id: "team-a", name: "Team A", kind: "url", url: "https://example.com/a.json" }],
      activations: {
        agentPluginAccess: {
          agentA: { "native-page@team-a": { enabled: true, contributions: ["tools", "pages", "routes"] } },
        },
      },
    });
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    svc.records.retainAndActivate({
      pluginId: "native-page",
      marketplaceId: "team-a",
      artifactDigest: "d".repeat(64),
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: "d".repeat(64),
      artifactPath: path.join(home, "plugins", "native-page"),
      action: "install",
      result: "ok",
    });

    expect(svc.getNativeAgentPluginAccess("agentA", "native-page", "team-a", [
      "tools",
      "pages",
      "routes",
      "providers",
      "lifecycle",
    ])).toMatchObject({
      state: "enabled",
      allowedContributions: ["tools", "pages"],
      requestedContributions: ["tools", "pages"],
      serverGlobalContributions: ["routes", "providers", "lifecycle"],
      warnings: [expect.stringContaining("owner-reviewed")],
    });
  });

  it("adds catalog activation annotations for installed marketplace skills", () => {
    const home = makeHome();
    writeRegistry(home, {
      schemaVersion: 2,
      revision: 1,
      sources: [{ id: "team-a", name: "Team A", kind: "url", url: "https://example.com/a.json" }],
      activations: {
        marketplaceSkills: { "review@team-a/skill-pack": { enabled: true } },
      },
    });
    seedSnapshot(home, "team-a", [claudeSkillPlugin("skill-pack")]);
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "team-a",
      pluginId: "skill-pack",
      packagePath: "packages/skills",
      resolvedRevision: "abc123",
      skills: ["review"],
      installedAt: new Date().toISOString(),
    });
    writeInstalledSkill(home, "review");
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });

    expect(svc.listCatalogRows().plugins[0]).toMatchObject({
      pluginId: "skill-pack",
      marketplaceId: "team-a",
      sourceEnabled: true,
      marketplaceSkillActivations: [{
        identity: "review@team-a/skill-pack",
        state: "enabled",
      }],
    });
  });
});

describe("computeMarketplaceSkillPackageActivation", () => {
  const sources = [{ id: "llm-wiki", enabled: true } as any];

  it("defaults installed package to enabled when no record exists", () => {
    const r = computeMarketplaceSkillPackageActivation({
      identity: "skillwiki@llm-wiki",
      activations: {},
      sources,
      installedPresent: true,
    });
    expect(r).toMatchObject({
      enabled: true,
      state: "enabled",
      recorded: false,
      requested: false,
      kind: "marketplace-skill-package",
      identity: "skillwiki@llm-wiki",
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
    });
  });

  it("disables all when package gate is false", () => {
    const r = computeMarketplaceSkillPackageActivation({
      identity: "skillwiki@llm-wiki",
      activations: {
        marketplaceSkillPackages: { "skillwiki@llm-wiki": { enabled: false } },
      },
      sources,
      installedPresent: true,
    });
    expect(r).toMatchObject({ enabled: false, state: "disabled", recorded: true });
  });

  it("blocks when source is disabled", () => {
    const r = computeMarketplaceSkillPackageActivation({
      identity: "skillwiki@llm-wiki",
      activations: {
        marketplaceSkillPackages: { "skillwiki@llm-wiki": { enabled: true } },
      },
      sources: [{ id: "llm-wiki", enabled: false } as any],
      installedPresent: true,
    });
    expect(r.enabled).toBe(false);
    expect(r.state).toBe("blocked-by-source");
  });

  it("reports desired-not-installed when record requests enable but package is absent", () => {
    const r = computeMarketplaceSkillPackageActivation({
      identity: "skillwiki@llm-wiki",
      activations: {
        marketplaceSkillPackages: { "skillwiki@llm-wiki": { enabled: true } },
      },
      sources,
      installedPresent: false,
    });
    expect(r).toMatchObject({
      enabled: false,
      state: "desired-not-installed",
      recorded: true,
      requested: true,
    });
  });

  it("reports disabled when no record and package is absent", () => {
    const r = computeMarketplaceSkillPackageActivation({
      identity: "skillwiki@llm-wiki",
      activations: {},
      sources,
      installedPresent: false,
    });
    expect(r).toMatchObject({
      enabled: false,
      state: "disabled",
      recorded: false,
      requested: false,
    });
  });

  it("enables when record is true and package is present", () => {
    const r = computeMarketplaceSkillPackageActivation({
      identity: "skillwiki@llm-wiki",
      activations: {
        marketplaceSkillPackages: { "skillwiki@llm-wiki": { enabled: true } },
      },
      sources,
      installedPresent: true,
    });
    expect(r).toMatchObject({
      enabled: true,
      state: "enabled",
      recorded: true,
      requested: true,
    });
  });
});
