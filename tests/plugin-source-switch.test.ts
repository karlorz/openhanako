import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginArtifactStore } from "../lib/plugin-artifact-store.ts";
import { PluginInstallRecords } from "../lib/plugin-install-records.ts";
import {
  PluginSourceSwitchCoordinator,
  createInProcessQuiesceHandle,
  type SwitchRuntimeHooks,
} from "../lib/plugin-source-switch.ts";

const tempDirs: string[] = [];
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-switch-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

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
 * Shared harness: seeds artifacts A and B (A committed active, B retained),
 * and returns a coordinator wired to them plus the backing stores/dirs.
 */
function makeCoordinator(runtime: Partial<SwitchRuntimeHooks> = {}): {
  coordinator: PluginSourceSwitchCoordinator;
  records: PluginInstallRecords;
  artifacts: PluginArtifactStore;
  pluginsDir: string;
  artA: ReturnType<typeof seedArtifact>;
  artB: ReturnType<typeof seedArtifact>;
} {
  const home = makeHome();
  const pluginsDir = path.join(home, "plugins");
  const artifacts = new PluginArtifactStore({ hanakoHome: home });
  const records = new PluginInstallRecords({ hanakoHome: home });
  const artA = seedArtifact(artifacts, home, "oh-plugins-official", DIGEST_A, "A");
  const artB = seedArtifact(artifacts, home, "team-plugins", DIGEST_B, "B");
  for (const [marketplaceId, artifactDigest, artifactPath] of [
    ["oh-plugins-official", DIGEST_A, artA.artifactPath],
    ["team-plugins", DIGEST_B, artB.artifactPath],
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
    marketplaceId: "oh-plugins-official",
    artifactDigest: DIGEST_A,
    version: "1.0.0",
    sourceFingerprint: "1".repeat(64),
    catalogSha256: "2".repeat(64),
    packageSha256: DIGEST_A,
    artifactPath: artA.artifactPath,
    action: "install",
    result: "ok",
  });
  const coordinator = new PluginSourceSwitchCoordinator({
    records,
    artifacts,
    pluginsDir,
    runtime: {
      async unloadActive() {},
      async activateCandidate() {},
      ...runtime,
    },
  });
  return { coordinator, records, artifacts, pluginsDir, artA, artB };
}

