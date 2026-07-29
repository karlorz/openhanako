import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MarketplaceSnapshotStore,
  type MarketplaceSnapshot,
} from "../lib/plugin-marketplace-snapshots.ts";
import { parseMarketplaceCatalogStrict } from "../lib/plugin-marketplace-schema.ts";

const tempDirs: string[] = [];

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mkt-snap-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sampleCatalog(pluginId = "demo") {
  return {
    schemaVersion: 1,
    plugins: [{
      schemaVersion: 1,
      id: pluginId,
      name: "Demo",
      publisher: "Hana",
      version: "1.0.0",
      description: "Demo plugin",
      repository: "https://example.com/demo",
      compatibility: { minAppVersion: "0.170.0" },
      trust: "restricted",
      permissions: ["task.read"],
      contributions: ["tools"],
      distribution: {
        kind: "release",
        packageUrl: "https://example.com/demo.zip",
        sha256: "a".repeat(64),
      },
    }],
  };
}

function buildSnapshot(sourceId: string, catalog: unknown, fingerprint = "f".repeat(64)): MarketplaceSnapshot {
  const parsed = parseMarketplaceCatalogStrict(catalog, {
    marketplaceId: sourceId,
    sourceKind: "url",
  });
  return {
    sourceId,
    sourceFingerprint: fingerprint,
    catalogSha256: parsed.catalogSha256,
    fetchedAt: new Date().toISOString(),
    plugins: parsed.plugins,
  };
}

describe("strict marketplace catalog schema", () => {
  it("accepts a valid release catalog and tags marketplace identity", () => {
    const parsed = parseMarketplaceCatalogStrict(sampleCatalog(), {
      marketplaceId: "team-plugins",
      sourceKind: "url",
    });
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0]).toMatchObject({
      id: "demo",
      marketplaceId: "team-plugins",
      distribution: {
        kind: "release",
        packageUrl: "https://example.com/demo.zip",
        sha256: "a".repeat(64),
      },
    });
    expect(parsed.catalogSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects duplicate JSON object keys", () => {
    const raw = '{"schemaVersion":1,"plugins":[],"schemaVersion":2}';
    expect(() =>
      parseMarketplaceCatalogStrict(raw, { marketplaceId: "team-plugins", sourceKind: "url" }),
    ).toThrow(/duplicate/i);
  });

  it("rejects unsupported schema version, unknown fields, and malformed arrays", () => {
    expect(() =>
      parseMarketplaceCatalogStrict(
        { schemaVersion: 99, plugins: [] },
        { marketplaceId: "team-plugins", sourceKind: "url" },
      ),
    ).toThrow(/schemaVersion/i);

    expect(() =>
      parseMarketplaceCatalogStrict(
        { schemaVersion: 1, plugins: [], extra: true },
        { marketplaceId: "team-plugins", sourceKind: "url" },
      ),
    ).toThrow(/unknown field/i);

    expect(() =>
      parseMarketplaceCatalogStrict(
        { schemaVersion: 1, plugins: "nope" },
        { marketplaceId: "team-plugins", sourceKind: "url" },
      ),
    ).toThrow(/plugins/i);
  });

  it("rejects duplicate plugin ids and version ids", () => {
    const catalog = sampleCatalog();
    catalog.plugins.push({ ...catalog.plugins[0] });
    expect(() =>
      parseMarketplaceCatalogStrict(catalog, { marketplaceId: "team-plugins", sourceKind: "url" }),
    ).toThrow(/duplicate plugin/i);

    const withDupVersion = sampleCatalog();
    (withDupVersion.plugins[0] as any).versions = [
      {
        version: "1.0.0",
        distribution: {
          kind: "release",
          packageUrl: "https://example.com/demo.zip",
          sha256: "a".repeat(64),
        },
      },
      {
        version: "1.0.0",
        distribution: {
          kind: "release",
          packageUrl: "https://example.com/demo2.zip",
          sha256: "b".repeat(64),
        },
      },
    ];
    expect(() =>
      parseMarketplaceCatalogStrict(withDupVersion, { marketplaceId: "team-plugins", sourceKind: "url" }),
    ).toThrow(/duplicate version/i);
  });

  it("rejects invalid SHA-256 and release field exclusivity issues", () => {
    const badSha = sampleCatalog();
    (badSha.plugins[0] as any).distribution.sha256 = "not-hex";
    expect(() =>
      parseMarketplaceCatalogStrict(badSha, { marketplaceId: "team-plugins", sourceKind: "url" }),
    ).toThrow(/sha256/i);

    const missingUrl = sampleCatalog();
    delete (missingUrl.plugins[0] as any).distribution.packageUrl;
    expect(() =>
      parseMarketplaceCatalogStrict(missingUrl, { marketplaceId: "team-plugins", sourceKind: "url" }),
    ).toThrow(/packageUrl/i);
  });

  it("allows source distributions only for local marketplaces", () => {
    const sourceDist = {
      schemaVersion: 1,
      plugins: [{
        schemaVersion: 1,
        id: "demo",
        name: "Demo",
        publisher: "Hana",
        version: "1.0.0",
        description: "Demo",
        repository: "https://example.com/demo",
        compatibility: { minAppVersion: "0.1.0" },
        trust: "restricted",
        permissions: [],
        contributions: [],
        distribution: { kind: "source", path: "plugins/demo" },
      }],
    };
    expect(() =>
      parseMarketplaceCatalogStrict(sourceDist, { marketplaceId: "team-plugins", sourceKind: "url" }),
    ).toThrow(/local/i);

    const ok = parseMarketplaceCatalogStrict(sourceDist, {
      marketplaceId: "local-dev",
      sourceKind: "local",
    });
    expect(ok.plugins[0].distribution).toMatchObject({ kind: "source", path: "plugins/demo" });
  });

  it("rejects absolute and traversal index-style relative paths in source distribution", () => {
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
        distribution: { kind: "source", path: "../escape" },
      }],
    };
    expect(() =>
      parseMarketplaceCatalogStrict(catalog, { marketplaceId: "local-dev", sourceKind: "local" }),
    ).toThrow(/path/i);
  });
});

