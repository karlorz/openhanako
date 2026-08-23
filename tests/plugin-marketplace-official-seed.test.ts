import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginMarketplaceService } from "../lib/plugin-marketplace-service.ts";
import { parseMarketplaceCatalogStrict } from "../lib/plugin-marketplace-schema.ts";
import { sanitizeAcquisitionError } from "../lib/plugin-marketplace-network-policy.ts";
import { OFFICIAL_MARKETPLACE_ID } from "../lib/plugin-marketplace-sources.ts";
import { HanaEngine } from "../core/engine.ts";

const tempDirs: string[] = [];
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-official-mkt-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

const OH_SHAPED = {
  schemaVersion: 1,
  plugins: [{
    schemaVersion: 1,
    id: "hanako-hyperframes",
    name: "HyperFrames Adapter for Hanako",
    publisher: "OpenHanako",
    author: "liliMozi",
    version: "0.3.0",
    description: "Embed HyperFrames Studio",
    license: "Apache-2.0",
    categories: ["Design"],
    keywords: ["hyperframes"],
    homepage: "https://example.com",
    repository: "https://example.com/repo",
    readmePath: "README.md",
    source: "https://example.com/src",
    compatibility: {},
    trust: "restricted",
    permissions: [],
    contributions: [],
    distribution: {
      kind: "release",
      packageUrl: "https://example.com/p.zip",
      sha256: "a".repeat(64),
    },
    install: {},
  }],
};

describe("OH-Plugins official catalog compatibility", () => {
  it("parses official-shaped catalog with author and source fields", () => {
    const parsed = parseMarketplaceCatalogStrict(OH_SHAPED, {
      marketplaceId: "oh-plugins-official",
      sourceKind: "url",
    });
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0].id).toBe("hanako-hyperframes");
    expect(parsed.plugins[0].publisher).toBe("OpenHanako");
  });

  it("maps author to publisher when publisher missing", () => {
    const raw = {
      schemaVersion: 1,
      plugins: [{
        schemaVersion: 1,
        id: "demo",
        name: "Demo",
        author: "karl",
        version: "1.0.0",
        description: "x",
        repository: "https://example.com/r",
        compatibility: {},
        trust: "restricted",
        permissions: [],
        contributions: [],
        distribution: {
          kind: "release",
          packageUrl: "https://example.com/d.zip",
          sha256: "b".repeat(64),
        },
      }],
    };
    const parsed = parseMarketplaceCatalogStrict(raw, {
      marketplaceId: "team",
      sourceKind: "url",
    });
    expect(parsed.plugins[0].publisher).toBe("karl");
  });

  it("sanitizeAcquisitionError reads plain {message,code} objects", () => {
    const s = sanitizeAcquisitionError({
      message: "Unknown field in plugin: author",
      code: "PLUGIN_MARKETPLACE_SOURCE_INVALID",
    });
    expect(s.message).toBe("Unknown field in plugin: author");
    expect(s.code).toBe("PLUGIN_MARKETPLACE_SOURCE_INVALID");
  });

  it("seeds official snapshot from fetchImpl when missing", async () => {
    const home = makeHome();
    const svc = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: {
        fetchImpl: async () => new Response(JSON.stringify(OH_SHAPED), { status: 200 }),
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    });
    const before = svc.listSources()[0];
    expect(before.status === "error" || before.status === "ok").toBe(true);
    await svc.ensureOfficialSnapshotSeededAsync();
    const after = svc.listSources()[0];
    expect(after.status).toBe("ok");
    expect(svc.listCatalogRows().plugins.some((p) => p.pluginId === "hanako-hyperframes")).toBe(true);
  });

  it("recovers a persisted refreshing marker instead of remaining stuck after restart", async () => {
    const home = makeHome();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(OH_SHAPED), { status: 200 }));
    const svc = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: {
        fetchImpl,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    });
    svc.snapshots.markRefreshing(OFFICIAL_MARKETPLACE_ID);

    const status = await svc.ensureOfficialSnapshotSeededAsync();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(status.state).toBe("ok");
  });

  it("keeps boot seeding non-fatal when the official source is offline", async () => {
    const home = makeHome();
    const svc = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: {
        fetchImpl: vi.fn(async () => { throw new Error("offline"); }),
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    });

    await expect(svc.ensureOfficialSnapshotSeededAsync()).resolves.toMatchObject({ state: "error" });
  });

  it("starts the coalesced official seed from the engine boot hook without awaiting it", async () => {
    const seed = vi.fn().mockRejectedValue(new Error("offline"));
    const engine: any = Object.create(HanaEngine.prototype);
    engine._ensurePluginMarketplaceService = () => ({ ensureOfficialSnapshotSeededAsync: seed });

    expect(() => engine._seedOfficialMarketplaceSnapshotAtBoot()).not.toThrow();
    expect(seed).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
