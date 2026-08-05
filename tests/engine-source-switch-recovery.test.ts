import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HanaEngine } from "../core/engine.ts";
import { PluginInstallRecords } from "../lib/plugin-install-records.ts";
import { PluginArtifactStore } from "../lib/plugin-artifact-store.ts";
import { PluginSourceSwitchCoordinator } from "../lib/plugin-source-switch.ts";

const root = process.cwd();

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});
function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-switch-recovery-"));
  tempDirs.push(dir);
  return dir;
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const MARKET_A = "oh-plugins-official";
const MARKET_B = "team-plugins";

function seedArtifact(store: PluginArtifactStore, home: string, market: string, digest: string, label: string) {
  const pkg = path.join(home, `pkg-${market}-${digest.slice(0, 4)}`);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "manifest.json"), JSON.stringify({ id: "demo", label }), "utf8");
  return store.retain({
    marketplaceId: market,
    pluginId: "demo",
    artifactDigest: digest,
    version: label === "A" ? "1.0.0" : "2.0.0",
    sourceFingerprint: "1".repeat(64),
    catalogSha256: "2".repeat(64),
    packageSha256: digest,
    packageDir: pkg,
  });
}

/**
 * Crash-state harness: marketplace A committed active + retained, B retained as
 * candidate, a journal written at phase "activating-candidate" pointing previous
 * to A / candidate to B, and B staged as the active projection to mirror the
 * on-disk state left by a crash between staging and commit.
 */
function makeCrashState(home: string) {
  const pluginsDir = path.join(home, "plugins");
  const artifacts = new PluginArtifactStore({ hanakoHome: home });
  const records = new PluginInstallRecords({ hanakoHome: home });
  const artA = seedArtifact(artifacts, home, MARKET_A, DIGEST_A, "A");
  const artB = seedArtifact(artifacts, home, MARKET_B, DIGEST_B, "B");
  for (const [marketplaceId, artifactDigest, artifactPath] of [
    [MARKET_A, DIGEST_A, artA.artifactPath],
    [MARKET_B, DIGEST_B, artB.artifactPath],
  ] as const) {
    records.retainAndActivate({
      pluginId: "demo",
      marketplaceId,
      artifactDigest,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: artifactDigest,
      artifactPath,
      action: "install",
      result: "ok",
    });
  }
  // Reactivate A as the committed active source (B stays retained as candidate).
  records.retainAndActivate({
    pluginId: "demo",
    marketplaceId: MARKET_A,
    artifactDigest: DIGEST_A,
    version: "1.0.0",
    sourceFingerprint: "1".repeat(64),
    catalogSha256: "2".repeat(64),
    packageSha256: DIGEST_A,
    artifactPath: artA.artifactPath,
    action: "install",
    result: "ok",
  });
  // Crash mid-switch: candidate B already staged as the active projection.
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.cpSync(artB.artifactPath, path.join(pluginsDir, "demo"), { recursive: true });
  records.setTransaction("demo", {
    transactionId: "tx-crash",
    pluginId: "demo",
    phase: "activating-candidate",
    previous: { marketplaceId: MARKET_A, pluginId: "demo", artifactDigest: DIGEST_A },
    candidate: { marketplaceId: MARKET_B, pluginId: "demo", artifactDigest: DIGEST_B },
    startedAt: new Date().toISOString(),
  });
  return { pluginsDir, records, artifacts, artA, artB };
}

function makeCoordinator(records: PluginInstallRecords, artifacts: PluginArtifactStore, pluginsDir: string) {
  return new PluginSourceSwitchCoordinator({
    records,
    artifacts,
    pluginsDir,
    runtime: {
      async unloadActive() {},
      async activateCandidate() {},
      async restorePrevious() {},
    },
  });
}

