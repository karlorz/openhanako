import { createHash } from "crypto";

/** Maximum length for marketplace source IDs (ASCII identifier grammar). */
export const MAX_MARKETPLACE_ID_LENGTH = 64;

/** Maximum length for plugin IDs within a marketplace. */
export const MAX_PLUGIN_ID_LENGTH = 64;

/** Lowercase hex length of package/artifact SHA-256 digests. */
export const ARTIFACT_DIGEST_HEX_LENGTH = 64;

/** Default catalog index path used when a descriptor omits indexPath. */
export const DEFAULT_MARKETPLACE_INDEX_PATH = "marketplace.json";

const ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$/;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const ARTIFACT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export interface MarketplacePluginId {
  marketplaceId: string;
  pluginId: string;
}

export interface MarketplaceSkillId extends MarketplacePluginId {
  skillName: string;
}

export interface PluginArtifactId extends MarketplacePluginId {
  artifactDigest: string;
}

export type MarketplaceSourceFingerprintInput =
  | { kind: "url"; id: string; url: string }
  | { kind: "local"; id: string; path: string; indexPath?: string }
  | { kind: "git"; id: string; gitUrl: string; gitRef?: string; indexPath?: string };

function isPlainNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasForbiddenIdChars(value: string): boolean {
  return (
    value.includes("@")
    || value.includes(":")
    || value.includes("/")
    || value.includes("\\")
    || value.includes(" ")
    || value.includes("\t")
    || value.includes("\n")
    || value.includes("\r")
    || value.includes(".")
  );
}

/**
 * Marketplace and plugin IDs: bounded ASCII, no `@`, colons, path separators,
 * whitespace, control characters, or dot segments.
 */
export function isMarketplaceId(value: unknown): value is string {
  if (!isPlainNonEmptyString(value)) return false;
  if (value.length > MAX_MARKETPLACE_ID_LENGTH) return false;
  if (hasForbiddenIdChars(value)) return false;
  if (value === "." || value === "..") return false;
  return ID_PATTERN.test(value);
}

export function isPluginId(value: unknown): value is string {
  if (!isPlainNonEmptyString(value)) return false;
  if (value.length > MAX_PLUGIN_ID_LENGTH) return false;
  if (hasForbiddenIdChars(value)) return false;
  if (value === "." || value === "..") return false;
  return ID_PATTERN.test(value);
}

export function assertMarketplaceId(value: unknown): string {
  if (!isMarketplaceId(value)) {
    throw new Error(`Invalid marketplace id: ${summarize(value)}`);
  }
  return value;
}

export function assertPluginId(value: unknown): string {
  if (!isPluginId(value)) {
    throw new Error(`Invalid plugin id: ${summarize(value)}`);
  }
  return value;
}

export function isMarketplaceSkillName(value: unknown): value is string {
  return isPlainNonEmptyString(value)
    && value.length <= 128
    && !value.includes("@")
    && !value.includes("/")
    && !value.includes("\\")
    && !/\s/.test(value)
    && value !== "."
    && value !== ".."
    && SKILL_NAME_PATTERN.test(value);
}

export function assertMarketplaceSkillName(value: unknown): string {
  if (!isMarketplaceSkillName(value)) {
    throw new Error(`Invalid marketplace skill name: ${summarize(value)}`);
  }
  return value;
}

