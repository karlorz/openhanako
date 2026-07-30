import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginMarketplaceService } from "../lib/plugin-marketplace-service.ts";
import { MarketplaceSnapshotStore } from "../lib/plugin-marketplace-snapshots.ts";
import { parseMarketplaceCatalogStrict } from "../lib/plugin-marketplace-schema.ts";

const tempDirs: string[] = [];
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mkt-svc-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function seedOfficial(home: string) {
  const store = new MarketplaceSnapshotStore({ hanakoHome: home });
  const catalog = {
    schemaVersion: 1,
    plugins: [{
      schemaVersion: 1,
      id: "demo",
      name: "Demo",
      publisher: "Hana",
      version: "1.0.0",
      description: "Demo",
      repository: "https://example.com/demo",
      compatibility: {},
      trust: "restricted",
      permissions: [],
      contributions: [],
      distribution: {
        kind: "release",
        packageUrl: "https://example.com/demo.zip",
        sha256: "a".repeat(64),
      },
    }],
  };
  const parsed = parseMarketplaceCatalogStrict(catalog, {
    marketplaceId: "oh-plugins-official",
    sourceKind: "url",
  });
  store.publish("oh-plugins-official", {
    sourceId: "oh-plugins-official",
    sourceFingerprint: "1".repeat(64),
    catalogSha256: parsed.catalogSha256,
    fetchedAt: new Date().toISOString(),
    plugins: parsed.plugins,
  });
}

describe("PluginMarketplaceService", () => {
  it("lists compiled official source and composite catalog rows", () => {
    const home = makeHome();
    seedOfficial(home);
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    const sources = svc.listSources();
    expect(sources[0].id).toBe("oh-plugins-official");
    expect(sources[0].authority).toBe("official");
    expect(sources[0].catalogCount).toBe(1);
    const catalog = svc.listCatalogRows({ agentId: "agent-a" });
    expect(catalog.plugins[0]).toMatchObject({
      pluginId: "demo",
      marketplaceId: "oh-plugins-official",
      compositeKey: "demo@oh-plugins-official",
      installTarget: "native-plugin",
      installAdapter: "plugin-manager",
      installable: false,
      confirmationLevel: "capability-review",
      installPlan: {
        action: "install",
        destination: "native-plugin",
        installAdapter: "plugin-manager",
        installable: false,
      },
      nativeAgentPluginAccess: {
        identity: "demo@oh-plugins-official",
        agentId: "agent-a",
        enabled: false,
        state: "disabled",
      },
    });
  });

  it("reports the server-owned marketplace capability contract and registry status", () => {
    const home = makeHome();
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    expect(svc.getCapabilityContract()).toMatchObject({
      supported: true,
      version: "plugin-marketplace-capabilities.v1",
      features: {
        multiSourceBrowse: true,
        sourceConfigRevision: true,
        sourceConfigDigest: true,
        lastKnownGoodRegistry: true,
        marketplaceSkillInstall: true,
        agentMarketplaceManagement: true,
        claudeCompatibilityBindings: true,
        nativeMarketplaceInstall: false,
        claudeCompatibilityBridgeValidation: true,
        desktopClaudeCompatibilityBridgeTransport: false,
      },
    });
    expect(svc.getRegistryStatus()).toMatchObject({
      revision: 0,
      degraded: false,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(svc.getRegistryStatus({ forRemote: true }).path).toBe("[server-local path redacted]");
    expect(svc.getControlPlaneDiagnostics({ forRemote: true }).path).toBe("[server-local path redacted]");
  });

  it("runs one singleton-safe bounded digest poll loop for live compatibility bindings", async () => {
    vi.useFakeTimers();
    const svc = new PluginMarketplaceService({ hanakoHome: makeHome(), env: {} });
    const poll = vi.spyOn(svc.claudeCompatibility, "pollLiveBindings").mockReturnValue([]);
    try {
      svc.startClaudeCompatibilityPolling(1_000);
      svc.startClaudeCompatibilityPolling(1_000);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(poll).toHaveBeenCalledTimes(4);

      svc.stopClaudeCompatibilityPolling();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(poll).toHaveBeenCalledTimes(4);
    } finally {
      svc.stopClaudeCompatibilityPolling();
      vi.useRealTimers();
    }
  });

  it("adds a URL source after successful snapshot with studio.owner", async () => {
    const home = makeHome();
    seedOfficial(home);
    const catalog = {
      schemaVersion: 1,
      plugins: [{
        schemaVersion: 1,
        id: "demo",
        name: "Team Demo",
        publisher: "Team",
        version: "2.0.0",
        description: "Demo",
        repository: "https://example.com/demo",
        compatibility: {},
        trust: "restricted",
        permissions: [],
        contributions: [],
        distribution: {
          kind: "release",
          packageUrl: "https://example.com/demo2.zip",
          sha256: "b".repeat(64),
        },
      }],
    };
    const svc = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: {
        fetchImpl: async () => new Response(JSON.stringify(catalog), { status: 200 }),
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    });
    await svc.addSource(
      {
        id: "team-plugins",
        name: "Team",
        kind: "url",
        url: "https://example.com/marketplace.json",
      },
      { isStudioOwner: true },
    );
    const catalogRows = svc.listCatalogRows();
    expect(catalogRows.plugins.filter((p) => p.pluginId === "demo")).toHaveLength(2);
    const resolve = svc.resolveInstall("demo");
    expect(resolve).toMatchObject({ ok: true, mode: "official" });
  });

  it("rejects source mutations without studio.owner", async () => {
    const home = makeHome();
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });
    await expect(
      svc.addSource(
        {
          id: "team-plugins",
          name: "Team",
          kind: "url",
          url: "https://example.com/marketplace.json",
        },
        { isStudioOwner: false },
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN" });
  });

  it("pins install resolution to marketplaceId and returns catalog plugin", async () => {
    const home = makeHome();
    seedOfficial(home);
    const catalog = {
      schemaVersion: 1,
      plugins: [{
        schemaVersion: 1,
        id: "demo",
        name: "Team Demo",
        publisher: "Team",
        version: "2.0.0",
        description: "Demo",
        repository: "https://example.com/demo",
        compatibility: {},
        trust: "restricted",
        permissions: [],
        contributions: [],
        distribution: {
          kind: "release",
          packageUrl: "https://example.com/demo2.zip",
          sha256: "b".repeat(64),
        },
      }],
    };
    const svc = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: {
        fetchImpl: async () => new Response(JSON.stringify(catalog), { status: 200 }),
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    });
    await svc.addSource(
      {
        id: "team-plugins",
        name: "Team",
        kind: "url",
        url: "https://example.com/marketplace.json",
      },
      { isStudioOwner: true },
    );

    const bare = svc.resolveInstall("demo");
    expect(bare).toMatchObject({ ok: true, mode: "official" });

    const pinned = svc.resolveInstall("demo", "team-plugins");
    expect(pinned).toMatchObject({ ok: true, mode: "qualified" });
    if (pinned.ok) {
      expect(pinned.row.marketplaceId).toBe("team-plugins");
      const full = svc.getCatalogPlugin("demo", pinned.row.marketplaceId);
      expect(full?.version).toBe("2.0.0");
      expect(full?.distribution).toMatchObject({ kind: "release", sha256: "b".repeat(64) });
    }

    const missing = svc.resolveInstall("demo", "no-such-source");
    expect(missing).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
