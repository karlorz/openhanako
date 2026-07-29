import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginArtifactStore } from "../lib/plugin-artifact-store.ts";
import {
  INSTALL_RECORDS_VERSION_V2,
  PluginInstallRecords,
} from "../lib/plugin-install-records.ts";
import { createPluginInstallBackup } from "../lib/plugin-install-backups.ts";

const tempDirs: string[] = [];

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-art-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writePackage(dir: string, content = "pkg") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "demo", content }), "utf8");
  return dir;
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

describe("PluginArtifactStore", () => {
  it("retains official and custom same-ID artifacts simultaneously", () => {
    const home = makeHome();
    const store = new PluginArtifactStore({ hanakoHome: home });
    const srcA = writePackage(path.join(home, "src-a"), "official");
    const srcB = writePackage(path.join(home, "src-b"), "custom");

    const a = store.retain({
      marketplaceId: "oh-plugins-official",
      pluginId: "demo",
      artifactDigest: DIGEST_A,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_A,
      packageDir: srcA,
    });
    const b = store.retain({
      marketplaceId: "team-plugins",
      pluginId: "demo",
      artifactDigest: DIGEST_B,
      version: "1.0.0",
      sourceFingerprint: "3".repeat(64),
      catalogSha256: "4".repeat(64),
      packageSha256: DIGEST_B,
      packageDir: srcB,
    });

    expect(a.artifactPath).not.toBe(b.artifactPath);
    expect(fs.existsSync(path.join(a.artifactPath, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(b.artifactPath, "manifest.json"))).toBe(true);
    expect(store.listRetained("demo")).toHaveLength(2);
  });

  it("retains multiple digests from one marketplace and dedupes by digest", () => {
    const home = makeHome();
    const store = new PluginArtifactStore({ hanakoHome: home });
    const src = writePackage(path.join(home, "pkg"), "v1");

    const first = store.retain({
      marketplaceId: "team-plugins",
      pluginId: "demo",
      artifactDigest: DIGEST_A,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_A,
      packageDir: src,
    });
    const second = store.retain({
      marketplaceId: "team-plugins",
      pluginId: "demo",
      artifactDigest: DIGEST_A,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_A,
      packageDir: src,
    });
    expect(second.artifactPath).toBe(first.artifactPath);

    store.retain({
      marketplaceId: "team-plugins",
      pluginId: "demo",
      artifactDigest: DIGEST_C,
      version: "1.1.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "5".repeat(64),
      packageSha256: DIGEST_C,
      packageDir: writePackage(path.join(home, "pkg2"), "v2"),
    });
    expect(store.listRetained("demo", "team-plugins")).toHaveLength(2);
  });

  it("removes inactive artifacts safely and detects source-in-use", () => {
    const home = makeHome();
    const store = new PluginArtifactStore({ hanakoHome: home });
    store.retain({
      marketplaceId: "team-plugins",
      pluginId: "demo",
      artifactDigest: DIGEST_A,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_A,
      packageDir: writePackage(path.join(home, "pkg"), "a"),
    });
    expect(store.isSourceInUse("team-plugins")).toBe(true);
    expect(store.isSourceInUse("other")).toBe(false);

    store.remove({
      marketplaceId: "team-plugins",
      pluginId: "demo",
      artifactDigest: DIGEST_A,
    });
    expect(store.listRetained("demo")).toHaveLength(0);
    expect(store.isSourceInUse("team-plugins")).toBe(false);
  });
});

describe("PluginInstallRecords v2", () => {
  it("stores active pointer and retained map with full provenance/history", () => {
    const home = makeHome();
    const records = new PluginInstallRecords({ hanakoHome: home });
    const saved = records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "oh-plugins-official",
      artifactDigest: DIGEST_A,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_A,
      packageUrl: "https://example.com/demo.zip",
      artifactPath: "/tmp/artifact",
      action: "install",
      result: "ok",
    });

    expect(saved.activeMarketplaceId).toBe("oh-plugins-official");
    expect(saved.activeArtifactDigest).toBe(DIGEST_A);
    expect(saved.retained["oh-plugins-official"][DIGEST_A].version).toBe("1.0.0");
    expect(saved.history[0]).toMatchObject({
      action: "install",
      result: "ok",
      afterMarketplaceId: "oh-plugins-official",
      afterArtifactDigest: DIGEST_A,
    });

    const switched = records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      artifactDigest: DIGEST_B,
      version: "2.0.0",
      sourceFingerprint: "3".repeat(64),
      catalogSha256: "4".repeat(64),
      packageSha256: DIGEST_B,
      artifactPath: "/tmp/artifact-b",
      action: "source-switch",
      result: "ok",
    });
    expect(switched.activeMarketplaceId).toBe("team-plugins");
    expect(Object.keys(switched.retained)).toEqual(
      expect.arrayContaining(["oh-plugins-official", "team-plugins"]),
    );
    expect(switched.history[0].beforeMarketplaceId).toBe("oh-plugins-official");
    expect(switched.history[0].afterMarketplaceId).toBe("team-plugins");
  });

  it("keeps update/reinstall pinned to active marketplace", () => {
    const home = makeHome();
    const records = new PluginInstallRecords({ hanakoHome: home });
    records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      artifactDigest: DIGEST_A,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_A,
      artifactPath: "/tmp/a",
      action: "install",
      result: "ok",
    });
    const updated = records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      artifactDigest: DIGEST_C,
      version: "1.1.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "5".repeat(64),
      packageSha256: DIGEST_C,
      artifactPath: "/tmp/c",
      action: "update",
      result: "ok",
    });
    expect(updated.activeMarketplaceId).toBe("team-plugins");
    expect(updated.activeArtifactDigest).toBe(DIGEST_C);
    expect(updated.retained["team-plugins"][DIGEST_A]).toBeTruthy();
    expect(updated.retained["team-plugins"][DIGEST_C]).toBeTruthy();
  });

  it("migrates v1 records with trustworthy provenance and isolates ambiguous legacy", () => {
    const home = makeHome();
    const pathRecords = path.join(home, "plugin-installs.json");
    fs.writeFileSync(
      pathRecords,
      JSON.stringify({
        version: 1,
        plugins: {
          demo: {
            pluginId: "demo",
            installedVersion: "1.0.0",
            source: "marketplace",
            marketplaceId: "oh-plugins-official",
            marketplaceSource: { kind: "url", url: "https://example.com" },
            sha256: DIGEST_A,
            packageUrl: "https://example.com/demo.zip",
            installedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            history: [],
          },
          other: {
            pluginId: "other",
            installedVersion: "0.1.0",
            source: "local",
            marketplaceId: null,
            sha256: null,
            installedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            history: [],
          },
        },
      }, null, 2),
      "utf8",
    );

    const records = new PluginInstallRecords({ hanakoHome: home });
    const report = records.migrateToV2();
    expect(report.migrated).toContain("demo");
    expect(report.legacyUnqualified).toContain("other");

    const demo = records.get("demo");
    expect(demo.schemaVersion).toBe(INSTALL_RECORDS_VERSION_V2);
    expect(demo.activeMarketplaceId).toBe("oh-plugins-official");
    expect(demo.activeArtifactDigest).toBe(DIGEST_A);

    const other = records.get("other");
    expect(other.activeMarketplaceId).toBe("legacy-unqualified");
    expect(other.migrationRequired).toBe(true);

    // Idempotent
    const again = records.migrateToV2();
    expect(again.alreadyV2).toBe(true);
  });

  it("creates source-qualified plugin backups", () => {
    const home = makeHome();
    const pluginDir = writePackage(path.join(home, "plugins", "demo"), "live");
    const backup = createPluginInstallBackup({
      hanakoHome: home,
      pluginId: "demo",
      marketplaceId: "team-plugins",
      pluginDir,
      version: "1.0.0",
    });
    expect(backup?.backupDir).toContain(path.join("plugin-backups", "team-plugins", "demo"));
    expect(fs.existsSync(path.join(backup.backupDir, "manifest.json"))).toBe(true);
  });
});
