import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createPluginsRoute } from "../server/routes/plugins.ts";
import { writeClaudeSkillsInstallRecord } from "../lib/plugin-marketplace-claude-skills.ts";
import { loadConfig, saveConfig } from "../lib/memory/config-loader.ts";

const tempDirs: string[] = [];
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mkt-auth-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function createEngine(hanakoHome: string) {
  return {
    hanakoHome,
    pluginManager: {
      listPlugins: () => [],
      getRouteApp: () => null,
    },
    pluginMarketplace: null,
    pluginMarketplaceService: null,
    userSkillsDir: path.join(hanakoHome, "skills"),
    fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [] }), { status: 200 }),
  } as any;
}

function createAppWithPrincipal(engine: any, principal: any) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (principal) (c as any).set("authPrincipal", principal);
    await next();
  });
  app.route("/api", createPluginsRoute(engine));
  return app;
}

const localOwner = Object.freeze({
  kind: "local_user",
  connectionKind: "local",
  credentialKind: "loopback_token",
  scopes: ["settings.write", "studio.owner"],
});

describe("marketplace sources auth principal", () => {
  it("rejects source add when authPrincipal is missing (old requestPrincipal bug path)", async () => {
    const home = makeHome();
    const app = createAppWithPrincipal(createEngine(home), null);
    const res = await app.request("/api/plugins/marketplace/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "llm-wiki",
        name: "llm-wiki",
        kind: "url",
        url: "https://example.com/marketplace.json",
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN");
    expect(String(body.error)).toMatch(/studio\.owner/i);
  });

  it("allows source add when authPrincipal is local_user loopback (desktop local)", async () => {
    const home = makeHome();
    const catalog = {
      schemaVersion: 1,
      plugins: [{
        schemaVersion: 1,
        id: "demo",
        name: "Demo",
        publisher: "T",
        version: "1.0.0",
        description: "d",
        repository: "https://example.com/r",
        compatibility: {},
        trust: "restricted",
        permissions: [],
        contributions: [],
        distribution: {
          kind: "release",
          packageUrl: "https://example.com/d.zip",
          sha256: "a".repeat(64),
        },
      }],
    };
    const engine = createEngine(home);
    engine.fetch = async () => new Response(JSON.stringify(catalog), { status: 200 });
    // DNS pin for safeFetch
    const app = createAppWithPrincipal(engine, localOwner);

    // Inject fetchOptions via service by monkeypatching after route creates service —
    // set env so PluginMarketplaceService uses global fetch we control is hard;
    // instead pass pluginMarketplaceService prebuilt.
    const { PluginMarketplaceService } = await import("../lib/plugin-marketplace-service.ts");
    engine.pluginMarketplaceService = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: {
        fetchImpl: async () => new Response(JSON.stringify(catalog), { status: 200 }),
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    });

    const res = await app.request("/api/plugins/marketplace/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "team-plugins",
        name: "Team",
        kind: "url",
        url: "https://example.com/marketplace.json",
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.error).toBeUndefined();
  });

  it("advertises marketplace capabilities and registry revision/digest", async () => {
    const home = makeHome();
    const app = createAppWithPrincipal(createEngine(home), localOwner);
    const res = await app.request("/api/plugins/marketplace/capabilities");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      supported: true,
      version: "plugin-marketplace-capabilities.v1",
      features: {
        multiSourceBrowse: true,
        sourceConfigDigest: true,
        nativeMarketplaceInstall: false,
        claudeCompatibilityBridgeValidation: true,
        desktopClaudeCompatibilityBridgeTransport: false,
      },
      access: {
        isStudioOwner: true,
        isLocalOwner: true,
      },
      registry: {
        revision: 0,
        degraded: false,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("returns config diagnostics without seeding or fetching marketplace content", async () => {
    const home = makeHome();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [] }), { status: 200 }));
    const engine = createEngine(home);
    const { PluginMarketplaceService } = await import("../lib/plugin-marketplace-service.ts");
    engine.pluginMarketplaceService = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: {
        fetchImpl,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    });
    fs.writeFileSync(path.join(home, "plugin-marketplaces.json"), JSON.stringify({
      schemaVersion: 2,
      revision: 1,
      sources: [{
        id: "team-plugins",
        name: "Team",
        kind: "url",
        url: "https://example.com/marketplace.json",
        enabled: false,
      }],
      activations: {
        runtimePlugins: { "demo@team-plugins": { enabled: true } },
      },
      futureRoot: true,
    }, null, 2), "utf8");
    const app = createAppWithPrincipal(engine, localOwner);

    const res = await app.request("/api/plugins/marketplace/config");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.configDiagnostics).toMatchObject({
      ok: true,
      summary: {
        schemaVersion: 2,
        revision: 1,
        disabledSources: ["team-plugins"],
        runtimePluginActivations: 1,
      },
    });
    expect(body.configDiagnostics.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PLUGIN_MARKETPLACE_CONFIG_FIELD_UNSUPPORTED" }),
      expect.objectContaining({ code: "PLUGIN_MARKETPLACE_SOURCE_DISABLED" }),
    ]));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not soft-seed marketplace content while config JSON is invalid", async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, "plugin-marketplaces.json"), "{ not json", "utf8");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [] }), { status: 200 }));
    const engine = createEngine(home);
    const { PluginMarketplaceService } = await import("../lib/plugin-marketplace-service.ts");
    engine.pluginMarketplaceService = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: {
        fetchImpl,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    });
    const app = createAppWithPrincipal(engine, localOwner);

    const res = await app.request("/api/plugins/marketplace/catalog");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.registry).toMatchObject({
      degraded: true,
      lastKnownGood: false,
    });
    expect(body.plugins).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not install or fetch marketplace packages while config JSON is invalid", async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, "plugin-marketplaces.json"), "{ not json", "utf8");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [] }), { status: 200 }));
    const engine = createEngine(home);
    engine.pluginManager = {
      listPlugins: () => [],
      getRouteApp: () => null,
      getUserPluginsDir: () => path.join(home, "plugins"),
      installPlugin: vi.fn(),
    };
    const { PluginMarketplaceService } = await import("../lib/plugin-marketplace-service.ts");
    engine.pluginMarketplaceService = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: {
        fetchImpl,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    });
    const app = createAppWithPrincipal(engine, localOwner);

    const res = await app.request("/api/plugins/marketplace/demo/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketplaceId: "oh-plugins-official" }),
    });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe("PLUGIN_MARKETPLACE_REGISTRY_DEGRADED");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(engine.pluginManager.installPlugin).not.toHaveBeenCalled();
  });

  it("owner-gates activation control-plane writes and rejects invalid records", async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, "plugin-marketplaces.json"), JSON.stringify({
      schemaVersion: 2,
      revision: 1,
      sources: [{ id: "team-plugins", name: "Team", kind: "url", url: "https://example.com/marketplace.json" }],
    }, null, 2), "utf8");
    const engine = createEngine(home);
    engine.reloadSkills = vi.fn(async () => {});
    engine.emitEvent = vi.fn();
    const appNoPrincipal = createAppWithPrincipal(engine, null);

    const forbidden = await appNoPrincipal.request("/api/plugins/marketplace/config/activations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activations: { runtimePlugins: { "demo@team-plugins": { enabled: true } } },
        expectedRevision: 1,
      }),
    });
    expect(forbidden.status).toBe(403);
    expect(engine.reloadSkills).not.toHaveBeenCalled();

    const app = createAppWithPrincipal(engine, localOwner);
    const invalid = await app.request("/api/plugins/marketplace/config/activations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activations: {
          runtimePlugins: { "demo@missing-source": { enabled: true } },
        },
        expectedRevision: 1,
      }),
    });
    const invalidBody = await invalid.json();
    expect(invalid.status).toBe(400);
    expect(invalidBody.code).toBe("PLUGIN_MARKETPLACE_CONTROL_PLANE_INVALID");
    expect(engine.reloadSkills).not.toHaveBeenCalled();

    const ok = await app.request("/api/plugins/marketplace/config/activations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activations: {
          runtimePlugins: { "demo@team-plugins": { enabled: true } },
          agentPluginAccess: { agentA: { "demo@team-plugins": { enabled: true, contributions: ["tools"] } } },
        },
        expectedRevision: 1,
      }),
    });
    const okBody = await ok.json();
    expect(ok.status).toBe(200);
    expect(okBody).toMatchObject({
      revision: 2,
      registry: {
        revision: 2,
        degraded: false,
      },
      activations: {
        runtimePlugins: { "demo@team-plugins": { enabled: true } },
      },
    });
    // Package/skill activation toggles must re-sync agent skills without waiting for file watch.
    expect(engine.reloadSkills).toHaveBeenCalledOnce();
    expect(engine.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "app_event",
      event: expect.objectContaining({ type: "skills-changed" }),
    }), null);
  });

  it("lists installed marketplace skill packages for owners and non-owner readers", async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, "skills", "wiki-query"), { recursive: true });
    fs.writeFileSync(path.join(home, "skills", "wiki-query", "SKILL.md"), "---\nname: wiki-query\n---\n", "utf8");
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      packagePath: "packages/skillwiki",
      resolvedRevision: "abc",
      skills: ["wiki-query"],
      installedAt: "2026-07-31T00:00:00.000Z",
    });
    fs.writeFileSync(path.join(home, "plugin-marketplaces.json"), JSON.stringify({
      schemaVersion: 2,
      revision: 3,
      sources: [{
        id: "llm-wiki",
        name: "llm-wiki",
        kind: "git",
        gitUrl: "https://example.com/llm-wiki.git",
        enabled: true,
      }],
      activations: {
        marketplaceSkillPackages: { "skillwiki@llm-wiki": { enabled: false } },
        marketplaceSkills: { "wiki-query@llm-wiki/skillwiki": { enabled: true } },
        runtimePlugins: { "demo@llm-wiki": { enabled: true } },
      },
    }, null, 2), "utf8");

    const engine = createEngine(home);
    const { PluginMarketplaceService } = await import("../lib/plugin-marketplace-service.ts");
    engine.pluginMarketplaceService = new PluginMarketplaceService({ hanakoHome: home, env: {} });

    const ownerApp = createAppWithPrincipal(engine, localOwner);
    const ownerRes = await ownerApp.request("/api/plugins/marketplace/installed-skill-packages");
    const ownerBody = await ownerRes.json();
    expect(ownerRes.status).toBe(200);
    expect(ownerBody.packages).toHaveLength(1);
    expect(ownerBody.packages[0]).toMatchObject({
      kind: "marketplace-skill-package",
      identity: "skillwiki@llm-wiki",
      pluginId: "skillwiki",
      marketplaceId: "llm-wiki",
      packageEnabled: false,
      packageGateRecorded: true,
      skillNames: ["wiki-query"],
      installAdapter: "skill-manager",
      installTarget: "hana-skills",
    });
    expect(ownerBody.registry).toMatchObject({
      revision: 3,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(ownerBody.access).toMatchObject({
      isStudioOwner: true,
      isLocalOwner: true,
    });
    // Owners get full activations snapshot so PUT can clone without wiping maps.
    expect(ownerBody.activations).toEqual({
      marketplaceSkillPackages: { "skillwiki@llm-wiki": { enabled: false } },
      marketplaceSkills: { "wiki-query@llm-wiki/skillwiki": { enabled: true } },
      runtimePlugins: { "demo@llm-wiki": { enabled: true } },
    });

    const nonOwner = Object.freeze({
      kind: "device",
      connectionKind: "lan",
      credentialKind: "device_credential",
      scopes: ["settings.read"],
    });
    const readerApp = createAppWithPrincipal(engine, nonOwner);
    const readerRes = await readerApp.request("/api/plugins/marketplace/installed-skill-packages");
    const readerBody = await readerRes.json();
    expect(readerRes.status).toBe(200);
    expect(readerBody.packages).toHaveLength(1);
    expect(readerBody.packages[0].identity).toBe("skillwiki@llm-wiki");
    expect(readerBody.access).toMatchObject({
      isStudioOwner: false,
      isLocalOwner: false,
    });
    // Non-owners may read inventory; full activations clone is owner-facing.
    expect(readerBody.activations).toBeUndefined();
  });

  it("returns empty installed skill packages when marketplace service is unavailable", async () => {
    const engine = {
      // no hanakoHome → getMarketplaceService throws
      pluginManager: { listPlugins: () => [], getRouteApp: () => null },
      pluginMarketplace: null,
      pluginMarketplaceService: null,
    } as any;
    const app = createAppWithPrincipal(engine, localOwner);
    const res = await app.request("/api/plugins/marketplace/installed-skill-packages");
    const body = await res.json();
    expect(res.status).toBe(501);
    expect(body.packages).toEqual([]);
    expect(body).toMatchObject({
      supported: false,
      code: "PLUGIN_MARKETPLACE_UNSUPPORTED_SERVER",
      version: "plugin-marketplace-capabilities.v1",
    });
  });

  it("rejects stale registry digest before acquiring a source", async () => {
    const home = makeHome();
    const engine = createEngine(home);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [] }), { status: 200 }));
    const { PluginMarketplaceService } = await import("../lib/plugin-marketplace-service.ts");
    engine.pluginMarketplaceService = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: {
        fetchImpl,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    });
    const app = createAppWithPrincipal(engine, localOwner);

    const res = await app.request("/api/plugins/marketplace/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "team-plugins",
        name: "Team",
        kind: "url",
        url: "https://example.com/marketplace.json",
        expectedDigest: "0".repeat(64),
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe("PLUGIN_MARKETPLACE_REGISTRY_STALE");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks multi-source native marketplace install as preview-only", async () => {
    const home = makeHome();
    const engine = createEngine(home);
    const installPlugin = vi.fn();
    engine.pluginManager = {
      listPlugins: () => [],
      getRouteApp: () => null,
      getUserPluginsDir: () => path.join(home, "plugins"),
      installPlugin,
    };
    const { PluginMarketplaceService } = await import("../lib/plugin-marketplace-service.ts");
    const { MarketplaceSnapshotStore } = await import("../lib/plugin-marketplace-snapshots.ts");
    const { parseMarketplaceCatalogStrict } = await import("../lib/plugin-marketplace-schema.ts");
    engine.pluginMarketplaceService = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    const parsed = parseMarketplaceCatalogStrict({
      schemaVersion: 1,
      plugins: [{
        schemaVersion: 1,
        id: "native-page",
        name: "Native Page",
        publisher: "Hana",
        version: "1.0.0",
        description: "Native",
        repository: "https://example.com/native",
        compatibility: {},
        trust: "restricted",
        permissions: [],
        contributions: ["tools"],
        distribution: {
          kind: "release",
          packageUrl: "https://example.com/native.zip",
          sha256: "a".repeat(64),
        },
      }],
    }, {
      marketplaceId: "oh-plugins-official",
      sourceKind: "url",
    });
    new MarketplaceSnapshotStore({ hanakoHome: home }).publish("oh-plugins-official", {
      sourceId: "oh-plugins-official",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: parsed.catalogSha256,
      fetchedAt: new Date().toISOString(),
      plugins: parsed.plugins,
    });
    const app = createAppWithPrincipal(engine, localOwner);

    const stale = await app.request("/api/plugins/marketplace/native-page/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketplaceId: "oh-plugins-official", expectedRevision: 99 }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "PLUGIN_MARKETPLACE_REGISTRY_STALE" });

    const res = await app.request("/api/plugins/marketplace/native-page/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketplaceId: "oh-plugins-official" }),
    });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      code: "PLUGIN_MARKETPLACE_NATIVE_INSTALL_PREVIEW_ONLY",
    });
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it("owner can uninstall an exact marketplace skills package and clean Agent references", async () => {
    const home = makeHome();
    const engine = createEngine(home);
    engine.agentsDir = path.join(home, "agents");
    engine.reloadSkills = vi.fn(async () => {});
    engine.emitEvent = vi.fn();
    const skillDir = path.join(engine.userSkillsDir, "wiki-query");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: wiki-query\n---\n", "utf8");
    const agentConfig = path.join(engine.agentsDir, "agent-a", "config.yaml");
    fs.mkdirSync(path.dirname(agentConfig), { recursive: true });
    fs.writeFileSync(agentConfig, "{}\n", "utf8");
    const agent = {
      id: "agent-a",
      config: {
        skills: {
          enabled: ["wiki-query", "other"],
          marketplace_overrides: {
            "skillwiki@llm-wiki": { disabled: ["wiki-query", "wiki-sync"] },
            "other@source": { disabled: ["other-skill"] },
          },
        },
      },
    };
    saveConfig(agentConfig, agent.config);
    engine.agents = new Map([[agent.id, agent]]);
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      packagePath: "packages/skills",
      resolvedRevision: "abc",
      skills: ["wiki-query", "wiki-sync"],
      installedAt: "2026-07-31T00:00:00.000Z",
    });
    const app = createAppWithPrincipal(engine, localOwner);

    const res = await app.request("/api/plugins/marketplace/skillwiki/skills", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketplaceId: "llm-wiki" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      deleted: ["wiki-query"],
      alreadyMissing: ["wiki-sync"],
      failed: [],
      referenceCleanup: { updatedAgents: ["agent-a"], failedAgents: [] },
    });
    expect(fs.existsSync(skillDir)).toBe(false);
    expect(loadConfig(agentConfig)?.skills?.enabled).toEqual(["other"]);
    expect(loadConfig(agentConfig)?.skills?.marketplace_overrides).toEqual({
      "other@source": { disabled: ["other-skill"] },
    });
    expect(agent.config.skills.marketplace_overrides).toEqual({
      "other@source": { disabled: ["other-skill"] },
    });
    expect(engine.reloadSkills).toHaveBeenCalledOnce();
    expect(engine.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "app_event",
      event: expect.objectContaining({ type: "skills-changed" }),
    }), null);
  });

  it("rejects marketplace skills uninstall without owner before filesystem mutation", async () => {
    const home = makeHome();
    const engine = createEngine(home);
    const skillDir = path.join(engine.userSkillsDir, "wiki-query");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: wiki-query\n---\n", "utf8");
    writeClaudeSkillsInstallRecord(home, {
      kind: "claude-skills",
      marketplaceId: "llm-wiki",
      pluginId: "skillwiki",
      packagePath: "packages/skills",
      resolvedRevision: "abc",
      skills: ["wiki-query"],
      installedAt: "2026-07-31T00:00:00.000Z",
    });
    const app = createAppWithPrincipal(engine, null);

    const res = await app.request("/api/plugins/marketplace/skillwiki/skills", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketplaceId: "llm-wiki" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN" });
    expect(fs.existsSync(skillDir)).toBe(true);
  });
});
