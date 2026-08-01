import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import {
  assertMarketplaceId,
  parseMarketplaceSkillRef,
  parsePluginMarketplaceRef,
  buildSourceFingerprint,
  DEFAULT_MARKETPLACE_INDEX_PATH,
  type MarketplaceSourceFingerprintInput,
} from "./plugin-marketplace-identity.ts";
import { DEFAULT_OFFICIAL_PLUGIN_MARKETPLACE_URL } from "./plugin-marketplace.ts";
import {
  validateClaudeCompatibilityBindings,
  type ClaudeCompatibilityBinding,
} from "./claude-compatibility.ts";
import { normalizeGitMarketplaceUrl } from "./plugin-marketplace-detect.ts";
import { assertPublicHttpsUrl } from "./plugin-marketplace-network-policy.ts";

export const OFFICIAL_MARKETPLACE_ID = "oh-plugins-official";
export const OFFICIAL_MARKETPLACE_NAME = "OH Plugins Official";
export const MARKETPLACE_SOURCES_FILENAME = "plugin-marketplaces.json";
export const MARKETPLACE_SOURCES_SCHEMA_VERSION = 1 as const;
export const MARKETPLACE_CONTROL_PLANE_SCHEMA_VERSION = 2 as const;
export const LEGACY_MARKETPLACE_ID = "legacy-override";

export type MarketplaceSourceKind = "url" | "local" | "git";

export type MarketplaceSourceDescriptor =
  | { id: string; name: string; kind: "url"; url: string; enabled?: boolean }
  | { id: string; name: string; kind: "local"; path: string; indexPath?: string; enabled?: boolean }
  | { id: string; name: string; kind: "git"; gitUrl: string; gitRef?: string; indexPath?: string; enabled?: boolean };