describe("PluginSourceSwitchCoordinator", () => {
  it("switches A -> B transactionally and keeps A retained", async () => {
    const home = makeHome();
    const pluginsDir = path.join(home, "plugins");
    const artifacts = new PluginArtifactStore({ hanakoHome: home });
    const records = new PluginInstallRecords({ hanakoHome: home });
    const artA = seedArtifact(artifacts, home, "oh-plugins-official", DIGEST_A, "A");
    const artB = seedArtifact(artifacts, home, "team-plugins", DIGEST_B, "B");

    records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "oh-plugins-official",
      artifactDigest: DIGEST_A,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_A,
      artifactPath: artA.artifactPath,
      action: "install",
      result: "ok",
    });
    // Also retain B without activating
    records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      artifactDigest: DIGEST_B,
      version: "2.0.0",
      sourceFingerprint: "3".repeat(64),
      catalogSha256: "4".repeat(64),
      packageSha256: DIGEST_B,
      artifactPath: artB.artifactPath,
      action: "retain",
      result: "ok",
    });
    // Reactivate A as committed active
    records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "oh-plugins-official",
      artifactDigest: DIGEST_A,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_A,
      artifactPath: artA.artifactPath,
      action: "install",
      result: "ok",
    });

    const activated: string[] = [];
    const coordinator = new PluginSourceSwitchCoordinator({
      records,
      artifacts,
      pluginsDir,
      runtime: {
        async unloadActive() { activated.push("unload"); },
        async activateCandidate(input) { activated.push(`activate:${input.marketplaceId}`); },
        async healthCheck() { return true; },
      },
    });

    const result = await coordinator.switchSource({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      artifactDigest: DIGEST_B,
    });
    expect(result.ok).toBe(true);
    expect(result.activeMarketplaceId).toBe("team-plugins");
    expect(records.get("demo")?.retained["oh-plugins-official"][DIGEST_A]).toBeTruthy();
    expect(fs.existsSync(path.join(pluginsDir, "demo", "manifest.json"))).toBe(true);
    const live = JSON.parse(fs.readFileSync(path.join(pluginsDir, "demo", "manifest.json"), "utf8"));
    expect(live.label).toBe("B");
    expect(activated).toContain("activate:team-plugins");
  });

  it("rolls back when health check fails", async () => {
    const home = makeHome();
    const pluginsDir = path.join(home, "plugins");
    const artifacts = new PluginArtifactStore({ hanakoHome: home });
    const records = new PluginInstallRecords({ hanakoHome: home });
    const artA = seedArtifact(artifacts, home, "oh-plugins-official", DIGEST_A, "A");
    const artB = seedArtifact(artifacts, home, "team-plugins", DIGEST_B, "B");
    records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "oh-plugins-official",
      artifactDigest: DIGEST_A,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_A,
      artifactPath: artA.artifactPath,
      action: "install",
      result: "ok",
    });
    // seed B retained via artifact store only + record map
    records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      artifactDigest: DIGEST_B,
      version: "2.0.0",
      sourceFingerprint: "3".repeat(64),
      catalogSha256: "4".repeat(64),
      packageSha256: DIGEST_B,
      artifactPath: artB.artifactPath,
      action: "retain",
      result: "ok",
    });
    records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "oh-plugins-official",
      artifactDigest: DIGEST_A,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_A,
      artifactPath: artA.artifactPath,
      action: "install",
      result: "ok",
    });

    // Pre-stage A active
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.cpSync(artA.artifactPath, path.join(pluginsDir, "demo"), { recursive: true });

    const coordinator = new PluginSourceSwitchCoordinator({
      records,
      artifacts,
      pluginsDir,
      runtime: {
        async unloadActive() {},
        async activateCandidate() {},
        async healthCheck() { return false; },
        async restorePrevious() {},
      },
    });

    const result = await coordinator.switchSource({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      artifactDigest: DIGEST_B,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PLUGIN_SOURCE_SWITCH_HEALTH_FAILED");
    expect(records.get("demo")?.activeMarketplaceId).toBe("oh-plugins-official");
    expect(records.get("demo")?.transaction).toBeNull();
  });

  it("rejects concurrent switches for the same pluginId", async () => {
    const home = makeHome();
    const pluginsDir = path.join(home, "plugins");
    const artifacts = new PluginArtifactStore({ hanakoHome: home });
    const records = new PluginInstallRecords({ hanakoHome: home });
    const artA = seedArtifact(artifacts, home, "oh-plugins-official", DIGEST_A, "A");
    const artB = seedArtifact(artifacts, home, "team-plugins", DIGEST_B, "B");
    for (const [market, digest, pathArt] of [
      ["oh-plugins-official", DIGEST_A, artA.artifactPath],
      ["team-plugins", DIGEST_B, artB.artifactPath],
    ] as const) {
      records.retainAndActivate({
        pluginId: "demo",
        marketplaceId: market,
        artifactDigest: digest,
        version: "1.0.0",
        sourceFingerprint: "1".repeat(64),
        catalogSha256: "2".repeat(64),
        packageSha256: digest,
        artifactPath: pathArt,
        action: "install",
        result: "ok",
      });
    }
    records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "oh-plugins-official",
      artifactDigest: DIGEST_A,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_A,
      artifactPath: artA.artifactPath,
      action: "install",
      result: "ok",
    });

    let releaseHealth!: () => void;
    const healthGate = new Promise<void>((resolve) => { releaseHealth = resolve; });
    const quiesce = createInProcessQuiesceHandle();
    const coordinator = new PluginSourceSwitchCoordinator({
      records,
      artifacts,
      pluginsDir,
      quiesce,
      runtime: {
        async unloadActive() {},
        async activateCandidate() {},
        async healthCheck() {
          await healthGate;
          return true;
        },
      },
    });

    const first = coordinator.switchSource({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      artifactDigest: DIGEST_B,
    });
    // Allow first to acquire lock
    await new Promise((r) => setTimeout(r, 20));
    const second = await coordinator.switchSource({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      artifactDigest: DIGEST_B,
    });
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe("PLUGIN_SOURCE_SWITCH_IN_PROGRESS");
    releaseHealth();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  it("recovers incomplete journals to last committed pointer", async () => {
    const home = makeHome();
    const pluginsDir = path.join(home, "plugins");
    const artifacts = new PluginArtifactStore({ hanakoHome: home });
    const records = new PluginInstallRecords({ hanakoHome: home });
    const artA = seedArtifact(artifacts, home, "oh-plugins-official", DIGEST_A, "A");
    seedArtifact(artifacts, home, "team-plugins", DIGEST_B, "B");
    records.retainAndActivate({
      pluginId: "demo",
      marketplaceId: "oh-plugins-official",
      artifactDigest: DIGEST_A,
      version: "1.0.0",
      sourceFingerprint: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      packageSha256: DIGEST_A,
      artifactPath: artA.artifactPath,
      action: "install",
      result: "ok",
    });
    records.setTransaction("demo", {
      transactionId: "tx-1",
      pluginId: "demo",
      phase: "activating-candidate",
      previous: {
        marketplaceId: "oh-plugins-official",
        pluginId: "demo",
        artifactDigest: DIGEST_A,
      },
      candidate: {
        marketplaceId: "team-plugins",
        pluginId: "demo",
        artifactDigest: DIGEST_B,
      },
      startedAt: new Date().toISOString(),
    });

    const coordinator = new PluginSourceSwitchCoordinator({
      records,
      artifacts,
      pluginsDir,
      runtime: {
        async unloadActive() {},
        async activateCandidate() {},
        async restorePrevious() {},
      },
    });
    const outcome = await coordinator.recoverIncompleteTransactions();
    expect(outcome.recovered).toContain("demo");
    expect(outcome.failed).toEqual([]);
    expect(records.get("demo")?.transaction).toBeNull();
    expect(records.get("demo")?.activeMarketplaceId).toBe("oh-plugins-official");
  });

  it("writes the marketplace active marker into the staged projection and restores it on rollback (finding 5)", async () => {
    let healthy = true;
    const { coordinator, pluginsDir } = makeCoordinator({
      async healthCheck() { return healthy; },
    });
    const markerPath = path.join(pluginsDir, "demo", ".hana-marketplace.json");

    // Successful switch A -> B (both retained): the staged projection carries
    // the candidate's exact marketplaceId/pluginId/artifactDigest.
    const ok = await coordinator.switchSource({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      artifactDigest: DIGEST_B,
    });
    expect(ok.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      marketplaceId: "team-plugins",
      pluginId: "demo",
      artifactDigest: DIGEST_B,
    });

    // Failed switch back to A: rollback re-stages the previous committed
    // source (B) and restores its marker identity.
    healthy = false;
    const failed = await coordinator.switchSource({
      pluginId: "demo",
      marketplaceId: "oh-plugins-official",
      artifactDigest: DIGEST_A,
    });
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("PLUGIN_SOURCE_SWITCH_HEALTH_FAILED");
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      marketplaceId: "team-plugins",
      pluginId: "demo",
      artifactDigest: DIGEST_B,
    });
  });

  it("never leaves a .hana-artifact.json inside the active projection after a switch (finding 5)", async () => {
    const { coordinator, pluginsDir } = makeCoordinator();
    const result = await coordinator.switchSource({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      artifactDigest: DIGEST_B,
    });
    expect(result.ok).toBe(true);
    // Retained artifacts carry .hana-artifact.json meta; the active projection must not.
    expect(fs.existsSync(path.join(pluginsDir, "demo", ".hana-artifact.json"))).toBe(false);
    // Sanity: the projection itself is live and carries the trust marker.
    expect(fs.existsSync(path.join(pluginsDir, "demo", "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, "demo", ".hana-marketplace.json"))).toBe(true);
  });

  it("clears stale marker state when rolling back with no previous source (finding 5)", async () => {
    const home = makeHome();
    const pluginsDir = path.join(home, "plugins");
    const artifacts = new PluginArtifactStore({ hanakoHome: home });
    const records = new PluginInstallRecords({ hanakoHome: home });
    seedArtifact(artifacts, home, "team-plugins", DIGEST_B, "B");
    // Stale active projection from an earlier aborted attempt: no committed
    // source exists on record, but a marker was left behind.
    const activeDir = path.join(pluginsDir, "demo");
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(
      path.join(activeDir, ".hana-marketplace.json"),
      JSON.stringify({
        schemaVersion: 1,
        marketplaceId: "oh-plugins-official",
        pluginId: "demo",
        artifactDigest: DIGEST_A,
      }),
      "utf8",
    );

    const coordinator = new PluginSourceSwitchCoordinator({
      records,
      artifacts,
      pluginsDir,
      runtime: {
        async unloadActive() {},
        async activateCandidate() {},
        async healthCheck() { return false; },
      },
    });
    const result = await coordinator.switchSource({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      artifactDigest: DIGEST_B,
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(activeDir)).toBe(false);
    expect(fs.existsSync(path.join(activeDir, ".hana-marketplace.json"))).toBe(false);
  });
});
