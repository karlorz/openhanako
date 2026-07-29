import { createHash } from "crypto";
import { assertMarketplaceId, assertPluginId } from "./plugin-marketplace-identity.ts";

export const MARKETPLACE_CATALOG_SCHEMA_VERSION = 1 as const;
export const MAX_MARKETPLACE_PLUGINS = 500;
export const MAX_MARKETPLACE_VERSIONS_PER_PLUGIN = 50;
export const MAX_MARKETPLACE_STRING_LENGTH = 2048;
export const MAX_MARKETPLACE_DESCRIPTION_LENGTH = 8192;
export const MAX_MARKETPLACE_CATALOG_BYTES = 2 * 1024 * 1024;

const ROOT_ALLOWED = new Set(["schemaVersion", "plugins"]);
const PLUGIN_ALLOWED = new Set([
  "schemaVersion",
  "id",
  "name",
  "publisher",
  "version",
  "description",
  "license",
  "categories",
  "keywords",
  "homepage",
  "repository",
  "compatibility",
  "trust",
  "permissions",
  "contributions",
  "distribution",
  "versions",
  "install",
  "screenshots",
  "readme",
  "readmeMarkdown",
  "readmePath",
  "readmeUrl",
]);
const VERSION_ALLOWED = new Set(["version", "compatibility", "distribution"]);
const DISTRIBUTION_RELEASE_ALLOWED = new Set(["kind", "packageUrl", "sha256"]);
const DISTRIBUTION_SOURCE_ALLOWED = new Set(["kind", "path"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export type MarketplaceSourceKindForSchema = "url" | "local" | "git";

export interface TaggedMarketplacePlugin {
  schemaVersion: number;
  id: string;
  marketplaceId: string;
  name: string;
  publisher: string;
  version: string;
  description: string;
  license: string | null;
  categories: string[];
  keywords: string[];
  homepage: string | null;
  repository: string | null;
  compatibility: Record<string, unknown>;
  trust: "restricted" | "full-access";
  permissions: string[];
  contributions: string[];
  distribution: MarketplaceDistribution | null;
  versions: MarketplaceVersionRecord[];
  install: Record<string, unknown>;
  screenshots: string[];
  readme: string | null;
  readmePath: string | null;
  readmeUrl: string | null;
}

export type MarketplaceDistribution =
  | { kind: "release"; packageUrl: string; sha256: string }
  | { kind: "source"; path: string };

export interface MarketplaceVersionRecord {
  version: string;
  compatibility: Record<string, unknown>;
  distribution: MarketplaceDistribution | null;
}

export interface ParsedMarketplaceCatalog {
  schemaVersion: 1;
  plugins: TaggedMarketplacePlugin[];
  catalogSha256: string;
  rawCanonicalJson: string;
}

export interface ParseMarketplaceCatalogOptions {
  marketplaceId: string;
  sourceKind: MarketplaceSourceKindForSchema;
}

/**
 * Strict catalog parse. Prefer string input so duplicate JSON keys are rejected.
 * Object input is validated structurally but cannot detect pre-collapsed duplicate keys.
 */
export function parseMarketplaceCatalogStrict(
  input: string | unknown,
  options: ParseMarketplaceCatalogOptions,
): ParsedMarketplaceCatalog {
  const marketplaceId = assertMarketplaceId(options.marketplaceId);
  const sourceKind = options.sourceKind;
  if (sourceKind !== "url" && sourceKind !== "local" && sourceKind !== "git") {
    throw new Error(`Unsupported source kind for catalog parse: ${String(sourceKind)}`);
  }

  let rawText: string;
  let root: unknown;

  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_MARKETPLACE_CATALOG_BYTES) {
      throw new Error(`Marketplace catalog exceeds ${MAX_MARKETPLACE_CATALOG_BYTES} bytes`);
    }
    rawText = input;
    root = parseJsonRejectDuplicateKeys(input);
  } else {
    root = input;
    rawText = JSON.stringify(input);
    if (Buffer.byteLength(rawText, "utf8") > MAX_MARKETPLACE_CATALOG_BYTES) {
      throw new Error(`Marketplace catalog exceeds ${MAX_MARKETPLACE_CATALOG_BYTES} bytes`);
    }
  }

  if (!isPlainObject(root)) {
    throw new Error("Marketplace catalog root must be a plain object");
  }
  assertAllowedKeys(root, ROOT_ALLOWED, "catalog root");
  if (root.schemaVersion !== MARKETPLACE_CATALOG_SCHEMA_VERSION) {
    throw new Error(`Unsupported marketplace catalog schemaVersion: ${String(root.schemaVersion)}`);
  }
  if (!Array.isArray(root.plugins)) {
    throw new Error("Marketplace catalog plugins must be an array");
  }
  if (root.plugins.length > MAX_MARKETPLACE_PLUGINS) {
    throw new Error(`Marketplace catalog exceeds ${MAX_MARKETPLACE_PLUGINS} plugins`);
  }

  const plugins: TaggedMarketplacePlugin[] = [];
  const seenIds = new Set<string>();

  for (const entry of root.plugins) {
    const plugin = parsePlugin(entry, { marketplaceId, sourceKind });
    if (seenIds.has(plugin.id)) {
      throw new Error(`Duplicate plugin id in marketplace catalog: ${plugin.id}`);
    }
    seenIds.add(plugin.id);
    plugins.push(plugin);
  }

  const catalogSha256 = createHash("sha256").update(rawText).digest("hex");
  return {
    schemaVersion: 1,
    plugins,
    catalogSha256,
    rawCanonicalJson: rawText,
  };
}

