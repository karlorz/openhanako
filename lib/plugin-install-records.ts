import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import { createModuleLogger } from "./debug-log.ts";
import {
  assertArtifactDigest,
  assertMarketplaceId,
  assertPluginId,
} from "./plugin-marketplace-identity.ts";

const log = createModuleLogger("plugin-installs");

export const INSTALL_RECORDS_VERSION_V1 = 1;
export const INSTALL_RECORDS_VERSION_V2 = 2;
export const LEGACY_UNQUALIFIED_MARKETPLACE_ID = "legacy-unqualified";
const MAX_HISTORY = 50;

export interface RetainedPluginArtifactRecord {
  marketplaceId: string;
  artifactDigest: string;
  version: string;
  sourceFingerprint: string;
  requestedRef?: string;
  resolvedRevision?: string;
  catalogSha256: string;
  packageUrl?: string;
  packageSha256: string;
  artifactPath: string;
  retainedAt: string;
  lastActivatedAt?: string;
}

export interface PluginLifecycleHistoryEntry {
  action: string;
  result: string;
  timestamp: string;
  beforeMarketplaceId?: string | null;
  beforeArtifactDigest?: string | null;
  afterMarketplaceId?: string | null;
  afterArtifactDigest?: string | null;
  catalogSha256?: string | null;
  packageSha256?: string | null;
  resolvedRevision?: string | null;
  version?: string | null;
}

export interface PluginSwitchJournal {
  transactionId: string;
  pluginId: string;
  phase: string;
  previous: { marketplaceId: string; pluginId: string; artifactDigest: string } | null;
  candidate: { marketplaceId: string; pluginId: string; artifactDigest: string };
  startedAt: string;
}

export interface PluginInstallRecordV2 {
  schemaVersion: 2;
  pluginId: string;
  activeMarketplaceId: string | null;
  activeArtifactDigest: string | null;
  retained: Record<string, Record<string, RetainedPluginArtifactRecord>>;
  transaction: PluginSwitchJournal | null;
  history: PluginLifecycleHistoryEntry[];
  migrationRequired?: boolean;
  // Compatibility fields for existing callers
  installedVersion?: string | null;
  source?: string | null;
  marketplaceId?: string | null;
  packageUrl?: string | null;
  sha256?: string | null;
  installedAt?: string | null;
  updatedAt?: string | null;
}

function emptyRecords(version = INSTALL_RECORDS_VERSION_V2) {
  return { version, plugins: {} as Record<string, any> };
}

function readJson(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return emptyRecords();
    log.warn(`failed to read ${filePath}: ${err.message}`);
    return emptyRecords();
  }
}

function atomicWriteJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function emptyV2(pluginId: string): PluginInstallRecordV2 {
  return {
    schemaVersion: 2,
    pluginId,
    activeMarketplaceId: null,
    activeArtifactDigest: null,
    retained: {},
    transaction: null,
    history: [],
  };
}

function compatFields(record: PluginInstallRecordV2): PluginInstallRecordV2 {
  const activeMarket = record.activeMarketplaceId;
  const activeDigest = record.activeArtifactDigest;
  const retained = activeMarket && activeDigest
    ? record.retained?.[activeMarket]?.[activeDigest]
    : null;
  return {
    ...record,
    installedVersion: retained?.version || record.installedVersion || null,
    source: activeMarket === LEGACY_UNQUALIFIED_MARKETPLACE_ID
      ? "legacy"
      : activeMarket
        ? "marketplace"
        : record.source || null,
    marketplaceId: activeMarket,
    packageUrl: retained?.packageUrl || record.packageUrl || null,
    sha256: retained?.packageSha256 || activeDigest || record.sha256 || null,
    updatedAt: record.history?.[0]?.timestamp || record.updatedAt || null,
  };
}

export class PluginInstallRecords {
  declare _path: string;
  declare _hanakoHome: string;

  constructor({ hanakoHome }: { hanakoHome: string }) {
    if (!hanakoHome) throw new Error("PluginInstallRecords requires hanakoHome");
    this._hanakoHome = hanakoHome;
    this._path = path.join(hanakoHome, "plugin-installs.json");
  }

  _read() {
    const raw = readJson(this._path);
    const version = Number(raw?.version) || INSTALL_RECORDS_VERSION_V1;
    return {
      version,
      plugins: raw?.plugins && typeof raw.plugins === "object" ? raw.plugins : {},
    };
  }

  _write(records: { version: number; plugins: Record<string, any> }) {
    atomicWriteJson(this._path, records);
  }

