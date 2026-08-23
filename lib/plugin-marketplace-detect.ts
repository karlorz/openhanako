import { createHash } from "crypto";
import {
  assertMarketplaceId,
  assertPluginId,
  DEFAULT_MARKETPLACE_INDEX_PATH,
  isMarketplaceId,
  isPluginId,
  MAX_MARKETPLACE_ID_LENGTH,
  MAX_PLUGIN_ID_LENGTH,
} from "./plugin-marketplace-identity.ts";
import { assertPublicHttpsUrl } from "./plugin-marketplace-network-policy.ts";
import {
  MAX_MARKETPLACE_CATALOG_BYTES,
  MAX_MARKETPLACE_DESCRIPTION_LENGTH,
  MAX_MARKETPLACE_PLUGINS,
  MAX_MARKETPLACE_STRING_LENGTH,
  parseJsonRejectDuplicateKeys,
  parseMarketplaceCatalogStrict,
  type MarketplaceSourceKindForSchema,
  type ParsedMarketplaceCatalog,
  type TaggedMarketplacePlugin,
} from "./plugin-marketplace-schema.ts";

export { DEFAULT_MARKETPLACE_INDEX_PATH };

/** Claude Code catalog index relative to repo root. */
export const CLAUDE_MARKETPLACE_INDEX_PATH = ".claude-plugin/marketplace.json";

/** Ordered auto-detect candidates after the configured/default index fails. */
export const MARKETPLACE_INDEX_FALLBACKS = [
  CLAUDE_MARKETPLACE_INDEX_PATH,
] as const;

export interface NormalizedGitMarketplaceUrl {
  /** Clone-ready public HTTPS git URL (usually ends with .git). */
  gitUrl: string;
  /** Strict ref when detected from GitHub tree/blob path. */
  gitRef?: string;
  /** Suggested catalog index when path points at Claude layout or marketplace.json. */
  suggestedIndexPath?: string;
  /** Suggested marketplace source id (repo name). */
  suggestedId?: string;
}

/**
 * Normalize operator paste URLs for git marketplace sources.
 * Accepts bare repo, `.git`, and GitHub `/tree/<ref>/…` or `/blob/<ref>/…` paths.
 */
export function normalizeGitMarketplaceUrl(raw: string): NormalizedGitMarketplaceUrl {
  // Reuse shared HTTPS policy (no credentials/query; public hosts only).
  // allowFragment so paste URLs with # can still normalize; stripHash removes it.
  const url = assertPublicHttpsUrl(typeof raw === "string" ? raw.trim() : "", {
    allowFragment: true,
  });

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return { gitUrl: stripHash(url) };
  }

  const isGithub = host === "github.com" || host.endsWith(".github.com");
  if (!isGithub) {
    // Generic HTTPS git: add .git for bare owner/repo paths
    const cleaned = stripHash(url);
    const repoSeg = segments[segments.length - 1].replace(/\.git$/i, "");
    const gitUrl = segments.length === 2 && !cleaned.endsWith(".git")
      ? `${cleaned}.git`
      : cleaned;
    return {
      gitUrl,
      suggestedId: sanitizeIdCandidate(repoSeg),
    };
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  let gitRef: string | undefined;
  let suggestedIndexPath: string | undefined;

  const rest = segments.slice(2);
  if (rest.length >= 2 && (rest[0] === "tree" || rest[0] === "blob")) {
    gitRef = inferGitRef(rest[1]);
    if (rest.length > 2) {
      suggestedIndexPath = inferIndexPathFromGithubSubpath(rest.slice(2));
    }
  }
  // Other GitHub UI paths (releases/issues/…) are ignored; use owner/repo only.

  return {
    gitUrl: `https://${host}/${owner}/${repo}.git`,
    ...(gitRef ? { gitRef } : {}),
    ...(suggestedIndexPath ? { suggestedIndexPath } : {}),
    suggestedId: sanitizeIdCandidate(repo),
  };
}

/**
 * Ordered index paths to try: configured/default first, then Claude and optional fallbacks.
 */
export function listMarketplaceIndexCandidates(configuredIndexPath?: string): string[] {
  const primary = (configuredIndexPath && configuredIndexPath.trim())
    ? configuredIndexPath.trim()
    : DEFAULT_MARKETPLACE_INDEX_PATH;
  assertSafeRelativeIndexPath(primary);
  const out: string[] = [primary];
  for (const candidate of [DEFAULT_MARKETPLACE_INDEX_PATH, ...MARKETPLACE_INDEX_FALLBACKS]) {
    if (!out.includes(candidate)) {
      assertSafeRelativeIndexPath(candidate);
      out.push(candidate);
    }
  }
  return out;
}

