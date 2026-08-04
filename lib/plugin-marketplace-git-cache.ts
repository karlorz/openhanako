import { spawn } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { assertMarketplaceId, buildSourceFingerprint, DEFAULT_MARKETPLACE_INDEX_PATH } from "./plugin-marketplace-identity.ts";
import type { MarketplaceSnapshot, MarketplaceSnapshotStore } from "./plugin-marketplace-snapshots.ts";
import { assertPublicHttpsUrl } from "./plugin-marketplace-network-policy.ts";
import {
  assertSafeRelativeIndexPath,
  listMarketplaceIndexCandidates,
  normalizeGitMarketplaceUrl,
  parseMarketplaceCatalogAuto,
} from "./plugin-marketplace-detect.ts";

export const GIT_MARKETPLACE_CACHE_DIR = "plugin-marketplace-git";
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
export const DEFAULT_GIT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const DEFAULT_GIT_MAX_DISK_BYTES = 50 * 1024 * 1024;
export const DEFAULT_GIT_PACKAGE_CACHE_MAX_ENTRIES = 10;

const STRICT_REF_PATTERN = /^(refs\/heads\/[A-Za-z0-9._/-]+|refs\/tags\/[A-Za-z0-9._/-]+|[0-9a-f]{40})$/;

export interface GitSourceDescriptor {
  id: string;
  name?: string;
  kind: "git";
  gitUrl: string;
  gitRef?: string;
  indexPath?: string;
}

export interface GitAcquireOptions {
  store: MarketplaceSnapshotStore;
  hanakoHome: string;
  gitBinary?: string;
  timeoutMs?: number;
  execGit?: typeof runGit;
}

const inFlight = new Map<string, Promise<MarketplaceSnapshot>>();