  get(pluginId: string): PluginInstallRecordV2 | null {
    if (!pluginId) return null;
    const records = this._read();
    const record = records.plugins[pluginId];
    if (!record) return null;
    if (record.schemaVersion === 2 || records.version === INSTALL_RECORDS_VERSION_V2) {
      return structuredClone(compatFields(record as PluginInstallRecordV2));
    }
    // Lazy view of v1 without migrating whole file
    return structuredClone(this._v1ToV2View(record));
  }

  list(): PluginInstallRecordV2[] {
    const records = this._read();
    return Object.values(records.plugins)
      .map((record: any) => {
        if (!record) return null;
        if (record.schemaVersion === 2 || records.version === INSTALL_RECORDS_VERSION_V2) {
          return structuredClone(compatFields(record as PluginInstallRecordV2));
        }
        return structuredClone(this._v1ToV2View(record));
      })
      .filter(Boolean) as PluginInstallRecordV2[];
  }

  /**
   * Legacy v1 API used by existing install routes.
   */
  recordInstall(record: any) {
    if (!record?.pluginId) throw new Error("recordInstall requires pluginId");
    if (record.marketplaceId && record.sha256) {
      return this.retainAndActivate({
        pluginId: record.pluginId,
        marketplaceId: record.marketplaceId,
        artifactDigest: record.sha256,
        version: record.installedVersion || "0.0.0",
        sourceFingerprint: record.sourceFingerprint || "0".repeat(64),
        catalogSha256: record.catalogSha256 || "0".repeat(64),
        packageSha256: record.sha256,
        packageUrl: record.packageUrl,
        artifactPath: record.sourcePath || record.artifactPath || "",
        action: "install",
        result: "ok",
      });
    }
    // Unqualified legacy install
    return this.retainAndActivate({
      pluginId: record.pluginId,
      marketplaceId: LEGACY_UNQUALIFIED_MARKETPLACE_ID,
      artifactDigest: record.sha256 && /^[a-f0-9]{64}$/.test(record.sha256)
        ? record.sha256
        : "0".repeat(64),
      version: record.installedVersion || "0.0.0",
      sourceFingerprint: "0".repeat(64),
      catalogSha256: "0".repeat(64),
      packageSha256: record.sha256 && /^[a-f0-9]{64}$/.test(record.sha256)
        ? record.sha256
        : "0".repeat(64),
      packageUrl: record.packageUrl,
      artifactPath: record.sourcePath || "",
      action: "install",
      result: "ok",
      migrationRequired: true,
    });
  }

  retainAndActivate(input: {
    pluginId: string;
    marketplaceId: string;
    artifactDigest: string;
    version: string;
    sourceFingerprint: string;
    catalogSha256: string;
    packageSha256: string;
    packageUrl?: string;
    artifactPath: string;
    requestedRef?: string;
    resolvedRevision?: string;
    action: string;
    result: string;
    migrationRequired?: boolean;
  }): PluginInstallRecordV2 {
    const pluginId = assertPluginId(input.pluginId);
    const marketplaceId = input.marketplaceId === LEGACY_UNQUALIFIED_MARKETPLACE_ID
      ? LEGACY_UNQUALIFIED_MARKETPLACE_ID
      : assertMarketplaceId(input.marketplaceId);
    const artifactDigest = assertArtifactDigest(input.artifactDigest);
    const now = new Date().toISOString();
    const file = this._read();
    // Ensure file is v2 shaped
    if (file.version < INSTALL_RECORDS_VERSION_V2) {
      this.migrateToV2({ inMemoryOnly: false });
    }
    const fresh = this._read();
    const previousRaw = fresh.plugins[pluginId];
    const previous: PluginInstallRecordV2 = previousRaw?.schemaVersion === 2
      ? previousRaw
      : emptyV2(pluginId);

    const retainedEntry: RetainedPluginArtifactRecord = {
      marketplaceId,
      artifactDigest,
      version: input.version || "0.0.0",
      sourceFingerprint: input.sourceFingerprint,
      catalogSha256: input.catalogSha256,
      packageUrl: input.packageUrl,
      packageSha256: input.packageSha256 || artifactDigest,
      artifactPath: input.artifactPath || "",
      requestedRef: input.requestedRef,
      resolvedRevision: input.resolvedRevision,
      retainedAt: previous.retained?.[marketplaceId]?.[artifactDigest]?.retainedAt || now,
      lastActivatedAt: now,
    };

    const retained = { ...(previous.retained || {}) };
    retained[marketplaceId] = { ...(retained[marketplaceId] || {}) };
    retained[marketplaceId][artifactDigest] = retainedEntry;

    const historyEntry: PluginLifecycleHistoryEntry = {
      action: input.action,
      result: input.result,
      timestamp: now,
      beforeMarketplaceId: previous.activeMarketplaceId,
      beforeArtifactDigest: previous.activeArtifactDigest,
      afterMarketplaceId: marketplaceId,
      afterArtifactDigest: artifactDigest,
      catalogSha256: input.catalogSha256,
      packageSha256: input.packageSha256,
      resolvedRevision: input.resolvedRevision || null,
      version: input.version,
    };

    const next: PluginInstallRecordV2 = {
      schemaVersion: 2,
      pluginId,
      activeMarketplaceId: marketplaceId,
      activeArtifactDigest: artifactDigest,
      retained,
      transaction: previous.transaction || null,
      history: [historyEntry, ...(previous.history || [])].slice(0, MAX_HISTORY),
      migrationRequired: input.migrationRequired || previous.migrationRequired || false,
      installedAt: previous.installedAt || now,
      updatedAt: now,
    };

    fresh.version = INSTALL_RECORDS_VERSION_V2;
    fresh.plugins[pluginId] = compatFields(next);
    this._write(fresh);
    return structuredClone(compatFields(next));
  }