describe("boot-time source-switch journal recovery (finding 6)", () => {
  it("restores the previous committed projection when a crash leaves a journal mid-switch", async () => {
    const home = tempHome();
    const { pluginsDir, records, artifacts } = makeCrashState(home);

    // Fresh coordinator (as a fresh boot would construct): no in-memory state,
    // recovery must be driven purely by the journal on disk.
    const coordinator = makeCoordinator(records, artifacts, pluginsDir);
    const outcome = await coordinator.recoverIncompleteTransactions();

    expect(outcome.recovered).toContain("demo");
    expect(outcome.failed).toEqual([]);
    const marker = JSON.parse(
      fs.readFileSync(path.join(pluginsDir, "demo", ".hana-marketplace.json"), "utf8"),
    );
    expect(marker.marketplaceId).toBe(MARKET_A); // last committed source
    expect(records.get("demo")?.transaction).toBeNull();
    expect(records.get("demo")?.activeMarketplaceId).toBe(MARKET_A);
    const live = JSON.parse(fs.readFileSync(path.join(pluginsDir, "demo", "manifest.json"), "utf8"));
    expect(live.label).toBe("A");
  });

  it("keeps the journal and reports a diagnostic when rollback fails (fail closed)", async () => {
    const home = tempHome();
    const { pluginsDir, records, artifacts, artA } = makeCrashState(home);
    // A second plugin with a recoverable journal: its recovery must proceed even
    // when the first plugin's rollback fails (failures are isolated per plugin).
    const artOther = seedArtifact(artifacts, home, MARKET_A, DIGEST_B, "Other");
    records.retainAndActivate({
      pluginId: "other-plugin",
      marketplaceId: MARKET_A,
      artifactDigest: DIGEST_B,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_B,
      artifactPath: artOther.artifactPath,
      action: "install",
      result: "ok",
    });
    fs.cpSync(artOther.artifactPath, path.join(pluginsDir, "other-plugin"), { recursive: true });
    records.setTransaction("other-plugin", {
      transactionId: "tx-crash-2",
      pluginId: "other-plugin",
      phase: "activating-candidate",
      previous: { marketplaceId: MARKET_A, pluginId: "other-plugin", artifactDigest: DIGEST_B },
      candidate: { marketplaceId: MARKET_B, pluginId: "other-plugin", artifactDigest: DIGEST_A },
      startedAt: new Date().toISOString(),
    });
    // Simulate a lost retained artifact: the previous committed source is gone
    // from the artifact store, so rollback cannot restore it.
    fs.rmSync(artA.artifactPath, { recursive: true, force: true });

    const coordinator = makeCoordinator(records, artifacts, pluginsDir);
    const outcome = await coordinator.recoverIncompleteTransactions();

    expect(outcome.recovered).toEqual(["other-plugin"]);
    expect(outcome.failed).toEqual([
      { pluginId: "demo", error: expect.stringContaining("PLUGIN_SOURCE_SWITCH_ROLLBACK_FAILED") },
    ]);
    // Fail closed: the journal survives for a later boot retry...
    expect(records.get("demo")?.transaction?.phase).toBe("activating-candidate");
    // ...while the other plugin's journal was cleared by a successful recovery.
    expect(records.get("other-plugin")?.transaction).toBeNull();
    // ...and the on-disk projection is left untouched (candidate still staged).
    const live = JSON.parse(fs.readFileSync(path.join(pluginsDir, "demo", "manifest.json"), "utf8"));
    expect(live.label).toBe("B");
  });
});

describe("HanaEngine.recoverIncompleteSourceSwitches", () => {
  it("delegates to the coordinator path and restores the committed projection from a seeded journal", async () => {
    const home = tempHome();
    const engine = new HanaEngine({ hanakoHome: home, productDir: home, agentId: "hana" } as any);
    try {
      const { pluginsDir } = makeCrashState(home);

      const outcome = await engine.recoverIncompleteSourceSwitches();

      expect(outcome.recovered).toContain("demo");
      expect(outcome.failed).toEqual([]);
      const marker = JSON.parse(
        fs.readFileSync(path.join(pluginsDir, "demo", ".hana-marketplace.json"), "utf8"),
      );
      expect(marker.marketplaceId).toBe(MARKET_A); // last committed source
    } finally {
      await engine.dispose();
    }
  });

  it("returns an empty outcome when there is no journal to recover", async () => {
    const home = tempHome();
    const engine = new HanaEngine({ hanakoHome: home, productDir: home, agentId: "hana" } as any);
    try {
      const outcome = await engine.recoverIncompleteSourceSwitches();
      expect(outcome).toEqual({ recovered: [], failed: [] });
    } finally {
      await engine.dispose();
    }
  });
});

describe("boot ordering (finding 6)", () => {
  it("invokes journal recovery before the community plugin scan inside initPlugins", () => {
    // A full initPlugins() boot needs a live EventBus, product plugins, and
    // preference stores; the smallest existing seam in this repo for boot
    // sequencing guarantees is the source-ordering probe used by
    // tests/server-port-ownership.test.ts.
    const source = fs.readFileSync(path.join(root, "core", "engine.ts"), "utf8");
    const initStart = source.indexOf("async initPlugins(");
    expect(initStart).toBeGreaterThan(-1);
    const recoveryIndex = source.indexOf("await this.recoverIncompleteSourceSwitches();", initStart);
    const scanIndex = source.indexOf("this._pluginManager.scan();", initStart);
    expect(recoveryIndex).toBeGreaterThan(-1);
    expect(scanIndex).toBeGreaterThan(-1);
    expect(recoveryIndex).toBeLessThan(scanIndex);
  });
});
