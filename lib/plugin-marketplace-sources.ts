import fs from "fs";
import path from "path";
import {
  assertMarketplaceId,
  buildSourceFingerprint,
  type MarketplaceSourceFingerprintInput,
} from "./plugin-marketplace-identity.ts";
import { DEFAULT_OFFICIAL_PLUGIN_MARKETPLACE_URL } from "./plugin-marketplace.ts";

export const OFFICIAL_MARKETPLACE_ID = "oh-plugins-official";
export const OFFICIAL_MARKETPLACE_NAME = "OH Plugins Official";
export const MARKETPLACE_SOURCES_FILENAME = "plugin-marketplaces.json";
export const MARKETPLACE_SOURCES_SCHEMA_VERSION = 1 as const;
export const LEGACY_MARKETPLACE_ID = "legacy-override";

export type MarketplaceSourceKind = "url" | "local" | "git";

export type MarketplaceSourceDescriptor =
  | { id: string; name: string; kind: "url"; url: string }
  | { id: string; name: string; kind: "local"; path: string; indexPath?: string }
  | { id: string; name: string; kind: "git"; gitUrl: string; gitRef?: string; indexPath?: string };

export type MarketplaceSourceAuthority = "official" | "custom" | "legacy";

export type EffectiveMarketplaceSource = MarketplaceSourceDescriptor & {
  authority: MarketplaceSourceAuthority;
  mutable: boolean;
  sourceFingerprint: string;
};

export interface MarketplaceSourcesFile {
  schemaVersion: 1;
  revision: number;
  sources: MarketplaceSourceDescriptor[];
}

export interface LegacyMarketplaceOverlay {
  kind: "url" | "local";
  url?: string;
  path?: string;
  id?: string;
  name?: string;
}

export interface MarketplaceSourceFsOps {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readFileSync(path: string, encoding: BufferEncoding): string;
  writeFileSync(path: string, data: string, encoding?: BufferEncoding): void;
  renameSync(from: string, to: string): void;
  unlinkSync?(path: string): void;
  openSync?(path: string, flags: string): number;
  fsyncSync?(fd: number): void;
  closeSync?(fd: number): void;
}

export type SourceInUseCallback = (marketplaceId: string) => boolean;

export interface MutationOptions {
  expectedRevision?: number;
  isSourceInUse?: SourceInUseCallback;
}

export interface MutationResult {
  revision: number;
  source?: EffectiveMarketplaceSource;
}

type DurableLoadResult =
  | { ok: true; file: MarketplaceSourcesFile }
  | { ok: false; degraded: true; error: string };

function defaultFsOps(): MarketplaceSourceFsOps {
  return {
    existsSync: fs.existsSync.bind(fs),
    mkdirSync: (p, o) => {
      fs.mkdirSync(p, o);
    },
    readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
    writeFileSync: (p, data, encoding) => {
      fs.writeFileSync(p, data, encoding);
    },
    renameSync: fs.renameSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
    openSync: fs.openSync.bind(fs),
    fsyncSync: fs.fsyncSync.bind(fs),
    closeSync: fs.closeSync.bind(fs),
  };
}

export function createCompiledOfficialMarketplaceSource(options: { url?: string } = {}): EffectiveMarketplaceSource {
  const url = typeof options.url === "string" && options.url.trim()
    ? options.url.trim()
    : DEFAULT_OFFICIAL_PLUGIN_MARKETPLACE_URL;
  const descriptor: MarketplaceSourceDescriptor = {
    id: OFFICIAL_MARKETPLACE_ID,
    name: OFFICIAL_MARKETPLACE_NAME,
    kind: "url",
    url,
  };
  return {
    ...descriptor,
    authority: "official",
    mutable: false,
    sourceFingerprint: buildSourceFingerprint({
      kind: "url",
      id: OFFICIAL_MARKETPLACE_ID,
      url,
    }),
  };
}

function createLegacySource(overlay: LegacyMarketplaceOverlay): EffectiveMarketplaceSource {
  const id = overlay.id && overlay.id !== OFFICIAL_MARKETPLACE_ID
    ? assertMarketplaceId(overlay.id)
    : LEGACY_MARKETPLACE_ID;
  const name = typeof overlay.name === "string" && overlay.name.trim()
    ? overlay.name.trim()
    : "Legacy marketplace override";

  if (overlay.kind === "local") {
    if (typeof overlay.path !== "string" || !overlay.path) {
      throw new Error("Legacy local overlay requires path");
    }
    const descriptor: MarketplaceSourceDescriptor = {
      id,
      name,
      kind: "local",
      path: overlay.path,
    };
    return {
      ...descriptor,
      authority: "legacy",
      mutable: false,
      sourceFingerprint: buildSourceFingerprint({
        kind: "local",
        id,
        path: overlay.path,
      }),
    };
  }

  if (typeof overlay.url !== "string" || !overlay.url) {
    throw new Error("Legacy URL overlay requires url");
  }
  const descriptor: MarketplaceSourceDescriptor = {
    id,
    name,
    kind: "url",
    url: overlay.url,
  };
  return {
    ...descriptor,
    authority: "legacy",
    mutable: false,
    sourceFingerprint: buildSourceFingerprint({
      kind: "url",
      id,
      url: overlay.url,
    }),
  };
}