  setTransaction(pluginId: string, transaction: PluginSwitchJournal | null) {
    const id = assertPluginId(pluginId);
    const file = this._read();
    if (file.version < INSTALL_RECORDS_VERSION_V2) this.migrateToV2();
    const fresh = this._read();
    const record = fresh.plugins[id]?.schemaVersion === 2
      ? fresh.plugins[id]
      : emptyV2(id);
    record.transaction = transaction;
    fresh.version = INSTALL_RECORDS_VERSION_V2;
    fresh.plugins[id] = record;
    this._write(fresh);
    return structuredClone(record);
  }

  deactivate(input: {
    pluginId: string;
    marketplaceId: string;
    artifactDigest: string;
    action?: string;
    result?: string;
  }): PluginInstallRecordV2 {
    const pluginId = assertPluginId(input.pluginId);
    const marketplaceId = assertMarketplaceId(input.marketplaceId);
    const artifactDigest = assertArtifactDigest(input.artifactDigest);
    const file = this._read();
    const record = file.plugins[pluginId] as PluginInstallRecordV2 | undefined;
    if (!record || record.activeMarketplaceId !== marketplaceId || record.activeArtifactDigest !== artifactDigest) {
      const err = new Error("Active Marketplace plugin identity does not match uninstall request") as Error & { code: string };
      err.code = "PLUGIN_MARKETPLACE_ACTIVE_POINTER_MISMATCH";
      throw err;
    }
    const now = new Date().toISOString();
    const retained = record.retained?.[marketplaceId]?.[artifactDigest];
    const next: PluginInstallRecordV2 = {
      ...record,
      activeMarketplaceId: null,
      activeArtifactDigest: null,
      transaction: null,
      history: [{
        action: input.action || "uninstall",
        result: input.result || "ok",
        timestamp: now,
        beforeMarketplaceId: marketplaceId,
        beforeArtifactDigest: artifactDigest,
        afterMarketplaceId: null,
        afterArtifactDigest: null,
        catalogSha256: retained?.catalogSha256 || null,
        packageSha256: retained?.packageSha256 || artifactDigest,
        resolvedRevision: retained?.resolvedRevision || null,
        version: retained?.version || null,
      }, ...(record.history || [])].slice(0, MAX_HISTORY),
      updatedAt: now,
    };
    file.version = INSTALL_RECORDS_VERSION_V2;
    file.plugins[pluginId] = compatFields(next);
    this._write(file);
    return structuredClone(compatFields(next));
  }

  removeRetainedArtifact(pluginId: string, marketplaceId: string, artifactDigest: string) {
    const id = assertPluginId(pluginId);
    const market = assertMarketplaceId(marketplaceId);
    const digest = assertArtifactDigest(artifactDigest);
    const file = this._read();
    const record = file.plugins[id];
    if (!record?.retained?.[market]?.[digest]) return;
    if (record.activeMarketplaceId === market && record.activeArtifactDigest === digest) {
      throw new Error("Cannot remove the active retained artifact");
    }
    delete record.retained[market][digest];
    if (Object.keys(record.retained[market]).length === 0) delete record.retained[market];
    file.plugins[id] = record;
    this._write(file);
  }

  isSourceInUse(marketplaceId: string): boolean {
    const file = this._read();
    for (const record of Object.values(file.plugins) as any[]) {
      if (!record) continue;
      if (record.activeMarketplaceId === marketplaceId) return true;
      if (record.retained?.[marketplaceId] && Object.keys(record.retained[marketplaceId]).length) {
        return true;
      }
      if (record.marketplaceId === marketplaceId) return true;
    }
    return false;
  }