export function assertPublicGitHttpsUrl(raw: string): URL {
  const url = assertPublicHttpsUrl(raw);
  // Reject SCP-like and non-https already handled; also reject .git path tricks later.
  if (url.pathname.includes("?")) {
    throw Object.assign(new Error("Git URL must not contain query"), { code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN" });
  }
  return url;
}

export function assertStrictGitRef(ref: string | undefined): string {
  const value = ref || "refs/heads/main";
  if (!STRICT_REF_PATTERN.test(value)) {
    throw Object.assign(new Error(`Invalid git ref: ${value}`), { code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN" });
  }
  return value;
}

export async function acquireGitMarketplaceSnapshot(
  source: GitSourceDescriptor,
  options: GitAcquireOptions,
): Promise<MarketplaceSnapshot> {
  const sourceId = assertMarketplaceId(source.id);
  const existing = inFlight.get(sourceId);
  if (existing) return existing;

  const work = (async () => {
    options.store.markRefreshing(sourceId);
    let staging: string | null = null;
    try {
      const normalized = normalizeGitMarketplaceUrl(source.gitUrl);
      const gitUrl = assertPublicGitHttpsUrl(normalized.gitUrl).href;
      const gitRef = assertStrictGitRef(source.gitRef || normalized.gitRef);
      const configuredIndex = source.indexPath || normalized.suggestedIndexPath;
      if (configuredIndex) assertSafeRelativeIndexPath(configuredIndex);
      const indexCandidates = listMarketplaceIndexCandidates(configuredIndex);

      const cacheRoot = path.join(options.hanakoHome, GIT_MARKETPLACE_CACHE_DIR, sourceId);
      staging = path.join(cacheRoot, `stage-${Date.now()}-${process.pid}`);
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });

      const execGit = options.execGit || runGit;
      const gitBin = options.gitBinary || "git";
      const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

      // Shallow fetch into bare-ish staging without checkout when possible.
      // Use git clone --depth 1 --no-checkout then show blob.
      await execGit(gitBin, [
        "clone",
        "--depth", "1",
        "--no-tags",
        "--branch", gitRef.startsWith("refs/") ? gitRef.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "") : gitRef,
        "--single-branch",
        "--no-checkout",
        gitUrl,
        staging,
      ], { timeoutMs, cwd: options.hanakoHome });

      // Resolve full OID
      const rev = (await execGit(gitBin, ["-C", staging, "rev-parse", "HEAD"], { timeoutMs })).trim();
      if (!/^[0-9a-f]{40}$/.test(rev)) {
        throw Object.assign(new Error("Failed to resolve git revision"), { code: "PLUGIN_MARKETPLACE_GIT_UNAVAILABLE" });
      }

      // Probe default + Claude index paths via git show (no-checkout clone).
      const catalog = await readGitCatalogIndex({
        execGit,
        gitBin,
        staging,
        timeoutMs,
        candidates: indexCandidates,
      });
      const catalogText = catalog.text;
      const indexPath = catalog.indexPath;

      const parsed = parseMarketplaceCatalogAuto(catalogText, {
        marketplaceId: sourceId,
        sourceKind: "git",
      });

      const snapshot: MarketplaceSnapshot = {
        sourceId,
        sourceFingerprint: buildSourceFingerprint({
          kind: "git",
          id: sourceId,
          gitUrl,
          gitRef,
          indexPath,
        }),
        catalogSha256: parsed.catalogSha256,
        fetchedAt: new Date().toISOString(),
        requestedRef: gitRef,
        resolvedRevision: rev,
        plugins: parsed.plugins,
      };

      // Immutable generation is owned by snapshot store; clean staging after success.
      const published = options.store.publish(sourceId, snapshot);
      fs.rmSync(staging, { recursive: true, force: true });
      staging = null;
      return published;
    } catch (err: any) {
      options.store.markError(sourceId, {
        code: err?.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
        message: err?.message || String(err),
      });
      throw err;
    } finally {
      inFlight.delete(sourceId);
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    }
  })();

  inFlight.set(sourceId, work);
  return work;
}

export function runGit(
  gitBin: string,
  args: string[],
  options: { timeoutMs: number; cwd?: string; maxOutputBytes?: number } = { timeoutMs: DEFAULT_GIT_TIMEOUT_MS },
): Promise<string> {
  // Never allow shell; isolated env.
  const env = {
    PATH: process.env.PATH || "",
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    HOME: process.env.HOME || "",
    // Explicitly strip helpers
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes",
  };

  // Reject any pull on active generation by never exposing pull in public API.
  if (args.includes("pull")) {
    return Promise.reject(Object.assign(new Error("git pull is forbidden"), {
      code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN",
    }));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(gitBin, args, {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxOut = options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(Object.assign(new Error("git command timed out"), { code: "PLUGIN_MARKETPLACE_FETCH_LIMIT" }));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > maxOut) {
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > maxOut) {
        child.kill("SIGKILL");
      }
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(new Error(`git unavailable: ${err.message}`), {
        code: "PLUGIN_MARKETPLACE_GIT_UNAVAILABLE",
      }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdout.length > maxOut || stderr.length > maxOut) {
        reject(Object.assign(new Error("git output exceeded limit"), {
          code: "PLUGIN_MARKETPLACE_FETCH_LIMIT",
        }));
        return;
      }
      if (code !== 0) {
        reject(Object.assign(new Error(`git failed (${code}): ${stderr.toString("utf8").slice(0, 200)}`), {
          code: "PLUGIN_MARKETPLACE_SOURCE_INVALID",
        }));
        return;
      }
      resolve(stdout.toString("utf8"));
    });
  });
}

export function hashGitSourceIdentity(source: GitSourceDescriptor): string {
  return buildSourceFingerprint({
    kind: "git",
    id: source.id,
    gitUrl: source.gitUrl,
    gitRef: source.gitRef,
    indexPath: source.indexPath,
  });
}

function stablePackageCacheName(input: {
  sourceId: string;
  gitUrl: string;
  gitRef: string;
  packagePath: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 24);
}

function packageCacheMarkerPath(dir: string): string {
  return path.join(dir, ".hana-marketplace-package.json");
}