/** JSON.parse with duplicate object-key rejection. */
export function parseJsonRejectDuplicateKeys(text: string): unknown {
  let i = 0;
  const len = text.length;

  function skipWs() {
    while (i < len && /\s/.test(text[i])) i++;
  }

  function parseValue(): unknown {
    skipWs();
    if (i >= len) throw new Error("Unexpected end of JSON");
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "t" || c === "f" || c === "n" || c === "-" || (c >= "0" && c <= "9")) {
      return parsePrimitive();
    }
    throw new Error(`Unexpected JSON token at ${i}`);
  }

  function parseObject(): Record<string, unknown> {
    i++;
    const obj: Record<string, unknown> = {};
    const seen = new Set<string>();
    skipWs();
    if (text[i] === "}") {
      i++;
      return obj;
    }
    while (i < len) {
      skipWs();
      if (text[i] !== '"') throw new Error("Expected string key in JSON object");
      const key = parseString();
      if (seen.has(key)) {
        throw new Error(`Duplicate JSON object key: ${key}`);
      }
      seen.add(key);
      skipWs();
      if (text[i] !== ":") throw new Error("Expected ':' after JSON object key");
      i++;
      obj[key] = parseValue();
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return obj;
      }
      throw new Error("Expected ',' or '}' in JSON object");
    }
    throw new Error("Unterminated JSON object");
  }

  function parseArray(): unknown[] {
    i++;
    const arr: unknown[] = [];
    skipWs();
    if (text[i] === "]") {
      i++;
      return arr;
    }
    while (i < len) {
      arr.push(parseValue());
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return arr;
      }
      throw new Error("Expected ',' or ']' in JSON array");
    }
    throw new Error("Unterminated JSON array");
  }

  function parseString(): string {
    let result = "";
    i++;
    while (i < len) {
      const c = text[i];
      if (c === '"') {
        i++;
        return result;
      }
      if (c === "\\") {
        i++;
        if (i >= len) throw new Error("Unterminated escape in JSON string");
        const e = text[i];
        const map: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (e === "u") {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("Invalid unicode escape");
          result += String.fromCharCode(parseInt(hex, 16));
          i += 5;
          continue;
        }
        if (!(e in map)) throw new Error("Invalid escape in JSON string");
        result += map[e];
        i++;
        continue;
      }
      result += c;
      i++;
    }
    throw new Error("Unterminated JSON string");
  }

  function parsePrimitive(): unknown {
    const start = i;
    while (i < len && /[0-9a-zA-Z+.\-eE]/.test(text[i])) i++;
    const token = text.slice(start, i);
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
      throw new Error(`Invalid JSON primitive: ${token}`);
    }
    return Number(token);
  }

  const value = parseValue();
  skipWs();
  if (i !== len) throw new Error("Unexpected trailing data in JSON");
  return value;
}

function parsePlugin(
  raw: unknown,
  ctx: { marketplaceId: string; sourceKind: MarketplaceSourceKindForSchema },
): TaggedMarketplacePlugin {
  if (!isPlainObject(raw)) {
    throw new Error("Marketplace plugin entry must be an object");
  }
  assertAllowedKeys(raw, PLUGIN_ALLOWED, "plugin");
  if (raw.schemaVersion != null && raw.schemaVersion !== 1) {
    throw new Error(`Unsupported plugin schemaVersion: ${String(raw.schemaVersion)}`);
  }

  const id = assertPluginId(raw.id);
  const name = requireBoundedString(raw.name, "plugin.name") || id;
  const publisher = requireBoundedString(raw.publisher, "plugin.publisher") || "unknown";
  const description = optionalBoundedString(raw.description, "plugin.description", MAX_MARKETPLACE_DESCRIPTION_LENGTH) || "";
  const versionTop = optionalBoundedString(raw.version, "plugin.version");
  const distribution = raw.distribution === undefined
    ? null
    : parseDistribution(raw.distribution, ctx);
  const versions = parseVersions(raw, distribution, ctx);
  const latest = versions[0] || null;

  return {
    schemaVersion: 1,
    id,
    marketplaceId: ctx.marketplaceId,
    name,
    publisher,
    version: latest?.version || versionTop || "0.0.0",
    description,
    license: optionalBoundedString(raw.license, "plugin.license"),
    categories: parseStringArray(raw.categories, "plugin.categories"),
    keywords: parseStringArray(raw.keywords, "plugin.keywords"),
    homepage: optionalBoundedString(raw.homepage, "plugin.homepage"),
    repository: optionalBoundedString(raw.repository, "plugin.repository"),
    compatibility: parseCompatibility(raw.compatibility ?? latest?.compatibility),
    trust: raw.trust === "full-access" ? "full-access" : "restricted",
    permissions: parseStringArray(raw.permissions, "plugin.permissions"),
    contributions: parseStringArray(raw.contributions, "plugin.contributions"),
    distribution: latest?.distribution || distribution,
    versions,
    install: isPlainObject(raw.install) ? { ...raw.install } : {},
    screenshots: parseStringArray(raw.screenshots, "plugin.screenshots"),
    readme: optionalBoundedString(raw.readme ?? raw.readmeMarkdown, "plugin.readme", MAX_MARKETPLACE_DESCRIPTION_LENGTH),
    readmePath: optionalBoundedString(raw.readmePath, "plugin.readmePath"),
    readmeUrl: optionalBoundedString(raw.readmeUrl, "plugin.readmeUrl"),
  };
}