  remove(pluginId: string) {
    if (!pluginId) return;
    const records = this._read();
    delete records.plugins[pluginId];
    this._write(records);
  }

  migrateToV2(options: { inMemoryOnly?: boolean } = {}) {
    const file = this._read();
    if (file.version >= INSTALL_RECORDS_VERSION_V2) {
      // Still normalize any leftover v1-shaped entries
      let changed = false;
      const migrated: string[] = [];
      const legacyUnqualified: string[] = [];
      for (const [id, raw] of Object.entries(file.plugins) as [string, any][]) {
        if (raw?.schemaVersion === 2) continue;
        const v2 = this._v1ToV2View(raw);
        file.plugins[id] = v2;
        changed = true;
        if (v2.migrationRequired) legacyUnqualified.push(id);
        else migrated.push(id);
      }
      if (changed && !options.inMemoryOnly) this._write(file);
      return { alreadyV2: !changed, migrated, legacyUnqualified };
    }

    // Checkpoint
    if (!options.inMemoryOnly && fs.existsSync(this._path)) {
      const checkpoint = `${this._path}.v1-backup-${Date.now()}`;
      fs.copyFileSync(this._path, checkpoint);
    }

    const migrated: string[] = [];
    const legacyUnqualified: string[] = [];
    const nextPlugins: Record<string, PluginInstallRecordV2> = {};

    for (const [id, raw] of Object.entries(file.plugins)) {
      const v2 = this._v1ToV2View(raw);
      nextPlugins[id] = v2;
      if (v2.migrationRequired) legacyUnqualified.push(id);
      else migrated.push(id);
    }

    const next = { version: INSTALL_RECORDS_VERSION_V2, plugins: nextPlugins };
    if (!options.inMemoryOnly) this._write(next);
    return { alreadyV2: false, migrated, legacyUnqualified };
  }

  _v1ToV2View(raw: any): PluginInstallRecordV2 {
    const pluginId = String(raw?.pluginId || "unknown");
    const trustworthy = Boolean(
      raw?.marketplaceId
      && typeof raw.marketplaceId === "string"
      && raw.marketplaceId !== LEGACY_UNQUALIFIED_MARKETPLACE_ID
      && raw.sha256
      && /^[a-f0-9]{64}$/.test(raw.sha256),
    );

    if (!trustworthy) {
      const digest = raw?.sha256 && /^[a-f0-9]{64}$/.test(raw.sha256)
        ? raw.sha256
        : "0".repeat(64);
      const record = emptyV2(pluginId);
      record.activeMarketplaceId = LEGACY_UNQUALIFIED_MARKETPLACE_ID;
      record.activeArtifactDigest = digest;
      record.migrationRequired = true;
      record.retained = {
        [LEGACY_UNQUALIFIED_MARKETPLACE_ID]: {
          [digest]: {
            marketplaceId: LEGACY_UNQUALIFIED_MARKETPLACE_ID,
            artifactDigest: digest,
            version: raw?.installedVersion || "0.0.0",
            sourceFingerprint: "0".repeat(64),
            catalogSha256: "0".repeat(64),
            packageSha256: digest,
            packageUrl: raw?.packageUrl || undefined,
            artifactPath: raw?.sourcePath || "",
            retainedAt: raw?.installedAt || new Date().toISOString(),
          },
        },
      };
      record.history = Array.isArray(raw?.history) ? raw.history : [];
      record.installedAt = raw?.installedAt || null;
      record.updatedAt = raw?.updatedAt || null;
      return compatFields(record);
    }

    const marketplaceId = String(raw.marketplaceId);
    const digest = String(raw.sha256);
    const record = emptyV2(pluginId);
    record.activeMarketplaceId = marketplaceId;
    record.activeArtifactDigest = digest;
    record.retained = {
      [marketplaceId]: {
        [digest]: {
          marketplaceId,
          artifactDigest: digest,
          version: raw.installedVersion || "0.0.0",
          sourceFingerprint: raw.sourceFingerprint || "0".repeat(64),
          catalogSha256: raw.catalogSha256 || "0".repeat(64),
          packageSha256: digest,
          packageUrl: raw.packageUrl || undefined,
          artifactPath: raw.sourcePath || "",
          retainedAt: raw.installedAt || new Date().toISOString(),
          lastActivatedAt: raw.updatedAt || raw.installedAt || undefined,
        },
      },
    };
    record.history = Array.isArray(raw.history) ? raw.history : [];
    record.installedAt = raw.installedAt || null;
    record.updatedAt = raw.updatedAt || null;
    return compatFields(record);
  }
}