function emptyFile(): MarketplaceSourcesFile {
  return {
    schemaVersion: MARKETPLACE_SOURCES_SCHEMA_VERSION,
    revision: 0,
    sources: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validateDescriptor(raw: unknown): MarketplaceSourceDescriptor {
  if (!isPlainObject(raw)) {
    throw new Error("Marketplace source descriptor must be an object");
  }
  const id = assertMarketplaceId(raw.id);
  if (id === OFFICIAL_MARKETPLACE_ID) {
    throw new Error(`Marketplace id "${OFFICIAL_MARKETPLACE_ID}" is reserved for the compiled official source`);
  }
  const name = normalizeOptionalText(raw.name);
  if (!name) throw new Error("Marketplace source requires name");
  const kind = raw.kind;
  if (kind === "url") {
    const url = normalizeOptionalText(raw.url);
    if (!url) throw new Error("URL marketplace source requires url");
    return { id, name, kind: "url", url };
  }
  if (kind === "local") {
    const localPath = normalizeOptionalText(raw.path);
    if (!localPath) throw new Error("Local marketplace source requires path");
    const indexPath = normalizeOptionalText(raw.indexPath) || undefined;
    return indexPath
      ? { id, name, kind: "local", path: localPath, indexPath }
      : { id, name, kind: "local", path: localPath };
  }
  if (kind === "git") {
    const gitUrl = normalizeOptionalText(raw.gitUrl);
    if (!gitUrl) throw new Error("Git marketplace source requires gitUrl");
    const gitRef = normalizeOptionalText(raw.gitRef) || undefined;
    const indexPath = normalizeOptionalText(raw.indexPath) || undefined;
    return {
      id,
      name,
      kind: "git",
      gitUrl,
      ...(gitRef ? { gitRef } : {}),
      ...(indexPath ? { indexPath } : {}),
    };
  }
  throw new Error(`Unsupported marketplace source kind: ${String(kind)}`);
}

function fingerprintForDescriptor(descriptor: MarketplaceSourceDescriptor): string {
  const input: MarketplaceSourceFingerprintInput = descriptor.kind === "url"
    ? { kind: "url", id: descriptor.id, url: descriptor.url }
    : descriptor.kind === "local"
      ? { kind: "local", id: descriptor.id, path: descriptor.path, indexPath: descriptor.indexPath }
      : {
          kind: "git",
          id: descriptor.id,
          gitUrl: descriptor.gitUrl,
          gitRef: descriptor.gitRef,
          indexPath: descriptor.indexPath,
        };
  return buildSourceFingerprint(input);
}

function toEffectiveCustom(descriptor: MarketplaceSourceDescriptor): EffectiveMarketplaceSource {
  return {
    ...descriptor,
    authority: "custom",
    mutable: true,
    sourceFingerprint: fingerprintForDescriptor(descriptor),
  };
}

function parseDurableFile(rawText: string): MarketplaceSourcesFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error("Malformed marketplace source registry JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new Error("Malformed marketplace source registry: root must be an object");
  }
  if (parsed.schemaVersion !== MARKETPLACE_SOURCES_SCHEMA_VERSION) {
    throw new Error(`Malformed marketplace source registry: unsupported schemaVersion ${String(parsed.schemaVersion)}`);
  }
  if (typeof parsed.revision !== "number" || !Number.isInteger(parsed.revision) || parsed.revision < 0) {
    throw new Error("Malformed marketplace source registry: revision must be a non-negative integer");
  }
  if (!Array.isArray(parsed.sources)) {
    throw new Error("Malformed marketplace source registry: sources must be an array");
  }

  const sources: MarketplaceSourceDescriptor[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.sources) {
    const descriptor = validateDescriptor(entry);
    if (seen.has(descriptor.id)) {
      throw new Error(`Malformed marketplace source registry: duplicate source id ${descriptor.id}`);
    }
    seen.add(descriptor.id);
    sources.push(descriptor);
  }

  return {
    schemaVersion: MARKETPLACE_SOURCES_SCHEMA_VERSION,
    revision: parsed.revision,
    sources,
  };
}

function sanitizeForRemote(source: EffectiveMarketplaceSource): EffectiveMarketplaceSource {
  if (source.kind === "local") {
    // Remote principals must not receive server-local paths; keep kind/id/name/status only.
    const { path: _path, ...rest } = source as any;
    return {
      ...rest,
      kind: "local",
      path: "[redacted]",
    } as EffectiveMarketplaceSource;
  }
  return { ...source };
}

export class PluginMarketplaceSourceRegistry {
  declare _path: string;
  declare _fs: MarketplaceSourceFsOps;
  declare _official: EffectiveMarketplaceSource;
  declare _legacy: EffectiveMarketplaceSource | null;
  declare _degraded: boolean;
  declare _degradedError: string | null;
  declare _cachedFile: MarketplaceSourcesFile | null;
  declare _lockHeld: boolean;

  constructor(options: {
    hanakoHome: string;
    fsOps?: MarketplaceSourceFsOps;
    officialUrl?: string;
    legacyOverlay?: LegacyMarketplaceOverlay | null;
  }) {
    if (!options?.hanakoHome) {
      throw new Error("PluginMarketplaceSourceRegistry requires hanakoHome");
    }
    this._path = path.join(options.hanakoHome, MARKETPLACE_SOURCES_FILENAME);
    this._fs = options.fsOps || defaultFsOps();
    this._official = createCompiledOfficialMarketplaceSource({ url: options.officialUrl });
    this._legacy = options.legacyOverlay ? createLegacySource(options.legacyOverlay) : null;
    this._degraded = false;
    this._degradedError = null;
    this._cachedFile = null;
    this._lockHeld = false;
  }

  get registryPath(): string {
    return this._path;
  }

  get degraded(): boolean {
    return this._degraded;
  }

  getRevision(): number {
    const loaded = this._loadDurable();
    if (!loaded.ok) return 0;
    return loaded.file.revision;
  }

  loadEffectiveSources(): {
    sources: EffectiveMarketplaceSource[];
    degraded: boolean;
    error?: string;
  } {
    const loaded = this._loadDurable();
    if (!loaded.ok) {
      return {
        sources: this._composeEffective([]),
        degraded: true,
        error: ("error" in loaded ? loaded.error : null) || "malformed registry",
      };
    }
    return {
      sources: this._composeEffective(loaded.file.sources),
      degraded: false,
    };
  }

  listSources(options: { forRemote?: boolean } = {}): EffectiveMarketplaceSource[] {
    const { sources } = this.loadEffectiveSources();
    if (options.forRemote) {
      return sources.map(sanitizeForRemote);
    }
    return sources.map((s) => ({ ...s }));
  }

  addSource(rawDescriptor: unknown, options: MutationOptions = {}): MutationResult {
    return this._withLockSync(() => {
      this._assertMutable();
      const descriptor = validateDescriptor(rawDescriptor);
      const loaded = this._loadDurable();
      if (!loaded.ok) {
        throw new Error(`Invalid registry (degraded): ${"error" in loaded ? loaded.error : "malformed registry"}`);
      }
      this._assertExpectedRevision(loaded.file.revision, options.expectedRevision);
      if (loaded.file.sources.some((s) => s.id === descriptor.id)) {
        throw new Error(`Marketplace source id already exists and is immutable in v1: ${descriptor.id}`);
      }
      const next: MarketplaceSourcesFile = {
        schemaVersion: MARKETPLACE_SOURCES_SCHEMA_VERSION,
        revision: loaded.file.revision + 1,
        sources: [...loaded.file.sources, descriptor],
      };
      this._persist(next);
      return {
        revision: next.revision,
        source: toEffectiveCustom(descriptor),
      };
    });
  }

  removeSource(marketplaceId: string, options: MutationOptions = {}): MutationResult {
    return this._withLockSync(() => {
      this._assertMutable();
      const id = assertMarketplaceId(marketplaceId);
      if (id === OFFICIAL_MARKETPLACE_ID) {
        throw new Error("Cannot remove the compiled official marketplace source");
      }
      if (this._legacy && id === this._legacy.id) {
        throw new Error("Cannot remove the legacy marketplace overlay via registry API");
      }
      const loaded = this._loadDurable();
      if (!loaded.ok) {
        throw new Error(`Invalid registry (degraded): ${"error" in loaded ? loaded.error : "malformed registry"}`);
      }
      this._assertExpectedRevision(loaded.file.revision, options.expectedRevision);
      const index = loaded.file.sources.findIndex((s) => s.id === id);
      if (index < 0) {
        throw new Error(`Marketplace source not found: ${id}`);
      }
      if (options.isSourceInUse?.(id)) {
        throw new Error(`PLUGIN_MARKETPLACE_SOURCE_IN_USE: marketplace source is in use: ${id}`);
      }
      const nextSources = loaded.file.sources.filter((s) => s.id !== id);
      const next: MarketplaceSourcesFile = {
        schemaVersion: MARKETPLACE_SOURCES_SCHEMA_VERSION,
        revision: loaded.file.revision + 1,
        sources: nextSources,
      };
      this._persist(next);
      return { revision: next.revision };
    });
  }

  _composeEffective(custom: MarketplaceSourceDescriptor[]): EffectiveMarketplaceSource[] {
    const sources: EffectiveMarketplaceSource[] = [this._official];
    for (const descriptor of custom) {
      sources.push(toEffectiveCustom(descriptor));
    }
    if (this._legacy) {
      sources.push({ ...this._legacy });
    }
    return sources;
  }

  _assertMutable() {
    if (this._degraded) {
      throw new Error(
        `Invalid registry (degraded mode; mutations disabled): ${this._degradedError || "malformed registry"}`,
      );
    }
  }

  _assertExpectedRevision(current: number, expected?: number) {
    if (expected === undefined) return;
    if (expected !== current) {
      throw new Error(`Marketplace registry revision conflict: expected ${expected}, current ${current}`);
    }
  }

  _loadDurable(): DurableLoadResult {
    if (this._degraded) {
      return { ok: false, degraded: true, error: this._degradedError || "malformed registry" };
    }
    if (this._cachedFile) {
      return { ok: true, file: structuredClone(this._cachedFile) };
    }
    if (!this._fs.existsSync(this._path)) {
      const empty = emptyFile();
      this._cachedFile = empty;
      return { ok: true, file: structuredClone(empty) };
    }
    try {
      const text = this._fs.readFileSync(this._path, "utf8");
      const file = parseDurableFile(text);
      this._cachedFile = file;
      return { ok: true, file: structuredClone(file) };
    } catch (err: any) {
      this._degraded = true;
      this._degradedError = err?.message || String(err);
      this._cachedFile = null;
      return { ok: false, degraded: true, error: this._degradedError };
    }
  }

  _persist(file: MarketplaceSourcesFile) {
    const dir = path.dirname(this._path);
    this._fs.mkdirSync(dir, { recursive: true });
    const payload = `${JSON.stringify(file, null, 2)}\n`;
    const tmp = `${this._path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      this._fs.writeFileSync(tmp, payload, "utf8");
      this._bestEffortFsync(tmp);
      this._fs.renameSync(tmp, this._path);
      this._bestEffortFsync(this._path);
      this._bestEffortFsyncDir(dir);
      this._cachedFile = structuredClone(file);
      this._degraded = false;
      this._degradedError = null;
    } catch (err) {
      try {
        this._fs.unlinkSync?.(tmp);
      } catch {
        /* ignore cleanup */
      }
      throw err;
    }
  }

  _bestEffortFsync(filePath: string) {
    const openSync = this._fs.openSync;
    const fsyncSync = this._fs.fsyncSync;
    const closeSync = this._fs.closeSync;
    if (!openSync || !fsyncSync || !closeSync) return;
    try {
      const fd = openSync(filePath, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* best-effort */
    }
  }

  _bestEffortFsyncDir(dirPath: string) {
    const openSync = this._fs.openSync;
    const fsyncSync = this._fs.fsyncSync;
    const closeSync = this._fs.closeSync;
    if (!openSync || !fsyncSync || !closeSync) return;
    try {
      const fd = openSync(dirPath, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* best-effort; Windows may not support directory fsync */
    }
  }

  /**
   * Serialize mutations on this registry instance. Synchronous mutations are
   * exclusive; nested re-entry throws. Concurrent microtask callers (e.g.
   * Promise.all of sync work) still see monotonic revisions because each
   * mutation completes before the next microtask runs.
   */
  _withLockSync<T>(fn: () => T): T {
    if (this._lockHeld) {
      throw new Error("Marketplace registry mutation already in progress on this instance");
    }
    this._lockHeld = true;
    try {
      return fn();
    } finally {
      this._lockHeld = false;
    }
  }
}

/**
 * Resolve optional legacy overlay from env, matching createDefaultPluginMarketplace overrides.
 * Env path/url replace the single catalog today; under multi-source they become a read-only legacy source.
 */
export function resolveLegacyMarketplaceOverlay(env: NodeJS.ProcessEnv = process.env): LegacyMarketplaceOverlay | null {
  const envPath = normalizeOptionalText(env.HANA_PLUGIN_MARKETPLACE_FILE);
  if (envPath) {
    return { kind: "local", path: envPath };
  }
  const envUrl = normalizeOptionalText(env.HANA_PLUGIN_MARKETPLACE_URL);
  if (envUrl && envUrl !== DEFAULT_OFFICIAL_PLUGIN_MARKETPLACE_URL) {
    return { kind: "url", url: envUrl };
  }
  return null;
}