function writePackageCacheMarker(dir: string, marker: Record<string, unknown>) {
  fs.writeFileSync(packageCacheMarkerPath(dir), JSON.stringify(marker, null, 2) + "\n", "utf8");
}

function readPackageCacheMarker(dir: string): Record<string, unknown> | null {
  const markerPath = packageCacheMarkerPath(dir);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readCachedPackageMaterialization(
  target: string,
  expected: {
    sourceId: string;
    gitUrl: string;
    gitRef: string;
    packagePath: string;
    expectedRevision?: string | null;
  },
): { packageRoot: string; resolvedRevision: string; repoRoot: string } | null {
  const packageRoot = path.join(target, expected.packagePath);
  try {
    if (!fs.statSync(packageRoot).isDirectory()) return null;
  } catch {
    return null;
  }
  const marker = readPackageCacheMarker(target);
  if (!marker) return null;
  const resolvedRevision = typeof marker.resolvedRevision === "string" ? marker.resolvedRevision : "";
  if (!/^[0-9a-f]{40}$/.test(resolvedRevision)) return null;
  if (
    marker.sourceId !== expected.sourceId
    || marker.gitUrl !== expected.gitUrl
    || marker.gitRef !== expected.gitRef
    || marker.packagePath !== expected.packagePath
  ) {
    return null;
  }
  if (expected.expectedRevision && resolvedRevision !== expected.expectedRevision) return null;
  try {
    // Touch mtime so prunePackageCache treats hits as recently used.
    const now = new Date();
    fs.utimesSync(target, now, now);
  } catch {
    /* ignore */
  }
  return { packageRoot, resolvedRevision, repoRoot: target };
}

function prunePackageCache(cacheRoot: string, keepDir: string, maxEntries = DEFAULT_GIT_PACKAGE_CACHE_MAX_ENTRIES) {
  if (!fs.existsSync(cacheRoot)) return;
  const keep = path.resolve(keepDir);
  const entries = fs.readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const fullPath = path.join(cacheRoot, entry.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch { /* ignore */ }
      return { fullPath, mtimeMs };
    })
    .filter((entry) => path.resolve(entry.fullPath) !== keep)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of entries.slice(Math.max(0, maxEntries - 1))) {
    fs.rmSync(entry.fullPath, { recursive: true, force: true });
  }
}

/**
 * Materialize a relative package path from a git marketplace source for skills-lane install.
 * Reuses a stable package cache entry when present; otherwise shallow-clones with sparse checkout.
 */