export function assertSafeRelativeIndexPath(indexPath: string): void {
  if (!indexPath || typeof indexPath !== "string") {
    throw Object.assign(new Error("Invalid indexPath"), { code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN" });
  }
  if (indexPath.startsWith("/") || indexPath.includes("\\") || indexPath.includes("..")) {
    throw Object.assign(new Error("Invalid git indexPath"), { code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN" });
  }
  // Disallow empty segments
  if (indexPath.split("/").some((s) => !s || s === "." || s === "..")) {
    throw Object.assign(new Error("Invalid git indexPath"), { code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN" });
  }
}

/**
 * True when payload matches Claude Code marketplace.json shape
 * (root `name` + `plugins[]` with per-plugin `name`/`source`, no Hana schemaVersion:1).
 */
export function isClaudeMarketplaceCatalog(root: unknown): boolean {
  if (!isPlainObject(root)) return false;
  // Hana native catalogs always declare schemaVersion: 1
  if (root.schemaVersion === 1) return false;
  if (typeof root.name !== "string" || !root.name.trim()) return false;
  if (!Array.isArray(root.plugins) || root.plugins.length === 0) return false;
  for (const entry of root.plugins) {
    if (!isPlainObject(entry)) return false;
    if (typeof entry.name !== "string" || !entry.name.trim()) return false;
    if (entry.source == null) return false;
    // Reject mixed Hana-shaped plugin rows inside a Claude-looking root
    if (entry.schemaVersion === 1 && entry.id && entry.distribution) return false;
  }
  return true;
}

export interface ParseMarketplaceCatalogAutoOptions {
  marketplaceId: string;
  sourceKind: MarketplaceSourceKindForSchema;
}

/**
 * Parse Hana strict catalog when schemaVersion is 1; otherwise Claude adapter when shape matches.
 */
export function parseMarketplaceCatalogAuto(
  input: string | unknown,
  options: ParseMarketplaceCatalogAutoOptions,
): ParsedMarketplaceCatalog {
  const marketplaceId = assertMarketplaceId(options.marketplaceId);
  const sourceKind = options.sourceKind;

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

  // Prefer strict Hana when schemaVersion is present as 1
  if (root.schemaVersion === 1) {
    return parseMarketplaceCatalogStrict(typeof input === "string" ? input : root, {
      marketplaceId,
      sourceKind,
    });
  }

  if (isClaudeMarketplaceCatalog(root)) {
    return parseClaudeMarketplaceCatalog(rawText, root, { marketplaceId, sourceKind });
  }

  // Fall through to strict for better error messages on near-Hana catalogs
  return parseMarketplaceCatalogStrict(typeof input === "string" ? input : root, {
    marketplaceId,
    sourceKind,
  });
}

function parseClaudeMarketplaceCatalog(
  rawText: string,
  root: Record<string, unknown>,
  options: { marketplaceId: string; sourceKind: MarketplaceSourceKindForSchema },
): ParsedMarketplaceCatalog {
  const marketplaceId = options.marketplaceId;
  if (!Array.isArray(root.plugins)) {
    throw new Error("Claude marketplace plugins must be an array");
  }
  if (root.plugins.length > MAX_MARKETPLACE_PLUGINS) {
    throw new Error(`Marketplace catalog exceeds ${MAX_MARKETPLACE_PLUGINS} plugins`);
  }

  const ownerName = extractOwnerName(root.owner);
  const metaVersion = isPlainObject(root.metadata)
    ? optionalString(root.metadata.version)
    : null;

  const plugins: TaggedMarketplacePlugin[] = [];
  const seenIds = new Set<string>();

  for (const entry of root.plugins) {
    if (!isPlainObject(entry)) {
      throw new Error("Claude marketplace plugin entry must be an object");
    }
    const name = requireString(entry.name, "plugin.name");
    const id = sanitizeClaudePluginId(name);
    if (seenIds.has(id)) {
      throw new Error(`Duplicate plugin id in marketplace catalog: ${id}`);
    }
    seenIds.add(id);

    const authorName = isPlainObject(entry.author) ? optionalString(entry.author.name) : null;
    const version = optionalString(entry.version) || metaVersion || "0.0.0";
    const sourceMeta = classifyClaudePluginSource(entry.source);

    plugins.push({
      schemaVersion: 1,
      id,
      marketplaceId,
      name,
      publisher: authorName || ownerName || "unknown",
      version,
      description: optionalString(entry.description, MAX_MARKETPLACE_DESCRIPTION_LENGTH) || "",
      license: optionalString(entry.license),
      categories: [],
      keywords: stringArray(entry.keywords),
      homepage: optionalString(entry.homepage),
      repository: optionalString(entry.repository),
      compatibility: {},
      trust: "restricted",
      permissions: [],
      contributions: [],
      // Not a Hana release zip — install goes through skills-lane when canInstall
      distribution: null,
      versions: [{ version, compatibility: {}, distribution: null }],
      install: {
        catalogFormat: "claude",
        installTarget: sourceMeta.canInstall ? "hana-skills" : "unsupported",
        sourceKind: sourceMeta.sourceKind,
        canInstall: sourceMeta.canInstall,
        ...(sourceMeta.source ? { source: sourceMeta.source } : {}),
      },
      screenshots: [],
      readme: null,
      readmePath: null,
      readmeUrl: null,
    });
  }

  return {
    schemaVersion: 1,
    plugins,
    catalogSha256: createHash("sha256").update(rawText).digest("hex"),
    rawCanonicalJson: rawText,
  };
}

export type ClaudeCatalogSourceKind = "relative" | "git-subdir" | "github" | "unsupported";

export interface ClaudeCatalogSourceMeta {
  sourceKind: ClaudeCatalogSourceKind;
  source: string | null;
  /** v1: only relative package paths are installable via skills-lane. */
  canInstall: boolean;
}

/** Classify Claude plugins[].source for browse + install eligibility. */
export function classifyClaudePluginSource(source: unknown): ClaudeCatalogSourceMeta {
  if (typeof source === "string") {
    let p = source.trim();
    if (!p) {
      return { sourceKind: "unsupported", source: null, canInstall: false };
    }
    while (p.startsWith("./")) p = p.slice(2);
    if (p.startsWith("/") || p.includes("..") || p.includes("\\")) {
      return { sourceKind: "unsupported", source: null, canInstall: false };
    }
    if (p.length > MAX_MARKETPLACE_STRING_LENGTH) {
      return { sourceKind: "unsupported", source: null, canInstall: false };
    }
    return { sourceKind: "relative", source: p, canInstall: true };
  }
  if (isPlainObject(source)) {
    const kindRaw = optionalString(source.source) || optionalString((source as any).type) || "";
    if (kindRaw === "git-subdir" || kindRaw === "git") {
      return {
        sourceKind: "git-subdir",
        source: optionalString(source.path) || optionalString(source.url),
        canInstall: false,
      };
    }
    if (kindRaw === "github" || optionalString(source.repo) || optionalString(source.url)?.includes("github")) {
      return {
        sourceKind: "github",
        source: optionalString(source.repo) || optionalString(source.url),
        canInstall: false,
      };
    }
    return {
      sourceKind: "unsupported",
      source: kindRaw ? `claude-object:${kindRaw.slice(0, 64)}` : null,
      canInstall: false,
    };
  }
  return { sourceKind: "unsupported", source: null, canInstall: false };
}

function sanitizeClaudePluginId(name: string): string {
  // Prefer identity when already a valid plugin id (avoid isPluginId type-predicate
  // narrowing a string to never on the false branch).
  if (isPluginId(name as unknown)) {
    return assertPluginId(name);
  }
  const cleaned = slugifyId(name, MAX_PLUGIN_ID_LENGTH);
  if (!cleaned || !isPluginId(cleaned as unknown)) {
    throw new Error(`Claude plugin name is not a valid plugin id: ${JSON.stringify(name)}`);
  }
  return cleaned;
}

function sanitizeIdCandidate(raw: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = slugifyId(raw, MAX_MARKETPLACE_ID_LENGTH);
  return cleaned && isMarketplaceId(cleaned as unknown) ? cleaned : undefined;
}

function slugifyId(raw: string, maxLen: number): string {
  let cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen).replace(/-+$/g, "");
  }
  return cleaned;
}

function inferGitRef(ref: string): string {
  // GitHub tree paths use short branch/tag names, not full refs/
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  if (ref.startsWith("refs/")) {
    if (!/^(refs\/heads\/[A-Za-z0-9._/-]+|refs\/tags\/[A-Za-z0-9._/-]+)$/.test(ref)) {
      throw Object.assign(new Error(`Invalid git ref: ${ref}`), {
        code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN",
      });
    }
    return ref;
  }
  // Prefer heads for branch-like names; tags still work if branch missing (clone --branch)
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) {
    throw Object.assign(new Error(`Invalid git ref: ${ref}`), {
      code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN",
    });
  }
  return `refs/heads/${ref}`;
}

function inferIndexPathFromGithubSubpath(pathParts: string[]): string | undefined {
  if (pathParts.length === 0) return undefined;
  const joined = pathParts.join("/");
  if (joined.includes("..")) return undefined;
  // Directory or file under Claude plugin layout
  if (pathParts[0] === ".claude-plugin") {
    return joined === CLAUDE_MARKETPLACE_INDEX_PATH || joined.endsWith("/marketplace.json")
      ? joined
      : CLAUDE_MARKETPLACE_INDEX_PATH;
  }
  if (joined === "marketplace.json" || joined.endsWith("/marketplace.json")) {
    return joined;
  }
  return undefined;
}

function extractOwnerName(owner: unknown): string | null {
  if (typeof owner === "string") return optionalString(owner);
  if (isPlainObject(owner)) return optionalString(owner.name);
  return null;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  if (value.length > MAX_MARKETPLACE_STRING_LENGTH) {
    throw new Error(`${label} exceeds ${MAX_MARKETPLACE_STRING_LENGTH} characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, max = MAX_MARKETPLACE_STRING_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  if (t.length > max) return t.slice(0, max);
  return t;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t || t.length > MAX_MARKETPLACE_STRING_LENGTH) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

function stripHash(url: URL): string {
  const u = new URL(url.href);
  u.hash = "";
  // Keep path; drop trailing slash except root
  let href = u.href;
  if (href.endsWith("/") && u.pathname !== "/") href = href.slice(0, -1);
  return href;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