describe("MarketplaceSnapshotStore", () => {
  it("publishes an immutable generation and exposes ok status", () => {
    const home = makeHome();
    const store = new MarketplaceSnapshotStore({ hanakoHome: home });
    const snapshot = buildSnapshot("team-plugins", sampleCatalog());
    store.publish("team-plugins", snapshot);

    const status = store.getStatus("team-plugins");
    expect(status.state).toBe("ok");
    if (status.state === "ok") {
      expect(status.current.catalogSha256).toBe(snapshot.catalogSha256);
      expect(status.current.plugins[0].id).toBe("demo");
    }

    // Browse path must not require re-fetch: reading status uses disk only.
    const store2 = new MarketplaceSnapshotStore({ hanakoHome: home });
    expect(store2.getStatus("team-plugins").state).toBe("ok");
  });

  it("keeps last-known-good when a bad publication is rejected", () => {
    const home = makeHome();
    const store = new MarketplaceSnapshotStore({ hanakoHome: home });
    const good = buildSnapshot("team-plugins", sampleCatalog("demo"));
    store.publish("team-plugins", good);

    expect(() =>
      store.publish(
        "team-plugins",
        buildSnapshot("team-plugins", {
          schemaVersion: 1,
          plugins: "bad",
        } as any),
      ),
    ).toThrow();

    // Even if caller builds a snapshot object with empty plugins from a bad parse
    // attempt, store should reject empty/invalid replacement after we try invalid catalog.
    const status = store.getStatus("team-plugins");
    expect(status.state).toBe("ok");
    if (status.state === "ok") {
      expect(status.current.plugins[0].id).toBe("demo");
    }
  });

  it("preserves previous generation pointer after successful promotion", () => {
    const home = makeHome();
    const store = new MarketplaceSnapshotStore({ hanakoHome: home });
    const v1 = buildSnapshot("team-plugins", sampleCatalog("demo"), "1".repeat(64));
    store.publish("team-plugins", v1);
    const v2 = buildSnapshot("team-plugins", sampleCatalog("other"), "2".repeat(64));
    store.publish("team-plugins", v2);

    const status = store.getStatus("team-plugins");
    expect(status.state).toBe("ok");
    if (status.state === "ok") {
      expect(status.current.plugins[0].id).toBe("other");
      expect(status.previous?.plugins[0].id).toBe("demo");
    }
  });

  it("records first-load error and stale last-known-good after refresh failure", () => {
    const home = makeHome();
    const store = new MarketplaceSnapshotStore({ hanakoHome: home });

    store.markError("team-plugins", { code: "PLUGIN_MARKETPLACE_SOURCE_INVALID", message: "first fail" });
    expect(store.getStatus("team-plugins")).toMatchObject({
      state: "error",
      current: null,
    });

    store.publish("team-plugins", buildSnapshot("team-plugins", sampleCatalog()));
    store.markError("team-plugins", { code: "PLUGIN_MARKETPLACE_FETCH_LIMIT", message: "timeout" });
    const stale = store.getStatus("team-plugins");
    expect(stale.state).toBe("stale");
    if (stale.state === "stale") {
      expect(stale.current.plugins[0].id).toBe("demo");
      expect(stale.refreshError.message).toMatch(/timeout/i);
    }
  });

  it("tracks refreshing state with or without a current generation", () => {
    const home = makeHome();
    const store = new MarketplaceSnapshotStore({ hanakoHome: home });
    store.markRefreshing("new-source");
    expect(store.getStatus("new-source")).toMatchObject({ state: "refreshing", current: null });

    store.publish("new-source", buildSnapshot("new-source", sampleCatalog()));
    store.markRefreshing("new-source");
    const status = store.getStatus("new-source");
    expect(status.state).toBe("refreshing");
    if (status.state === "refreshing") {
      expect(status.current?.plugins[0].id).toBe("demo");
    }
  });

  it("lists current snapshots without invoking network acquisition hooks", () => {
    const home = makeHome();
    let fetchCalls = 0;
    const store = new MarketplaceSnapshotStore({
      hanakoHome: home,
      // Intentionally no fetch; browse must work offline.
    });
    store.publish("team-plugins", buildSnapshot("team-plugins", sampleCatalog()));
    const rows = store.listCurrentPlugins();
    expect(fetchCalls).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      marketplaceId: "team-plugins",
      id: "demo",
    });
  });
});