function derivedMarketplaceId(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
  return slug.length <= 64
    ? slug
    : `${slug.slice(0, 55).replace(/-+$/g, "")}-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

/**
 * Turn the compact Settings "source" field into the durable descriptor that
 * the registry owns.  This is intentionally an API-boundary convenience, not
 * a second persisted source format: the registry continues to store only
 * explicit, source-qualified descriptors.
 */
export function descriptorFromMarketplaceSourceInput(value: unknown): MarketplaceSourceDescriptor {
  const source = normalizeOptionalText(value);
  if (!source) throw new Error("Marketplace source is required");

  if (/^(?:git@|ssh:)/i.test(source)) {
    throw new Error("Marketplace Git sources must use a public HTTPS URL");
  }

  if (/^https?:\/\//i.test(source)) {
    const parsed = assertPublicHttpsUrl(source);

    const segments = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = segments.at(-1) || parsed.hostname;
    // Catalog locators conventionally name the JSON document. Every other
    // public HTTPS locator is treated as a Git remote so ordinary repository
    // URLs (which often omit a `.git` suffix) follow the Git acquisition path.
    const isGit = !/\.json$/i.test(parsed.pathname);
    if (isGit) {
      const normalized = normalizeGitMarketplaceUrl(source);
      const gitUrl = normalized.gitUrl;
      const gitUrlParts = new URL(gitUrl);
      const gitSegments = gitUrlParts.pathname.split("/").filter(Boolean);
      const gitName = (gitSegments.at(-1) || gitUrlParts.hostname).replace(/\.git$/i, "") || gitUrlParts.hostname;
      return {
        id: derivedMarketplaceId(
          [gitUrlParts.hostname, ...gitSegments.map((segment) => segment.replace(/\.git$/i, ""))].join("-"),
          "marketplace",
        ),
        name: gitName,
        kind: "git",
        gitUrl,
        gitRef: normalized.gitRef || "refs/heads/main",
        indexPath: normalized.suggestedIndexPath || DEFAULT_MARKETPLACE_INDEX_PATH,
      };
    }
    const readableName = lastSegment.replace(/\.json$/i, "") || parsed.hostname;
    return {
      id: derivedMarketplaceId(
        [parsed.hostname, ...segments.map((segment) => segment.replace(/\.json$/i, ""))].join("-"),
        "marketplace",
      ),
      name: readableName,
      kind: "url",
      url: source,
    };
  }

  if (/^[~/]|^\.\.?\//.test(source)) {
    const localName = path.basename(source.replace(/[\\/]+$/, "")) || "local-marketplace";
    const id = derivedMarketplaceId(source, "local-marketplace");
    return { id, name: localName, kind: "local", path: source };
  }

  throw new Error("Marketplace source must be a public HTTPS URL or server-local path");
}

export type MarketplaceSourceAuthority = "official" | "custom" | "legacy";

export type EffectiveMarketplaceSource = MarketplaceSourceDescriptor & {
  authority: MarketplaceSourceAuthority;
  mutable: boolean;
  enabled: boolean;
  sourceFingerprint: string;
};

export interface MarketplaceSourcesFile {
  schemaVersion: 1 | 2;
  revision: number;
  sources: MarketplaceSourceDescriptor[];
  activations?: MarketplaceControlPlaneActivations;
  claudeCompatibility?: { bindings?: ClaudeCompatibilityBinding[] };
}

export interface MarketplaceControlPlaneActivations {
  runtimePlugins?: Record<string, unknown>;
  marketplaceSkills?: Record<string, unknown>;
  /** Package-level gates keyed by pluginId@marketplaceId (parsePluginMarketplaceRef). */
  marketplaceSkillPackages?: Record<string, unknown>;
  agentSkillOverrides?: Record<string, Record<string, unknown>>;
  agentPluginAccess?: Record<string, Record<string, unknown>>;
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
  expectedDigest?: string;
  isSourceInUse?: SourceInUseCallback;
}

export interface MutationResult {
  revision: number;
  source?: EffectiveMarketplaceSource;
}

type DurableLoadResult =
  | { ok: true; file: MarketplaceSourcesFile; digest: string | null }
  | { ok: false; degraded: true; error: string; file?: MarketplaceSourcesFile; digest?: string | null };

export interface MarketplaceSourceRegistryStatus {
  schemaVersion: 1 | 2;
  effectiveSchemaVersion: 2;
  revision: number;
  digest: string;
  path: string;
  degraded: boolean;
  diagnostic: string | null;
  lastKnownGood: boolean;
}

export type MarketplaceControlPlaneDiagnosticSeverity = "error" | "warning" | "info";

export interface MarketplaceControlPlaneDiagnostic {
  severity: MarketplaceControlPlaneDiagnosticSeverity;
  code: string;
  path: string;
  message: string;
}

export interface MarketplaceControlPlaneDiagnosticReport {
  ok: boolean;
  degraded: boolean;
  path: string;
  digest: string | null;
  file: MarketplaceSourcesFile | null;
  diagnostics: MarketplaceControlPlaneDiagnostic[];
  summary: {
    schemaVersion: 1 | 2 | null;
    effectiveSchemaVersion: 2;
    revision: number | null;
    sourceCount: number;
    enabledSources: string[];
    disabledSources: string[];
    runtimePluginActivations: number;
    marketplaceSkillActivations: number;
    marketplaceSkillPackageActivations: number;
    agentSkillOverrides: number;
    agentPluginAccessRecords: number;
  };
}

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
    enabled: descriptor.enabled !== false,
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
      enabled: descriptor.enabled !== false,
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
    enabled: descriptor.enabled !== false,
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
    return { id, name, kind: "url", url, ...(raw.enabled === false ? { enabled: false } : {}) };
  }
  if (kind === "local") {
    const localPath = normalizeOptionalText(raw.path);
    if (!localPath) throw new Error("Local marketplace source requires path");
    const indexPath = normalizeOptionalText(raw.indexPath) || undefined;
    return indexPath
      ? { id, name, kind: "local", path: localPath, indexPath, ...(raw.enabled === false ? { enabled: false } : {}) }
      : { id, name, kind: "local", path: localPath, ...(raw.enabled === false ? { enabled: false } : {}) };
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
      ...(raw.enabled === false ? { enabled: false } : {}),
    };
  }
  throw new Error(`Unsupported marketplace source kind: ${String(kind)}`);
}

function validateActivationKey(
  key: string,
  kind: "runtimePlugins" | "marketplaceSkills" | "marketplaceSkillPackages",
) {
  if (kind === "runtimePlugins" || kind === "marketplaceSkillPackages") {
    try {
      parsePluginMarketplaceRef(key);
    } catch {
      throw new Error(
        kind === "marketplaceSkillPackages"
          ? `Malformed marketplace source registry: marketplace skill package activation key must be source-qualified (pluginId@marketplaceId): ${key}`
          : `Malformed marketplace source registry: runtime plugin activation key must be source-qualified: ${key}`,
      );
    }
    return;
  }
  try {
    parseMarketplaceSkillRef(key);
  } catch {
    throw new Error(`Malformed marketplace source registry: marketplace skill activation key must be source-qualified: ${key}`);
  }
}

function validateActivationEntry(value: unknown, label: string) {
  if (typeof value === "boolean") return;
  if (!isPlainObject(value)) {
    throw new Error(`Malformed marketplace source registry: ${label} must be a boolean or object`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`Malformed marketplace source registry: ${label}.enabled must be a boolean`);
  }
}

function validateAgentPluginAccessEntry(value: unknown, label: string) {
  validateActivationEntry(value, label);
  if (!isPlainObject(value)) return;
  if (value.contributions !== undefined) {
    if (!Array.isArray(value.contributions) || value.contributions.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`Malformed marketplace source registry: ${label}.contributions must be an array of strings`);
    }
  }
}

function validateActivationRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`Malformed marketplace source registry: ${label} must be an object`);
  }
  return { ...value };
}

function validateActivationMap(
  value: unknown,
  kind: "runtimePlugins" | "marketplaceSkills" | "marketplaceSkillPackages",
): Record<string, unknown> | undefined {
  const map = validateActivationRecord(value, `activations.${kind}`);
  if (!map) return undefined;
  for (const [key, entry] of Object.entries(map)) {
    validateActivationKey(key, kind);
    validateActivationEntry(entry, `activations.${kind}.${key}`);
  }
  return map;
}

function validateActivations(raw: unknown): MarketplaceControlPlaneActivations | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error("Malformed marketplace source registry: activations must be an object");
  }
  const out: MarketplaceControlPlaneActivations = {};
  const runtimePlugins = validateActivationMap(raw.runtimePlugins, "runtimePlugins");
  if (runtimePlugins) out.runtimePlugins = runtimePlugins;
  const marketplaceSkills = validateActivationMap(raw.marketplaceSkills, "marketplaceSkills");
  if (marketplaceSkills) out.marketplaceSkills = marketplaceSkills;
  const marketplaceSkillPackages = validateActivationMap(raw.marketplaceSkillPackages, "marketplaceSkillPackages");
  if (marketplaceSkillPackages) out.marketplaceSkillPackages = marketplaceSkillPackages;
  const agentSkillOverrides = validateActivationRecord(raw.agentSkillOverrides, "activations.agentSkillOverrides");
  if (agentSkillOverrides) {
    const normalized: Record<string, Record<string, unknown>> = {};
    for (const [agentId, entries] of Object.entries(agentSkillOverrides)) {
      if (!isPlainObject(entries)) {
        throw new Error(`Malformed marketplace source registry: agentSkillOverrides.${agentId} must be an object`);
      }
      for (const [key, value] of Object.entries(entries)) {
        validateActivationKey(key, "marketplaceSkills");
        validateActivationEntry(value, `activations.agentSkillOverrides.${agentId}.${key}`);
      }
      normalized[agentId] = { ...entries };
    }
    out.agentSkillOverrides = normalized;
  }
  const agentPluginAccess = validateActivationRecord(raw.agentPluginAccess, "activations.agentPluginAccess");
  if (agentPluginAccess) {
    const normalized: Record<string, Record<string, unknown>> = {};
    for (const [agentId, entries] of Object.entries(agentPluginAccess)) {
      if (!isPlainObject(entries)) {
        throw new Error(`Malformed marketplace source registry: agentPluginAccess.${agentId} must be an object`);
      }
      for (const [key, value] of Object.entries(entries)) {
        validateActivationKey(key, "runtimePlugins");
        validateAgentPluginAccessEntry(value, `activations.agentPluginAccess.${agentId}.${key}`);
      }
      normalized[agentId] = { ...entries };
    }
    out.agentPluginAccess = normalized;
  }
  return out;
}

function validateClaudeCompatibility(raw: unknown): { bindings?: ClaudeCompatibilityBinding[] } | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error("Malformed marketplace source registry: claudeCompatibility must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (key !== "bindings") {
      throw new Error(`Malformed marketplace source registry: unsupported claudeCompatibility field: ${key}`);
    }
  }
  if (raw.bindings !== undefined && !Array.isArray(raw.bindings)) {
    throw new Error("Malformed marketplace source registry: claudeCompatibility.bindings must be an array");
  }
  return {
    ...(Array.isArray(raw.bindings) ? { bindings: validateClaudeCompatibilityBindings(raw.bindings) } : {}),
  };
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
    enabled: descriptor.enabled !== false,
    sourceFingerprint: fingerprintForDescriptor(descriptor),
  };
}

const ROOT_FIELDS_BY_SCHEMA: Record<1 | 2, Set<string>> = {
  1: new Set(["schemaVersion", "revision", "sources"]),
  2: new Set(["schemaVersion", "revision", "sources", "activations", "claudeCompatibility"]),
};

const ACTIVATION_ROOT_FIELDS = new Set([
  "runtimePlugins",
  "marketplaceSkills",
  "marketplaceSkillPackages",
  "agentSkillOverrides",
  "agentPluginAccess",
]);

function pushDiagnostic(
  diagnostics: MarketplaceControlPlaneDiagnostic[],
  severity: MarketplaceControlPlaneDiagnosticSeverity,
  code: string,
  diagnosticPath: string,
  message: string,
) {
  diagnostics.push({ severity, code, path: diagnosticPath, message });
}

function describeRecordCount(record: unknown): number {
  return isPlainObject(record) ? Object.keys(record).length : 0;
}

function activationSourceIds(activations: MarketplaceControlPlaneActivations | undefined): string[] {
  const ids = new Set<string>();
  for (const key of Object.keys(activations?.runtimePlugins || {})) {
    try {
      ids.add(parsePluginMarketplaceRef(key).marketplaceId);
    } catch {
      /* strict validation records the malformed key */
    }
  }
  for (const key of Object.keys(activations?.marketplaceSkills || {})) {
    try {
      ids.add(parseMarketplaceSkillRef(key).marketplaceId);
    } catch {
      /* strict validation records the malformed key */
    }
  }
  for (const key of Object.keys(activations?.marketplaceSkillPackages || {})) {
    try {
      ids.add(parsePluginMarketplaceRef(key).marketplaceId);
    } catch {
      /* strict validation records the malformed key */
    }
  }
  for (const entries of Object.values(activations?.agentSkillOverrides || {})) {
    for (const key of Object.keys(entries || {})) {
      try {
        ids.add(parseMarketplaceSkillRef(key).marketplaceId);
      } catch {
        /* strict validation records the malformed key */
      }
    }
  }
  for (const entries of Object.values(activations?.agentPluginAccess || {})) {
    for (const key of Object.keys(entries || {})) {
      try {
        ids.add(parsePluginMarketplaceRef(key).marketplaceId);
      } catch {
        /* strict validation records the malformed key */
      }
    }
  }
  return [...ids].sort();
}

function summarizeFile(file: MarketplaceSourcesFile | null): MarketplaceControlPlaneDiagnosticReport["summary"] {
  const sources = file?.sources || [];
  const activations = file?.activations;
  return {
    schemaVersion: file?.schemaVersion || null,
    effectiveSchemaVersion: MARKETPLACE_CONTROL_PLANE_SCHEMA_VERSION,
    revision: typeof file?.revision === "number" ? file.revision : null,
    sourceCount: sources.length,
    enabledSources: sources.filter((source) => source.enabled !== false).map((source) => source.id),
    disabledSources: sources.filter((source) => source.enabled === false).map((source) => source.id),
    runtimePluginActivations: describeRecordCount(activations?.runtimePlugins),
    marketplaceSkillActivations: describeRecordCount(activations?.marketplaceSkills),
    marketplaceSkillPackageActivations: describeRecordCount(activations?.marketplaceSkillPackages),
    agentSkillOverrides: describeRecordCount(activations?.agentSkillOverrides),
    agentPluginAccessRecords: Object.values(activations?.agentPluginAccess || {})
      .reduce((sum, entries) => sum + describeRecordCount(entries), 0),
  };
}

export function diagnoseMarketplaceSourcesText(
  rawText: string,
  options: { path?: string } = {},
): MarketplaceControlPlaneDiagnosticReport {
  const diagnostics: MarketplaceControlPlaneDiagnostic[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    pushDiagnostic(
      diagnostics,
      "error",
      "PLUGIN_MARKETPLACE_CONFIG_JSON_INVALID",
      "$",
      "Marketplace source registry JSON is invalid.",
    );
    return {
      ok: false,
      degraded: true,
      path: options.path || MARKETPLACE_SOURCES_FILENAME,
      digest: digestForText(rawText),
      file: null,
      diagnostics,
      summary: summarizeFile(null),
    };
  }

  if (!isPlainObject(parsed)) {
    pushDiagnostic(
      diagnostics,
      "error",
      "PLUGIN_MARKETPLACE_CONFIG_ROOT_INVALID",
      "$",
      "Marketplace source registry root must be an object.",
    );
    return {
      ok: false,
      degraded: true,
      path: options.path || MARKETPLACE_SOURCES_FILENAME,
      digest: digestForText(rawText),
      file: null,
      diagnostics,
      summary: summarizeFile(null),
    };
  }

  const schemaVersion = parsed.schemaVersion;
  if (
    schemaVersion !== MARKETPLACE_SOURCES_SCHEMA_VERSION
    && schemaVersion !== MARKETPLACE_CONTROL_PLANE_SCHEMA_VERSION
  ) {
    pushDiagnostic(
      diagnostics,
      "error",
      "PLUGIN_MARKETPLACE_CONFIG_SCHEMA_UNSUPPORTED",
      "$.schemaVersion",
      `Unsupported marketplace source registry schemaVersion: ${String(schemaVersion)}.`,
    );
  } else {
    const allowed = ROOT_FIELDS_BY_SCHEMA[schemaVersion];
    for (const key of Object.keys(parsed)) {
      if (!allowed.has(key)) {
        pushDiagnostic(
          diagnostics,
          "warning",
          "PLUGIN_MARKETPLACE_CONFIG_FIELD_UNSUPPORTED",
          `$.${key}`,
          `Unsupported marketplace source registry field is ignored: ${key}.`,
        );
      }
    }
  }

  if (isPlainObject(parsed.activations)) {
    for (const key of Object.keys(parsed.activations)) {
      if (!ACTIVATION_ROOT_FIELDS.has(key)) {
        pushDiagnostic(
          diagnostics,
          "warning",
          "PLUGIN_MARKETPLACE_ACTIVATION_FIELD_UNSUPPORTED",
          `$.activations.${key}`,
          `Unsupported activation field is ignored: ${key}.`,
        );
      }
    }
  }

  let file: MarketplaceSourcesFile | null = null;
  try {
    file = parseDurableFile(rawText);
  } catch (err: any) {
    pushDiagnostic(
      diagnostics,
      "error",
      "PLUGIN_MARKETPLACE_CONFIG_STRICT_INVALID",
      "$",
      err?.message || String(err),
    );
  }

  if (file) {
    const seenLocations = new Map<string, string>();
    for (let index = 0; index < file.sources.length; index += 1) {
      const source = file.sources[index];
      const locationKey = source.kind === "url"
        ? `url:${source.url}`
        : source.kind === "local"
          ? `local:${source.path}:${source.indexPath || DEFAULT_MARKETPLACE_INDEX_PATH}`
          : `git:${source.gitUrl}:${source.gitRef || ""}:${source.indexPath || DEFAULT_MARKETPLACE_INDEX_PATH}`;
      const previousId = seenLocations.get(locationKey);
      if (previousId && previousId !== source.id) {
        pushDiagnostic(
          diagnostics,
          "warning",
          "PLUGIN_MARKETPLACE_SOURCE_LOCATION_CONFLICT",
          `$.sources[${index}]`,
          `Marketplace source ${source.id} points at the same location as ${previousId}.`,
        );
      }
      seenLocations.set(locationKey, source.id);
    }

    const sourceIds = new Set([
      OFFICIAL_MARKETPLACE_ID,
      ...file.sources.map((source) => source.id),
    ]);
    const activationIds = activationSourceIds(file.activations);
    for (const marketplaceId of activationIds) {
      if (!sourceIds.has(marketplaceId)) {
        pushDiagnostic(
          diagnostics,
          "error",
          "PLUGIN_MARKETPLACE_ACTIVATION_SOURCE_MISSING",
          "$.activations",
          `Activation/access records reference unregistered marketplace source: ${marketplaceId}.`,
        );
      }
    }
    for (const source of file.sources) {
      if (source.enabled === false) {
        pushDiagnostic(
          diagnostics,
          "info",
          "PLUGIN_MARKETPLACE_SOURCE_DISABLED",
          `$.sources.${source.id}.enabled`,
          `Marketplace source is disabled: ${source.id}.`,
        );
      }
    }
  }

  const hasErrors = diagnostics.some((item) => item.severity === "error");
  return {
    ok: !hasErrors,
    degraded: hasErrors,
    path: options.path || MARKETPLACE_SOURCES_FILENAME,
    digest: digestForText(rawText),
    file: hasErrors ? null : file,
    diagnostics,
    summary: summarizeFile(hasErrors ? null : file),
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
  if (
    parsed.schemaVersion !== MARKETPLACE_SOURCES_SCHEMA_VERSION
    && parsed.schemaVersion !== MARKETPLACE_CONTROL_PLANE_SCHEMA_VERSION
  ) {
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

  const activations = parsed.schemaVersion === MARKETPLACE_CONTROL_PLANE_SCHEMA_VERSION
    ? validateActivations(parsed.activations)
    : undefined;
  const claudeCompatibility = parsed.schemaVersion === MARKETPLACE_CONTROL_PLANE_SCHEMA_VERSION
    ? validateClaudeCompatibility(parsed.claudeCompatibility)
    : undefined;

  if (activations) {
    const registeredSources = new Set([
      OFFICIAL_MARKETPLACE_ID,
      ...sources.map((source) => source.id),
    ]);
    for (const marketplaceId of activationSourceIds(activations)) {
      if (!registeredSources.has(marketplaceId)) {
        throw new Error(
          `Malformed marketplace source registry: activation/access records reference unregistered marketplace source: ${marketplaceId}`,
        );
      }
    }
  }

  return {
    schemaVersion: parsed.schemaVersion,
    revision: parsed.revision,
    sources,
    ...(parsed.schemaVersion === MARKETPLACE_CONTROL_PLANE_SCHEMA_VERSION
      ? {
          ...(activations ? { activations } : {}),
          ...(claudeCompatibility ? { claudeCompatibility } : {}),
        }
      : {}),
  };
}

function digestForText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function digestForFile(file: MarketplaceSourcesFile): string {
  return digestForText(`${JSON.stringify(file, null, 2)}\n`);
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
  declare _cachedDigest: string | null;
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
    this._cachedDigest = null;
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
    if (!loaded.ok && !loaded.file) return 0;
    return loaded.file.revision;
  }

  getStatus(): MarketplaceSourceRegistryStatus {
    const loaded = this._loadDurable();
    if ("error" in loaded) {
      const file = loaded.file || emptyFile();
      return {
        schemaVersion: file.schemaVersion,
        effectiveSchemaVersion: MARKETPLACE_CONTROL_PLANE_SCHEMA_VERSION,
        revision: file.revision,
        digest: loaded.digest || digestForFile(file),
        path: this._path,
        degraded: true,
        diagnostic: loaded.error,
        lastKnownGood: !!loaded.file,
      };
    }
    const file = loaded.file;
    const digest = loaded.digest || digestForFile(file);
    return {
      schemaVersion: file.schemaVersion,
      effectiveSchemaVersion: MARKETPLACE_CONTROL_PLANE_SCHEMA_VERSION,
      revision: file.revision,
      digest,
      path: this._path,
      degraded: false,
      diagnostic: null,
      lastKnownGood: false,
    };
  }

  loadEffectiveSources(): {
    sources: EffectiveMarketplaceSource[];
    degraded: boolean;
    error?: string;
  } {
    const loaded = this._loadDurable();
    if (!loaded.ok) {
      return {
        sources: this._composeEffective(loaded.file?.sources || []),
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

  getControlPlaneActivations(): MarketplaceControlPlaneActivations {
    const loaded = this._loadDurable();
    if (!loaded.ok) return structuredClone(loaded.file?.activations || {});
    return structuredClone(loaded.file.activations || {});
  }

  getClaudeCompatibilityBindings(): ClaudeCompatibilityBinding[] {
    const loaded = this._loadDurable();
    const bindings = loaded.file?.claudeCompatibility?.bindings;
    return structuredClone(bindings || []);
  }

  diagnoseControlPlane(): MarketplaceControlPlaneDiagnosticReport {
    if (!this._fs.existsSync(this._path)) {
      const empty = emptyFile();
      return {
        ok: true,
        degraded: false,
        path: this._path,
        digest: digestForFile(empty),
        file: structuredClone(empty),
        diagnostics: [],
        summary: summarizeFile(empty),
      };
    }
    let text = "";
    try {
      text = this._fs.readFileSync(this._path, "utf8");
    } catch (err: any) {
      const diagnostics: MarketplaceControlPlaneDiagnostic[] = [];
      pushDiagnostic(
        diagnostics,
        "error",
        "PLUGIN_MARKETPLACE_CONFIG_READ_FAILED",
        "$",
        err?.message || String(err),
      );
      return {
        ok: false,
        degraded: true,
        path: this._path,
        digest: null,
        file: null,
        diagnostics,
        summary: summarizeFile(null),
      };
    }
    return diagnoseMarketplaceSourcesText(text, { path: this._path });
  }

  setControlPlaneActivations(
    rawActivations: unknown,
    options: MutationOptions = {},
  ): { revision: number; activations: MarketplaceControlPlaneActivations } {
    return this._withLockSync(() => {
      this._assertMutable();
      const loaded = this._loadDurable();
      if (!loaded.ok) {
        throw new Error(`Invalid registry (degraded): ${"error" in loaded ? loaded.error : "malformed registry"}`);
      }
      this._assertExpectedRevision(loaded.file.revision, options.expectedRevision);
      this._assertExpectedDigest(loaded.digest, options.expectedDigest);
      const candidate: MarketplaceSourcesFile = {
        ...loaded.file,
        schemaVersion: MARKETPLACE_CONTROL_PLANE_SCHEMA_VERSION,
        revision: loaded.file.revision + 1,
        sources: loaded.file.sources,
        activations: rawActivations === undefined ? {} : rawActivations as MarketplaceControlPlaneActivations,
      };
      const payload = `${JSON.stringify(candidate, null, 2)}\n`;
      const diagnostics = diagnoseMarketplaceSourcesText(payload, { path: this._path });
      if (!diagnostics.ok || !diagnostics.file) {
        throw new Error(
          `Invalid marketplace control-plane activations: ${
            diagnostics.diagnostics.find((item) => item.severity === "error")?.message || "invalid activation records"
          }`,
        );
      }
      this._persist(diagnostics.file);
      return {
        revision: diagnostics.file.revision,
        activations: structuredClone(diagnostics.file.activations || {}),
      };
    });
  }

  setClaudeCompatibilityBindings(
    rawBindings: unknown,
    options: MutationOptions = {},
  ): { revision: number; bindings: ClaudeCompatibilityBinding[] } {
    return this._withLockSync(() => {
      this._assertMutable();
      const bindings = validateClaudeCompatibilityBindings(rawBindings);
      const loaded = this._loadDurable();
      if (!loaded.ok) {
        throw new Error(`Invalid registry (degraded): ${"error" in loaded ? loaded.error : "malformed registry"}`);
      }
      this._assertExpectedRevision(loaded.file.revision, options.expectedRevision);
      this._assertExpectedDigest(loaded.digest, options.expectedDigest);
      const next: MarketplaceSourcesFile = {
        ...loaded.file,
        schemaVersion: MARKETPLACE_CONTROL_PLANE_SCHEMA_VERSION,
        revision: loaded.file.revision + 1,
        claudeCompatibility: { bindings },
      };
      this._persist(next);
      return { revision: next.revision, bindings: structuredClone(bindings) };
    });
  }

  setSourceEnabled(marketplaceId: string, enabled: boolean, options: MutationOptions = {}): MutationResult {
    return this._withLockSync(() => {
      this._assertMutable();
      const id = assertMarketplaceId(marketplaceId);
      if (id === OFFICIAL_MARKETPLACE_ID) {
        throw new Error("Cannot disable the compiled official marketplace source");
      }
      if (this._legacy && id === this._legacy.id) {
        throw new Error("Cannot mutate the legacy marketplace overlay via registry API");
      }
      const loaded = this._loadDurable();
      if (!loaded.ok) {
        throw new Error(`Invalid registry (degraded): ${"error" in loaded ? loaded.error : "malformed registry"}`);
      }
      this._assertExpectedRevision(loaded.file.revision, options.expectedRevision);
      this._assertExpectedDigest(loaded.digest, options.expectedDigest);
      const sources = loaded.file.sources.map((source) => (
        source.id === id
          ? { ...source, ...(enabled ? { enabled: undefined } : { enabled: false }) } as MarketplaceSourceDescriptor
          : source
      ));
      if (!loaded.file.sources.some((source) => source.id === id)) {
        throw new Error(`Marketplace source not found: ${id}`);
      }
      const next: MarketplaceSourcesFile = {
        ...loaded.file,
        schemaVersion: MARKETPLACE_CONTROL_PLANE_SCHEMA_VERSION,
        revision: loaded.file.revision + 1,
        sources,
      };
      this._persist(next);
      return {
        revision: next.revision,
        source: toEffectiveCustom(sources.find((source) => source.id === id)!),
      };
    });
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
      this._assertExpectedDigest(loaded.digest, options.expectedDigest);
      if (loaded.file.sources.some((s) => s.id === descriptor.id)) {
        throw new Error(`Marketplace source id already exists and is immutable in v1: ${descriptor.id}`);
      }
      const next: MarketplaceSourcesFile = {
        ...loaded.file,
        schemaVersion: loaded.file.schemaVersion,
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
      this._assertExpectedDigest(loaded.digest, options.expectedDigest);
      const index = loaded.file.sources.findIndex((s) => s.id === id);
      if (index < 0) {
        throw new Error(`Marketplace source not found: ${id}`);
      }
      if (options.isSourceInUse?.(id)) {
        throw new Error(`PLUGIN_MARKETPLACE_SOURCE_IN_USE: marketplace source is in use: ${id}`);
      }
      const nextSources = loaded.file.sources.filter((s) => s.id !== id);
      const next: MarketplaceSourcesFile = {
        ...loaded.file,
        schemaVersion: loaded.file.schemaVersion,
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
      const loaded = this._loadDurable();
      if (loaded.ok) return;
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

  _assertExpectedDigest(current: string | null, expected?: string) {
    if (expected === undefined) return;
    if (!current || expected !== current) {
      throw new Error(`Marketplace registry digest conflict: expected ${expected}, current ${current || "unknown"}`);
    }
  }

  _loadDurable(): DurableLoadResult {
    if (this._cachedFile) {
      // Direct operator edits are expected; always re-read below when the file exists.
    }
    if (!this._fs.existsSync(this._path)) {
      const empty = emptyFile();
      this._cachedFile = empty;
      this._cachedDigest = digestForFile(empty);
      this._degraded = false;
      this._degradedError = null;
      return { ok: true, file: structuredClone(empty), digest: this._cachedDigest };
    }
    try {
      const text = this._fs.readFileSync(this._path, "utf8");
      const file = parseDurableFile(text);
      const digest = digestForText(text);
      this._cachedFile = file;
      this._cachedDigest = digest;
      this._degraded = false;
      this._degradedError = null;
      return { ok: true, file: structuredClone(file), digest };
    } catch (err: any) {
      this._degraded = true;
      this._degradedError = err?.message || String(err);
      return {
        ok: false,
        degraded: true,
        error: this._degradedError,
        ...(this._cachedFile ? { file: structuredClone(this._cachedFile) } : {}),
        ...(this._cachedDigest ? { digest: this._cachedDigest } : {}),
      };
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
      this._cachedDigest = digestForText(payload);
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