export function assertArtifactDigest(value: unknown): string {
  if (typeof value !== "string" || !ARTIFACT_DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid artifact digest: ${summarize(value)}`);
  }
  return value;
}

/**
 * Parse CLI/docs boundary form `pluginId@marketplaceId`.
 * Requires exactly one `@`; never falls back to bare plugin matching.
 */
export function parsePluginMarketplaceRef(value: string): MarketplacePluginId {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Marketplace plugin ref requires marketplace qualifier (pluginId@marketplaceId)");
  }
  const atCount = value.split("@").length - 1;
  if (atCount === 0) {
    throw new Error("Marketplace plugin ref requires marketplace qualifier (pluginId@marketplaceId)");
  }
  if (atCount !== 1) {
    throw new Error("Marketplace plugin ref requires exactly one '@' separator (pluginId@marketplaceId)");
  }
  const separator = value.indexOf("@");
  const pluginId = value.slice(0, separator);
  const marketplaceId = value.slice(separator + 1);
  if (!pluginId || !marketplaceId) {
    throw new Error("Marketplace plugin ref requires non-empty pluginId and marketplaceId");
  }
  return {
    pluginId: assertPluginId(pluginId),
    marketplaceId: assertMarketplaceId(marketplaceId),
  };
}

export function buildPluginMarketplaceRef(value: MarketplacePluginId): string {
  const marketplaceId = assertMarketplaceId(value?.marketplaceId);
  const pluginId = assertPluginId(value?.pluginId);
  return `${pluginId}@${marketplaceId}`;
}

/**
 * Parse control-plane form `skillName@marketplaceId/pluginId`.
 * The skill name is intentionally distinct from the package id so duplicate
 * skills from different marketplace packages never collapse onto a bare name.
 */
export function parseMarketplaceSkillRef(value: string): MarketplaceSkillId {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Marketplace skill ref requires source-qualified form (skillName@marketplaceId/pluginId)");
  }
  const atCount = value.split("@").length - 1;
  if (atCount !== 1) {
    throw new Error("Marketplace skill ref requires exactly one '@' separator (skillName@marketplaceId/pluginId)");
  }
  const separator = value.indexOf("@");
  const skillName = value.slice(0, separator);
  const rest = value.slice(separator + 1);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1 || rest.indexOf("/", slash + 1) !== -1) {
    throw new Error("Marketplace skill ref requires marketplaceId/pluginId after '@'");
  }
  return {
    skillName: assertMarketplaceSkillName(skillName),
    marketplaceId: assertMarketplaceId(rest.slice(0, slash)),
    pluginId: assertPluginId(rest.slice(slash + 1)),
  };
}

export function buildMarketplaceSkillRef(value: MarketplaceSkillId): string {
  return `${assertMarketplaceSkillName(value?.skillName)}@${assertMarketplaceId(value?.marketplaceId)}/${assertPluginId(value?.pluginId)}`;
}

/** Internal composite key: marketplaceId:pluginId (runtime pluginKey for marketplace plugins). */
export function buildMarketplacePluginKey(value: MarketplacePluginId): string {
  const marketplaceId = assertMarketplaceId(value?.marketplaceId);
  const pluginId = assertPluginId(value?.pluginId);
  return `${marketplaceId}:${pluginId}`;
}

/** Path segments for source-qualified state/data/backup roots. */
export function buildMarketplaceStatePathSegments(value: MarketplacePluginId): [string, string] {
  return [assertMarketplaceId(value?.marketplaceId), assertPluginId(value?.pluginId)];
}

export function buildPluginArtifactKey(value: PluginArtifactId): string {
  const marketplaceId = assertMarketplaceId(value?.marketplaceId);
  const pluginId = assertPluginId(value?.pluginId);
  const artifactDigest = assertArtifactDigest(value?.artifactDigest);
  return `${marketplaceId}:${pluginId}:${artifactDigest}`;
}

export function marketplacePluginIdsEqual(a: MarketplacePluginId, b: MarketplacePluginId): boolean {
  return (
    assertMarketplaceId(a?.marketplaceId) === assertMarketplaceId(b?.marketplaceId)
    && assertPluginId(a?.pluginId) === assertPluginId(b?.pluginId)
  );
}

/**
 * Canonical SHA-256 fingerprint of a source identity tuple.
 * Includes only identity-bearing fields; defaults indexPath to marketplace.json.
 */
export function buildSourceFingerprint(source: MarketplaceSourceFingerprintInput): string {
  if (!source || typeof source !== "object") {
    throw new Error("Source fingerprint requires a source descriptor object");
  }
  const id = assertMarketplaceId(source.id);
  let canonical: Record<string, string>;

  switch (source.kind) {
    case "url": {
      if (typeof source.url !== "string" || !source.url) {
        throw new Error("URL source fingerprint requires url");
      }
      canonical = { kind: "url", id, url: source.url };
      break;
    }
    case "local": {
      if (typeof source.path !== "string" || !source.path) {
        throw new Error("Local source fingerprint requires path");
      }
      canonical = {
        kind: "local",
        id,
        path: source.path,
        indexPath: normalizeIndexPath(source.indexPath),
      };
      break;
    }
    case "git": {
      if (typeof source.gitUrl !== "string" || !source.gitUrl) {
        throw new Error("Git source fingerprint requires gitUrl");
      }
      canonical = {
        kind: "git",
        id,
        gitUrl: source.gitUrl,
        ...(source.gitRef ? { gitRef: source.gitRef } : {}),
        indexPath: normalizeIndexPath(source.indexPath),
      };
      break;
    }
    default: {
      throw new Error(`Unsupported source kind for fingerprint: ${summarize((source as any).kind)}`);
    }
  }

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function normalizeIndexPath(indexPath: string | undefined): string {
  if (indexPath == null || indexPath === "") return DEFAULT_MARKETPLACE_INDEX_PATH;
  if (typeof indexPath !== "string") {
    throw new Error("indexPath must be a string");
  }
  return indexPath;
}

function summarize(value: unknown): string {
  if (typeof value === "string") {
    if (value.length > 80) return JSON.stringify(value.slice(0, 80) + "…");
    return JSON.stringify(value);
  }
  return String(value);
}
