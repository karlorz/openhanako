import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  assertArtifactDigest,
  assertMarketplaceId,
  assertPluginId,
} from "./plugin-marketplace-identity.ts";
import type { PluginInstallRecords, PluginSwitchJournal } from "./plugin-install-records.ts";
import type { PluginArtifactStore } from "./plugin-artifact-store.ts";
import { marketplacePluginKey } from "./plugin-trust-store.ts";
import { writeMarketplaceActiveMarker } from "./plugin-marketplace-active-marker.ts";

export type PluginSwitchPhase =
  | "preparing"
  | "quiescing"
  | "activating-candidate"
  | "health-checking"
  | "committing"
  | "rolling-back";

export interface SwitchQuiesceHandle {
  begin(pluginId: string): void;
  end(pluginId: string): void;
  waitForIdle?(pluginId: string, timeoutMs: number): Promise<void>;
  isBusy?(pluginId: string): boolean;
}

export interface SwitchRuntimeHooks {
  unloadActive(pluginId: string, marketplaceId: string | null): Promise<void> | void;
  activateCandidate(input: {
    pluginId: string;
    marketplaceId: string;
    artifactDigest: string;
    artifactPath: string;
    pluginKey: string;
  }): Promise<void> | void;
  healthCheck?(input: {
    pluginId: string;
    marketplaceId: string;
    artifactDigest: string;
  }): Promise<boolean> | boolean;
  restorePrevious?(input: {
    pluginId: string;
    marketplaceId: string;
    artifactDigest: string;
    artifactPath: string;
    pluginKey: string;
  }): Promise<void> | void;
}

export interface SourceSwitchRequest {
  pluginId: string;
  marketplaceId: string;
  artifactDigest?: string;
  version?: string;
}

export interface SourceSwitchResult {
  ok: boolean;
  pluginId: string;
  activeMarketplaceId: string | null;
  activeArtifactDigest: string | null;
  phase?: PluginSwitchPhase;
  error?: { code: string; message: string };
}

const DEFAULT_QUIESCE_TIMEOUT_MS = 5_000;

export class PluginSourceSwitchCoordinator {
  declare _records: PluginInstallRecords;
  declare _artifacts: PluginArtifactStore;
  declare _runtime: SwitchRuntimeHooks;
  declare _quiesce: SwitchQuiesceHandle;
  declare _pluginsDir: string;
  declare _locks: Set<string>;
  declare _quiesceTimeoutMs: number;

  constructor(options: {
    records: PluginInstallRecords;
    artifacts: PluginArtifactStore;
    runtime: SwitchRuntimeHooks;
    quiesce?: SwitchQuiesceHandle;
    pluginsDir: string;
    quiesceTimeoutMs?: number;
  }) {
    this._records = options.records;
    this._artifacts = options.artifacts;
    this._runtime = options.runtime;
    this._pluginsDir = options.pluginsDir;
    this._quiesceTimeoutMs = options.quiesceTimeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;
    this._locks = new Set();
    this._quiesce = options.quiesce || {
      begin() {},
      end() {},
      async waitForIdle() {},
      isBusy() { return false; },
    };
  }

