import fs from "fs";
import path from "path";
import { assertMarketplaceId } from "./plugin-marketplace-identity.ts";
import type { TaggedMarketplacePlugin } from "./plugin-marketplace-schema.ts";
import { atomicWriteSync } from "../shared/safe-fs.ts";

export const MARKETPLACE_SNAPSHOT_CACHE_DIR = "plugin-marketplace-cache";

export interface MarketplaceSnapshot {
  sourceId: string;
  sourceFingerprint: string;
  catalogSha256: string;
  fetchedAt: string;
  requestedRef?: string;
  resolvedRevision?: string;
  plugins: TaggedMarketplacePlugin[];
}

export interface SanitizedSourceError {
  code: string;
  message: string;
}

export type MarketplaceSourceStatus =
  | { state: "ok"; current: MarketplaceSnapshot; previous?: MarketplaceSnapshot | null }
  | { state: "stale"; current: MarketplaceSnapshot; previous?: MarketplaceSnapshot | null; refreshError: SanitizedSourceError }
  | { state: "error"; current: null; refreshError: SanitizedSourceError }
  | { state: "refreshing"; current: MarketplaceSnapshot | null };

interface SourceMetaFile {
  sourceId: string;
  currentGeneration: string | null;
  previousGeneration: string | null;
  lastError: SanitizedSourceError | null;
  refreshing: boolean;
}

function emptyMeta(sourceId: string): SourceMetaFile {
  return {
    sourceId,
    currentGeneration: null,
    previousGeneration: null,
    lastError: null,
    refreshing: false,
  };
}

export class MarketplaceSnapshotStore {
  declare _root: string;

  constructor(options: { hanakoHome: string }) {
    if (!options?.hanakoHome) {
      throw new Error("MarketplaceSnapshotStore requires hanakoHome");
    }
    this._root = path.join(options.hanakoHome, MARKETPLACE_SNAPSHOT_CACHE_DIR);
  }

  publish(sourceId: string, snapshot: MarketplaceSnapshot): MarketplaceSnapshot {
    const id = assertMarketplaceId(sourceId);
    this._assertSnapshot(id, snapshot);

    const sourceDir = this._sourceDir(id);
    fs.mkdirSync(sourceDir, { recursive: true });

    const generationId = `${Date.now()}-${snapshot.catalogSha256.slice(0, 12)}`;
    const generationDir = path.join(sourceDir, "generations", generationId);
    fs.mkdirSync(generationDir, { recursive: true });

    const snapshotPath = path.join(generationDir, "snapshot.json");
    atomicWriteSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

    const meta = this._readMeta(id);
    const previous = meta.currentGeneration;
    meta.currentGeneration = generationId;
    if (previous && previous !== generationId) {
      meta.previousGeneration = previous;
    }
    meta.lastError = null;
    meta.refreshing = false;
    this._writeMeta(id, meta);

    return structuredClone(snapshot);
  }

  markError(sourceId: string, error: SanitizedSourceError): void {
    const id = assertMarketplaceId(sourceId);
    const meta = this._readMeta(id);
    meta.lastError = {
      code: String(error.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID"),
      message: String(error.message || "source error"),
    };
    meta.refreshing = false;
    this._writeMeta(id, meta);
  }

  markRefreshing(sourceId: string): void {
    const id = assertMarketplaceId(sourceId);
    const meta = this._readMeta(id);
    meta.refreshing = true;
    this._writeMeta(id, meta);
  }

  getStatus(sourceId: string): MarketplaceSourceStatus {
    const id = assertMarketplaceId(sourceId);
    const meta = this._readMeta(id);
    const current = meta.currentGeneration
      ? this._readGeneration(id, meta.currentGeneration)
      : null;
    const previous = meta.previousGeneration
      ? this._readGeneration(id, meta.previousGeneration)
      : null;

    if (meta.refreshing) {
      return { state: "refreshing", current };
    }
    if (current && meta.lastError) {
      return {
        state: "stale",
        current,
        previous,
        refreshError: meta.lastError,
      };
    }
    if (current) {
      return { state: "ok", current, previous };
    }
    if (meta.lastError) {
      return { state: "error", current: null, refreshError: meta.lastError };
    }
    return {
      state: "error",
      current: null,
      refreshError: { code: "PLUGIN_MARKETPLACE_SOURCE_INVALID", message: "no snapshot" },
    };
  }

  listCurrentPlugins(): TaggedMarketplacePlugin[] {
    if (!fs.existsSync(this._root)) return [];
    const rows: TaggedMarketplacePlugin[] = [];
    for (const entry of fs.readdirSync(this._root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const status = this.getStatus(entry.name);
      if (status.state === "ok" || status.state === "stale" || status.state === "refreshing") {
        if (status.current?.plugins) {
          rows.push(...status.current.plugins.map((p) => structuredClone(p)));
        }
      }
    }
    return rows.sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.marketplaceId.localeCompare(b.marketplaceId);
    });
  }

  _sourceDir(sourceId: string): string {
    return path.join(this._root, sourceId);
  }

  _metaPath(sourceId: string): string {
    return path.join(this._sourceDir(sourceId), "meta.json");
  }

  _readMeta(sourceId: string): SourceMetaFile {
    const metaPath = this._metaPath(sourceId);
    if (!fs.existsSync(metaPath)) {
      return emptyMeta(sourceId);
    }
    try {
      const raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      return {
        sourceId,
        currentGeneration: typeof raw.currentGeneration === "string" ? raw.currentGeneration : null,
        previousGeneration: typeof raw.previousGeneration === "string" ? raw.previousGeneration : null,
        lastError: raw.lastError && typeof raw.lastError === "object"
          ? {
              code: String(raw.lastError.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID"),
              message: String(raw.lastError.message || "source error"),
            }
          : null,
        refreshing: Boolean(raw.refreshing),
      };
    } catch {
      return emptyMeta(sourceId);
    }
  }

  _writeMeta(sourceId: string, meta: SourceMetaFile): void {
    const dir = this._sourceDir(sourceId);
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteSync(this._metaPath(sourceId), `${JSON.stringify(meta, null, 2)}\n`);
  }

  _readGeneration(sourceId: string, generationId: string): MarketplaceSnapshot | null {
    const snapshotPath = path.join(this._sourceDir(sourceId), "generations", generationId, "snapshot.json");
    if (!fs.existsSync(snapshotPath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
      if (!raw || typeof raw !== "object") return null;
      return raw as MarketplaceSnapshot;
    } catch {
      return null;
    }
  }

  _assertSnapshot(sourceId: string, snapshot: MarketplaceSnapshot): void {
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("Snapshot must be an object");
    }
    if (snapshot.sourceId !== sourceId) {
      throw new Error("Snapshot sourceId mismatch");
    }
    if (typeof snapshot.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.sourceFingerprint)) {
      throw new Error("Snapshot requires 64-hex sourceFingerprint");
    }
    if (typeof snapshot.catalogSha256 !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.catalogSha256)) {
      throw new Error("Snapshot requires 64-hex catalogSha256");
    }
    if (typeof snapshot.fetchedAt !== "string" || !snapshot.fetchedAt) {
      throw new Error("Snapshot requires fetchedAt");
    }
    if (!Array.isArray(snapshot.plugins)) {
      throw new Error("Snapshot plugins must be an array");
    }
    for (const plugin of snapshot.plugins) {
      if (!plugin || plugin.marketplaceId !== sourceId) {
        throw new Error("Snapshot plugins must carry matching marketplaceId");
      }
    }
  }
}
