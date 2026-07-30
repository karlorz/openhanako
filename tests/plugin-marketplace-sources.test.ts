import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OFFICIAL_MARKETPLACE_ID,
  PluginMarketplaceSourceRegistry,
  createCompiledOfficialMarketplaceSource,
} from "../lib/plugin-marketplace-sources.ts";
import { buildSourceFingerprint } from "../lib/plugin-marketplace-identity.ts";

const tempDirs: string[] = [];

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mkt-src-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function registryPath(home: string) {
  return path.join(home, "plugin-marketplaces.json");
}

function writeRegistry(home: string, value: unknown) {
  fs.writeFileSync(registryPath(home), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("compiled official marketplace source", () => {
  it("is always synthesized with reserved id and official authority", () => {
    const official = createCompiledOfficialMarketplaceSource();
    expect(official).toMatchObject({
      id: OFFICIAL_MARKETPLACE_ID,
      kind: "url",
      authority: "official",
      mutable: false,
    });
    expect(official.kind).toBe("url");
    if (official.kind === "url") {
      expect(official.url).toMatch(/^https:\/\//);
      expect(official.sourceFingerprint).toBe(
        buildSourceFingerprint({
          kind: "url",
          id: OFFICIAL_MARKETPLACE_ID,
          url: official.url,
        }),
      );
    }
  });
});

describe("PluginMarketplaceSourceRegistry", () => {
  it("loads missing registry as empty custom sources with official prepended", () => {
    const home = makeHome();
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    const loaded = registry.loadEffectiveSources();
    expect(loaded.degraded).toBe(false);
    expect(loaded.sources).toHaveLength(1);
    expect(loaded.sources[0].id).toBe(OFFICIAL_MARKETPLACE_ID);
    expect(loaded.sources[0].authority).toBe("official");
    expect(registry.getRevision()).toBe(0);
    expect(fs.existsSync(registryPath(home))).toBe(false);
  });

  it("adds and removes custom sources with monotonic revision", () => {
    const home = makeHome();
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });

    const added = registry.addSource({
      id: "team-plugins",
      name: "Team Plugins",
      kind: "url",
      url: "https://example.com/marketplace.json",
    });
    expect(added.revision).toBe(1);
    expect(added.source).toMatchObject({
      id: "team-plugins",
      authority: "custom",
      mutable: true,
      kind: "url",
    });

    const listed = registry.listSources();
    expect(listed.map((s) => s.id)).toEqual([OFFICIAL_MARKETPLACE_ID, "team-plugins"]);
    expect(listed.find((s) => s.id === "team-plugins")?.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const removed = registry.removeSource("team-plugins");
    expect(removed.revision).toBe(2);
    expect(registry.listSources().map((s) => s.id)).toEqual([OFFICIAL_MARKETPLACE_ID]);
  });

  it("rejects reserved official id from durable registry and API mutations", () => {
    const home = makeHome();
    writeRegistry(home, {
      schemaVersion: 1,
      revision: 1,
      sources: [{
        id: OFFICIAL_MARKETPLACE_ID,
        name: "Fake Official",
        kind: "url",
        url: "https://evil.example/marketplace.json",
      }],
    });
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    const loaded = registry.loadEffectiveSources();
    expect(loaded.degraded).toBe(true);
    expect(loaded.sources.every((s) => s.authority === "official")).toBe(true);
    expect(loaded.sources.some((s) => s.kind === "url" && s.url.includes("evil.example"))).toBe(false);

    const cleanHome = makeHome();
    const clean = new PluginMarketplaceSourceRegistry({ hanakoHome: cleanHome });
    expect(() =>
      clean.addSource({
        id: OFFICIAL_MARKETPLACE_ID,
        name: "Nope",
        kind: "url",
        url: "https://example.com/marketplace.json",
      }),
    ).toThrow(/reserved|official/i);
  });

  it("rejects duplicate custom ids and refuses to rebind an existing id", () => {
    const home = makeHome();
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    registry.addSource({
      id: "team-plugins",
      name: "Team Plugins",
      kind: "url",
      url: "https://example.com/marketplace.json",
    });
    expect(() =>
      registry.addSource({
        id: "team-plugins",
        name: "Team Plugins 2",
        kind: "url",
        url: "https://example.com/other.json",
      }),
    ).toThrow(/already exists|duplicate|immutable/i);
  });

  it("rejects malformed registry without overwriting defaults and fail-closes mutations", () => {
    const home = makeHome();
    fs.writeFileSync(registryPath(home), "{ not json", "utf8");
    const before = fs.readFileSync(registryPath(home), "utf8");

    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    const loaded = registry.loadEffectiveSources();
    expect(loaded.degraded).toBe(true);
    expect(loaded.sources).toHaveLength(1);
    expect(loaded.sources[0].authority).toBe("official");
    expect(fs.readFileSync(registryPath(home), "utf8")).toBe(before);

    expect(() =>
      registry.addSource({
        id: "team-plugins",
        name: "Team",
        kind: "url",
        url: "https://example.com/marketplace.json",
      }),
    ).toThrow(/degraded|invalid registry|malformed/i);
    expect(fs.readFileSync(registryPath(home), "utf8")).toBe(before);
  });

  it("rejects structural schema violations as malformed", () => {
    const home = makeHome();
    writeRegistry(home, {
      schemaVersion: 99,
      revision: 1,
      sources: [],
    });
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    expect(registry.loadEffectiveSources().degraded).toBe(true);
    expect(() => registry.removeSource("anything")).toThrow(/degraded|invalid registry|malformed/i);
  });

  it("enforces expectedRevision optimistic concurrency", () => {
    const home = makeHome();
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    registry.addSource({
      id: "team-plugins",
      name: "Team",
      kind: "url",
      url: "https://example.com/marketplace.json",
    });
    expect(() =>
      registry.addSource(
        {
          id: "other",
          name: "Other",
          kind: "url",
          url: "https://example.com/other.json",
        },
        { expectedRevision: 0 },
      ),
    ).toThrow(/revision/i);
  });

  it("enforces expectedDigest optimistic concurrency", () => {
    const home = makeHome();
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    const digest = registry.getStatus().digest;
    registry.addSource(
      {
        id: "team-plugins",
        name: "Team",
        kind: "url",
        url: "https://example.com/marketplace.json",
      },
      { expectedDigest: digest },
    );
    expect(() =>
      registry.addSource(
        {
          id: "other",
          name: "Other",
          kind: "url",
          url: "https://example.com/other.json",
        },
        { expectedDigest: digest },
      ),
    ).toThrow(/digest conflict/i);
  });

  it("keeps last-known-good effective sources during malformed direct edits and recovers after repair", () => {
    const home = makeHome();
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    registry.addSource({
      id: "team-plugins",
      name: "Team",
      kind: "url",
      url: "https://example.com/marketplace.json",
    });
    const before = registry.getStatus();
    expect(before.degraded).toBe(false);

    fs.writeFileSync(registryPath(home), "{ not json", "utf8");
    const degraded = registry.loadEffectiveSources();
    expect(degraded.degraded).toBe(true);
    expect(degraded.sources.map((s) => s.id)).toContain("team-plugins");
    expect(registry.getStatus()).toMatchObject({
      degraded: true,
      lastKnownGood: true,
      revision: 1,
      digest: before.digest,
    });
    expect(() =>
      registry.addSource({
        id: "blocked",
        name: "Blocked",
        kind: "url",
        url: "https://example.com/blocked.json",
      }),
    ).toThrow(/degraded|malformed/i);

    writeRegistry(home, {
      schemaVersion: 1,
      revision: 2,
      sources: [{
        id: "fixed",
        name: "Fixed",
        kind: "url",
        url: "https://example.com/fixed.json",
      }],
    });
    expect(registry.loadEffectiveSources()).toMatchObject({
      degraded: false,
      sources: expect.arrayContaining([expect.objectContaining({ id: "fixed" })]),
    });
    expect(registry.getStatus()).toMatchObject({
      degraded: false,
      lastKnownGood: false,
      revision: 2,
    });
  });

  it("loads schemaVersion 2 control-plane records without rewriting and rejects bare activation keys", () => {
    const home = makeHome();
    writeRegistry(home, {
      schemaVersion: 2,
      revision: 7,
      sources: [{
        id: "team-plugins",
        name: "Team",
        kind: "git",
        gitUrl: "https://github.com/example/team-plugins.git",
      }],
      activations: {
        runtimePlugins: {
          "demo@team-plugins": { enabled: false },
        },
        marketplaceSkills: {
          "review@team-plugins/review-pack": { enabled: true },
        },
      },
      claudeCompatibility: {
        bindings: [],
      },
    });
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    expect(registry.getStatus()).toMatchObject({
      schemaVersion: 2,
      effectiveSchemaVersion: 2,
      revision: 7,
      degraded: false,
    });
    expect(registry.listSources().map((s) => s.id)).toContain("team-plugins");
    expect(JSON.parse(fs.readFileSync(registryPath(home), "utf8")).schemaVersion).toBe(2);

    const invalidHome = makeHome();
    writeRegistry(invalidHome, {
      schemaVersion: 2,
      revision: 1,
      sources: [],
      activations: {
        runtimePlugins: {
          demo: { enabled: true },
        },
      },
    });
    const invalid = new PluginMarketplaceSourceRegistry({ hanakoHome: invalidHome });
    expect(invalid.loadEffectiveSources().degraded).toBe(true);
    expect(invalid.getStatus().diagnostic).toMatch(/source-qualified/i);
  });

  it("blocks remove while source-in-use callback reports references", () => {
    const home = makeHome();
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    registry.addSource({
      id: "team-plugins",
      name: "Team",
      kind: "url",
      url: "https://example.com/marketplace.json",
    });
    expect(() =>
      registry.removeSource("team-plugins", {
        isSourceInUse: () => true,
      }),
    ).toThrow(/in use|PLUGIN_MARKETPLACE_SOURCE_IN_USE/i);
    expect(registry.listSources().some((s) => s.id === "team-plugins")).toBe(true);
  });

  it("rejects removing official and unknown sources", () => {
    const home = makeHome();
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    expect(() => registry.removeSource(OFFICIAL_MARKETPLACE_ID)).toThrow(/official|reserved|immutable/i);
    expect(() => registry.removeSource("missing")).toThrow(/not found/i);
  });

  it("overlays legacy env path/url as read-only non-official source", () => {
    const home = makeHome();
    const legacyFile = path.join(home, "legacy-marketplace.json");
    fs.writeFileSync(legacyFile, JSON.stringify({ schemaVersion: 1, plugins: [] }), "utf8");

    const registry = new PluginMarketplaceSourceRegistry({
      hanakoHome: home,
      legacyOverlay: { kind: "local", path: legacyFile },
    });
    const sources = registry.listSources();
    expect(sources.map((s) => s.authority)).toEqual(["official", "legacy"]);
    const legacy = sources.find((s) => s.authority === "legacy");
    expect(legacy?.mutable).toBe(false);
    expect(legacy?.kind).toBe("local");
    expect((legacy as any).path).toBe(legacyFile);
    expect(legacy?.id).not.toBe(OFFICIAL_MARKETPLACE_ID);
  });

  it("does not allow API to grant official authority via durable fields", () => {
    const home = makeHome();
    writeRegistry(home, {
      schemaVersion: 1,
      revision: 1,
      sources: [{
        id: "team-plugins",
        name: "Team",
        kind: "url",
        url: "https://example.com/marketplace.json",
        authority: "official",
        mutable: false,
        official: true,
      }],
    });
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    const team = registry.listSources().find((s) => s.id === "team-plugins");
    expect(team?.authority).toBe("custom");
    expect(team?.mutable).toBe(true);
  });

  it("serializes concurrent mutations via an in-process lock", async () => {
    const home = makeHome();
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        Promise.resolve().then(() =>
          registry.addSource({
            id: `src-${i}`,
            name: `Source ${i}`,
            kind: "url",
            url: `https://example.com/${i}.json`,
          }),
        ),
      ),
    );
    const revisions = results.map((r) => r.revision).sort((a, b) => a - b);
    expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(registry.listSources().filter((s) => s.authority === "custom")).toHaveLength(8);
  });

  it("writes via unique temp + rename using injectable filesystem seams", () => {
    const home = makeHome();
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    const realFs = {
      existsSync: fs.existsSync.bind(fs),
      mkdirSync: fs.mkdirSync.bind(fs),
      readFileSync: fs.readFileSync.bind(fs),
      writeFileSync: (filePath: string, data: string | Buffer, encoding?: any) => {
        writes.push(String(filePath));
        return fs.writeFileSync(filePath, data, encoding);
      },
      renameSync: (from: string, to: string) => {
        renames.push([from, to]);
        return fs.renameSync(from, to);
      },
      unlinkSync: fs.unlinkSync.bind(fs),
      fsyncSync: (fd: number) => fs.fsyncSync(fd),
      openSync: fs.openSync.bind(fs),
      closeSync: fs.closeSync.bind(fs),
    };

    const registry = new PluginMarketplaceSourceRegistry({
      hanakoHome: home,
      fsOps: realFs,
    });
    registry.addSource({
      id: "team-plugins",
      name: "Team",
      kind: "url",
      url: "https://example.com/marketplace.json",
    });

    expect(writes.some((p) => p.includes("plugin-marketplaces.json.") && p.includes(".tmp"))).toBe(true);
    expect(renames.some(([from, to]) => from.includes(".tmp") && to === registryPath(home))).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(registryPath(home), "utf8"));
    expect(onDisk).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      sources: [{ id: "team-plugins", kind: "url" }],
    });
    expect(onDisk.sources[0].authority).toBeUndefined();
  });

  it("sanitizes listings for remote consumers (no internal write path)", () => {
    const home = makeHome();
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    registry.addSource({
      id: "team-plugins",
      name: "Team",
      kind: "git",
      gitUrl: "https://github.com/example/team-plugins.git",
      gitRef: "refs/heads/main",
    });
    const listed = registry.listSources({ forRemote: true });
    const custom = listed.find((s) => s.id === "team-plugins");
    expect(custom).toMatchObject({
      id: "team-plugins",
      kind: "git",
      gitUrl: "https://github.com/example/team-plugins.git",
      authority: "custom",
    });
    expect(JSON.stringify(custom)).not.toContain(home);
    expect((custom as any).cachePath).toBeUndefined();
  });
});