  async switchSource(request: SourceSwitchRequest): Promise<SourceSwitchResult> {
    const pluginId = assertPluginId(request.pluginId);
    const marketplaceId = assertMarketplaceId(request.marketplaceId);

    if (this._locks.has(pluginId)) {
      return {
        ok: false,
        pluginId,
        activeMarketplaceId: this._records.get(pluginId)?.activeMarketplaceId ?? null,
        activeArtifactDigest: this._records.get(pluginId)?.activeArtifactDigest ?? null,
        error: {
          code: "PLUGIN_SOURCE_SWITCH_IN_PROGRESS",
          message: "A source switch is already in progress for this plugin",
        },
      };
    }

    this._locks.add(pluginId);
    const current = this._records.get(pluginId);
    const previousMarket = current?.activeMarketplaceId || null;
    const previousDigest = current?.activeArtifactDigest || null;

    let journal: PluginSwitchJournal | null = null;

    try {
      // Resolve candidate artifact
      let artifactDigest = request.artifactDigest
        ? assertArtifactDigest(request.artifactDigest)
        : null;
      if (!artifactDigest) {
        const retained = current?.retained?.[marketplaceId];
        if (!retained || !Object.keys(retained).length) {
          throw Object.assign(new Error("No retained artifact for target marketplace"), {
            code: "PLUGIN_MARKETPLACE_SOURCE_INVALID",
          });
        }
        // Prefer latest retained by lastActivatedAt/retainedAt
        const sorted = Object.values(retained).sort((a, b) =>
          String(b.lastActivatedAt || b.retainedAt).localeCompare(String(a.lastActivatedAt || a.retainedAt)),
        );
        artifactDigest = sorted[0].artifactDigest;
      }

      const artifact = this._artifacts.get(marketplaceId, pluginId, artifactDigest)
        || current?.retained?.[marketplaceId]?.[artifactDigest];
      if (!artifact) {
        throw Object.assign(new Error("Candidate artifact is not retained"), {
          code: "PLUGIN_MARKETPLACE_SOURCE_INVALID",
        });
      }
      const artifactPath = (artifact as any).artifactPath;
      if (!artifactPath || !fs.existsSync(artifactPath)) {
        throw Object.assign(new Error("Candidate artifact path missing on disk"), {
          code: "PLUGIN_MARKETPLACE_SOURCE_INVALID",
        });
      }

      journal = {
        transactionId: randomUUID(),
        pluginId,
        phase: "preparing",
        previous: previousMarket && previousDigest
          ? { marketplaceId: previousMarket, pluginId, artifactDigest: previousDigest }
          : null,
        candidate: { marketplaceId, pluginId, artifactDigest },
        startedAt: new Date().toISOString(),
      };
      this._writeJournal(pluginId, journal);

      journal.phase = "quiescing";
      this._writeJournal(pluginId, journal);
      this._quiesce.begin(pluginId);
      if (this._quiesce.waitForIdle) {
        try {
          await this._quiesce.waitForIdle(pluginId, this._quiesceTimeoutMs);
        } catch {
          throw Object.assign(new Error("In-flight plugin work did not drain"), {
            code: "PLUGIN_SOURCE_SWITCH_QUIESCE_TIMEOUT",
          });
        }
      }

      journal.phase = "activating-candidate";
      this._writeJournal(pluginId, journal);

      await this._runtime.unloadActive(pluginId, previousMarket);

      // Materialize active projection plugins/<pluginId>
      const activeDir = path.join(this._pluginsDir, pluginId);
      await this._stageActiveProjection(artifactPath, activeDir, { marketplaceId, pluginId, artifactDigest });

      const pluginKey = marketplacePluginKey(marketplaceId, pluginId);
      await this._runtime.activateCandidate({
        pluginId,
        marketplaceId,
        artifactDigest,
        artifactPath: activeDir,
        pluginKey,
      });

      journal.phase = "health-checking";
      this._writeJournal(pluginId, journal);
      const healthy = this._runtime.healthCheck
        ? await this._runtime.healthCheck({ pluginId, marketplaceId, artifactDigest })
        : true;
      if (!healthy) {
        throw Object.assign(new Error("Candidate health check failed"), {
          code: "PLUGIN_SOURCE_SWITCH_HEALTH_FAILED",
        });
      }

      journal.phase = "committing";
      this._writeJournal(pluginId, journal);

      const retainedMeta = current?.retained?.[marketplaceId]?.[artifactDigest];
      this._records.retainAndActivate({
        pluginId,
        marketplaceId,
        artifactDigest,
        version: retainedMeta?.version || (artifact as any).version || "0.0.0",
        sourceFingerprint: retainedMeta?.sourceFingerprint || (artifact as any).sourceFingerprint || "0".repeat(64),
        catalogSha256: retainedMeta?.catalogSha256 || (artifact as any).catalogSha256 || "0".repeat(64),
        packageSha256: retainedMeta?.packageSha256 || artifactDigest,
        packageUrl: retainedMeta?.packageUrl || (artifact as any).packageUrl,
        artifactPath,
        action: "source-switch",
        result: "ok",
      });
      this._artifacts.markActivated(marketplaceId, pluginId, artifactDigest);
      this._records.setTransaction(pluginId, null);
      this._quiesce.end(pluginId);

      return {
        ok: true,
        pluginId,
        activeMarketplaceId: marketplaceId,
        activeArtifactDigest: artifactDigest,
        phase: "committing",
      };
    } catch (err: any) {
      try {
        if (journal) {
          journal.phase = "rolling-back";
          this._writeJournal(pluginId, journal);
        }
        await this._rollback(pluginId, previousMarket, previousDigest, current);
        this._records.setTransaction(pluginId, null);
      } catch (rollbackErr: any) {
        this._quiesce.end(pluginId);
        return {
          ok: false,
          pluginId,
          activeMarketplaceId: previousMarket,
          activeArtifactDigest: previousDigest,
          phase: "rolling-back",
          error: {
            code: "PLUGIN_SOURCE_SWITCH_ROLLBACK_FAILED",
            message: rollbackErr?.message || String(rollbackErr),
          },
        };
      }
      this._quiesce.end(pluginId);
      return {
        ok: false,
        pluginId,
        activeMarketplaceId: previousMarket,
        activeArtifactDigest: previousDigest,
        phase: "rolling-back",
        error: {
          code: err?.code || "PLUGIN_SOURCE_SWITCH_HEALTH_FAILED",
          message: err?.message || String(err),
        },
      };
    } finally {
      this._locks.delete(pluginId);
    }
  }