function parseVersions(
  plugin: Record<string, unknown>,
  fallbackDistribution: MarketplaceDistribution | null,
  ctx: { marketplaceId: string; sourceKind: MarketplaceSourceKindForSchema },
): MarketplaceVersionRecord[] {
  const rawVersions = plugin.versions;
  if (rawVersions !== undefined && !Array.isArray(rawVersions)) {
    throw new Error("plugin.versions must be an array when present");
  }

  const list = Array.isArray(rawVersions) ? rawVersions : [];
  if (list.length > MAX_MARKETPLACE_VERSIONS_PER_PLUGIN) {
    throw new Error(`plugin.versions exceeds ${MAX_MARKETPLACE_VERSIONS_PER_PLUGIN} entries`);
  }

  const normalized: MarketplaceVersionRecord[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (!isPlainObject(item)) {
      throw new Error("plugin.versions entries must be objects");
    }
    assertAllowedKeys(item, VERSION_ALLOWED, "plugin.version entry");
    const version = requireBoundedString(item.version, "version.version");
    if (!version) throw new Error("plugin.versions entry requires version");
    if (seen.has(version)) {
      throw new Error(`Duplicate version id in plugin catalog entry: ${version}`);
    }
    seen.add(version);
    normalized.push({
      version,
      compatibility: parseCompatibility(item.compatibility),
      distribution: item.distribution === undefined
        ? null
        : parseDistribution(item.distribution, ctx),
    });
  }

  if (normalized.length === 0) {
    const version = optionalBoundedString(plugin.version, "plugin.version") || "0.0.0";
    normalized.push({
      version,
      compatibility: parseCompatibility(plugin.compatibility),
      distribution: fallbackDistribution,
    });
  }

  return normalized.sort((a, b) => b.version.localeCompare(a.version, "en"));
}

function parseDistribution(
  raw: unknown,
  ctx: { sourceKind: MarketplaceSourceKindForSchema },
): MarketplaceDistribution {
  if (!isPlainObject(raw)) {
    throw new Error("distribution must be an object");
  }
  if (raw.kind === "release") {
    assertAllowedKeys(raw, DISTRIBUTION_RELEASE_ALLOWED, "release distribution");
    const packageUrl = requireBoundedString(raw.packageUrl, "distribution.packageUrl");
    const sha256 = requireBoundedString(raw.sha256, "distribution.sha256");
    if (!packageUrl) throw new Error("release distribution requires packageUrl");
    if (!sha256 || !SHA256_PATTERN.test(sha256)) {
      throw new Error("release distribution requires lowercase 64-hex sha256");
    }
    return { kind: "release", packageUrl, sha256 };
  }
  if (raw.kind === "source") {
    assertAllowedKeys(raw, DISTRIBUTION_SOURCE_ALLOWED, "source distribution");
    if (ctx.sourceKind !== "local") {
      throw new Error('distribution.kind "source" is valid only for local marketplaces in v1');
    }
    const distPath = requireBoundedString(raw.path, "distribution.path");
    if (!distPath) throw new Error("source distribution requires path");
    if (!RELATIVE_PATH_PATTERN.test(distPath)) {
      throw new Error("source distribution path must be a normalized relative path without traversal");
    }
    return { kind: "source", path: distPath };
  }
  throw new Error(`Unsupported distribution.kind: ${String((raw as any).kind)}`);
}

function parseCompatibility(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (!isPlainObject(raw)) {
    throw new Error("compatibility must be an object when present");
  }
  return { ...raw };
}

function parseStringArray(raw: unknown, label: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new Error(`${label} entries must be strings`);
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_MARKETPLACE_STRING_LENGTH) {
      throw new Error(`${label} entry exceeds ${MAX_MARKETPLACE_STRING_LENGTH} characters`);
    }
    out.push(trimmed);
  }
  return [...new Set(out)];
}

function requireBoundedString(value: unknown, label: string, max = MAX_MARKETPLACE_STRING_LENGTH): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new Error(`${label} exceeds ${max} characters`);
  }
  return trimmed;
}

function optionalBoundedString(value: unknown, label: string, max = MAX_MARKETPLACE_STRING_LENGTH): string | null {
  return requireBoundedString(value, label, max);
}

function assertAllowedKeys(obj: Record<string, unknown>, allowed: Set<string>, label: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown field in ${label}: ${key}`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