export async function materializeGitMarketplacePackage(
  source: GitSourceDescriptor,
  options: {
    hanakoHome: string;
    packagePath: string;
    gitBinary?: string;
    timeoutMs?: number;
    execGit?: typeof runGit;
    expectedRevision?: string;
  },
): Promise<{ packageRoot: string; resolvedRevision: string; repoRoot: string }> {
  const sourceId = assertMarketplaceId(source.id);
  assertSafeRelativeIndexPath(options.packagePath);
  const normalized = normalizeGitMarketplaceUrl(source.gitUrl);
  const gitUrl = assertPublicGitHttpsUrl(normalized.gitUrl).href;
  const gitRef = assertStrictGitRef(source.gitRef || normalized.gitRef);

  const cacheRoot = path.join(options.hanakoHome, GIT_MARKETPLACE_CACHE_DIR, sourceId, "packages");
  const cacheKey = {
    sourceId,
    gitUrl,
    gitRef,
    packagePath: options.packagePath,
  };
  const target = path.join(cacheRoot, stablePackageCacheName(cacheKey));
  const cached = readCachedPackageMaterialization(target, cacheKey);
  if (cached) {
    prunePackageCache(cacheRoot, target);
    return cached;
  }

  const staging = path.join(cacheRoot, `.stage-${Date.now()}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const execGit = options.execGit || runGit;
  const gitBin = options.gitBinary || "git";
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const branch = gitRef.startsWith("refs/")
    ? gitRef.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "")
    : gitRef;

  try {
    await execGit(gitBin, [
      "clone",
      "--depth", "1",
      "--no-tags",
      "--branch", branch,
      "--single-branch",
      "--filter=blob:none",
      "--sparse",
      gitUrl,
      staging,
    ], { timeoutMs, cwd: options.hanakoHome });

    // Sparse checkout the package path (and parent tree for plugin.json if present)
    try {
      await execGit(gitBin, ["-C", staging, "sparse-checkout", "set", "--cone", options.packagePath], {
        timeoutMs,
      });
    } catch {
      // Fallback: full checkout of path
      await execGit(gitBin, ["-C", staging, "checkout", "HEAD", "--", options.packagePath], { timeoutMs });
    }

    let rev = (await execGit(gitBin, ["-C", staging, "rev-parse", "HEAD"], { timeoutMs })).trim();
    if (!/^[0-9a-f]{40}$/.test(rev)) {
      throw Object.assign(new Error("Failed to resolve git revision"), { code: "PLUGIN_MARKETPLACE_GIT_UNAVAILABLE" });
    }

    // Pin to expected revision when the snapshot was acquired from a different
    // shallow-clone (branch may have moved between catalog fetch and install).
    // Fetch the exact commit so the materialized tree matches the plan.
    const expectedRevision = options.expectedRevision;
    if (expectedRevision && /^[0-9a-f]{40}$/.test(expectedRevision) && expectedRevision !== rev) {
      await execGit(gitBin, [
        "-C", staging, "fetch", "--depth", "1", "origin", expectedRevision,
      ], { timeoutMs, cwd: options.hanakoHome });
      await execGit(gitBin, ["-C", staging, "checkout", expectedRevision], { timeoutMs });
      // checkout of an exact SHA detaches HEAD at it; update rev for the cache marker.
      rev = expectedRevision;
    }
    const stagedPackageRoot = path.join(staging, options.packagePath);
    if (!fs.existsSync(stagedPackageRoot) || !fs.statSync(stagedPackageRoot).isDirectory()) {
      throw Object.assign(
        new Error(`Package path not found in git tree: ${options.packagePath}`),
        { code: "PLUGIN_MARKETPLACE_SOURCE_INVALID" },
      );
    }

    writePackageCacheMarker(staging, {
      ...cacheKey,
      resolvedRevision: rev,
      materializedAt: new Date().toISOString(),
    });

    const oldTarget = `${target}.old-${Date.now()}-${process.pid}`;
    fs.rmSync(oldTarget, { recursive: true, force: true });
    if (fs.existsSync(target)) fs.renameSync(target, oldTarget);
    try {
      fs.renameSync(staging, target);
    } catch (err) {
      if (fs.existsSync(oldTarget)) fs.renameSync(oldTarget, target);
      throw err;
    } finally {
      fs.rmSync(oldTarget, { recursive: true, force: true });
    }

    prunePackageCache(cacheRoot, target);
    return {
      packageRoot: path.join(target, options.packagePath),
      resolvedRevision: rev,
      repoRoot: target,
    };
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

async function readGitCatalogIndex(options: {
  execGit: typeof runGit;
  gitBin: string;
  staging: string;
  timeoutMs: number;
  candidates: string[];
}): Promise<{ text: string; indexPath: string }> {
  const { execGit, gitBin, staging, timeoutMs, candidates } = options;
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      const text = await execGit(gitBin, ["-C", staging, "show", `HEAD:${candidate}`], {
        timeoutMs,
        maxOutputBytes: DEFAULT_GIT_MAX_OUTPUT_BYTES,
      });
      return { text, indexPath: candidate };
    } catch (err) {
      lastErr = err;
    }
  }
  throw Object.assign(
    new Error(
      lastErr instanceof Error
        ? `Marketplace index not found (tried ${candidates.join(", ")}): ${lastErr.message}`
        : `Marketplace index not found (tried ${candidates.join(", ")})`,
    ),
    { code: "PLUGIN_MARKETPLACE_SOURCE_INVALID" },
  );
}