  /**
   * Recover incomplete journals to the last committed pointer before accepting calls.
   */
  async recoverIncompleteTransactions(): Promise<string[]> {
    // Install records do not enumerate easily; recovery is per known plugin via get + journal.
    // Callers pass plugin ids or we scan the records file.
    const recovered: string[] = [];
    const recordsPath = (this._records as any)._path as string;
    if (!fs.existsSync(recordsPath)) return recovered;
    let plugins: Record<string, any> = {};
    try {
      plugins = JSON.parse(fs.readFileSync(recordsPath, "utf8")).plugins || {};
    } catch {
      return recovered;
    }
    for (const [pluginId, record] of Object.entries(plugins)) {
      if (!record?.transaction) continue;
      const previous = record.transaction.previous;
      if (previous) {
        await this._rollback(
          pluginId,
          previous.marketplaceId,
          previous.artifactDigest,
          record,
        );
      }
      this._records.setTransaction(pluginId, null);
      recovered.push(pluginId);
    }
    return recovered;
  }

  _writeJournal(pluginId: string, journal: PluginSwitchJournal) {
    this._records.setTransaction(pluginId, journal);
  }

  async _stageActiveProjection(
    artifactPath: string,
    activeDir: string,
    marketplace: { marketplaceId: string; pluginId: string; artifactDigest: string },
  ) {
    const parent = path.dirname(activeDir);
    fs.mkdirSync(parent, { recursive: true });
    const tmp = `${activeDir}.switch-tmp-${process.pid}-${Date.now()}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(artifactPath, tmp, { recursive: true });
    // Drop the retained-artifact meta file from the active projection.
    fs.rmSync(path.join(tmp, ".hana-artifact.json"), { force: true });
    // Write the marketplace active marker so PluginManager trust resolution
    // stays source-qualified (finding 5).
    writeMarketplaceActiveMarker(tmp, marketplace);
    fs.rmSync(activeDir, { recursive: true, force: true });
    fs.renameSync(tmp, activeDir);
  }

  async _rollback(
    pluginId: string,
    previousMarket: string | null,
    previousDigest: string | null,
    current: any,
  ) {
    if (!previousMarket || !previousDigest) {
      // No previous committed source: leave slot empty
      const activeDir = path.join(this._pluginsDir, pluginId);
      fs.rmSync(activeDir, { recursive: true, force: true });
      // Remove any stale marker so trust resolution cannot pin a dead source.
      fs.rmSync(path.join(activeDir, ".hana-marketplace.json"), { force: true });
      return;
    }
    const artifact = this._artifacts.get(previousMarket, pluginId, previousDigest)
      || current?.retained?.[previousMarket]?.[previousDigest];
    const artifactPath = artifact?.artifactPath;
    if (!artifactPath || !fs.existsSync(artifactPath)) {
      throw Object.assign(new Error("Previous artifact missing during rollback"), {
        code: "PLUGIN_SOURCE_SWITCH_ROLLBACK_FAILED",
      });
    }
    const activeDir = path.join(this._pluginsDir, pluginId);
    await this._stageActiveProjection(artifactPath, activeDir, {
      marketplaceId: previousMarket,
      pluginId,
      artifactDigest: previousDigest,
    });
    const pluginKey = marketplacePluginKey(previousMarket, pluginId);
    if (this._runtime.restorePrevious) {
      await this._runtime.restorePrevious({
        pluginId,
        marketplaceId: previousMarket,
        artifactDigest: previousDigest,
        artifactPath: activeDir,
        pluginKey,
      });
    } else {
      await this._runtime.activateCandidate({
        pluginId,
        marketplaceId: previousMarket,
        artifactDigest: previousDigest,
        artifactPath: activeDir,
        pluginKey,
      });
    }
  }
}

/** Simple in-process quiesce tracker for tests and default runtime. */
export function createInProcessQuiesceHandle(): SwitchQuiesceHandle & {
  trackCall(pluginId: string): () => void;
  rejectIfSwitching(pluginId: string): void;
} {
  const switching = new Set<string>();
  const inFlight = new Map<string, number>();

  return {
    begin(pluginId) {
      switching.add(pluginId);
    },
    end(pluginId) {
      switching.delete(pluginId);
    },
    isBusy(pluginId) {
      return switching.has(pluginId);
    },
    async waitForIdle(pluginId, timeoutMs) {
      const start = Date.now();
      while ((inFlight.get(pluginId) || 0) > 0) {
        if (Date.now() - start > timeoutMs) {
          throw new Error("quiesce timeout");
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    trackCall(pluginId) {
      this.rejectIfSwitching(pluginId);
      inFlight.set(pluginId, (inFlight.get(pluginId) || 0) + 1);
      return () => {
        inFlight.set(pluginId, Math.max(0, (inFlight.get(pluginId) || 1) - 1));
      };
    },
    rejectIfSwitching(pluginId) {
      if (switching.has(pluginId)) {
        const err = new Error("PLUGIN_SOURCE_SWITCH_IN_PROGRESS") as Error & { code: string };
        err.code = "PLUGIN_SOURCE_SWITCH_IN_PROGRESS";
        throw err;
      }
    },
  };
}
