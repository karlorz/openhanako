import { spawn } from "child_process";
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
    try {
      const normalized = normalizeGitMarketplaceUrl(source.gitUrl);
      const gitUrl = assertPublicGitHttpsUrl(normalized.gitUrl).href;
      const gitRef = assertStrictGitRef(source.gitRef || normalized.gitRef);
      const configuredIndex = source.indexPath || normalized.suggestedIndexPath;
      if (configuredIndex) assertSafeRelativeIndexPath(configuredIndex);
      const indexCandidates = listMarketplaceIndexCandidates(configuredIndex);

      const cacheRoot = path.join(options.hanakoHome, GIT_MARKETPLACE_CACHE_DIR, sourceId);
      const staging = path.join(cacheRoot, `stage-${Date.now()}-${process.pid}`);
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
      return published;
    } catch (err: any) {
      options.store.markError(sourceId, {
        code: err?.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
        message: err?.message || String(err),
      });
      throw err;
    } finally {
      inFlight.delete(sourceId);
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

/**
 * Materialize a relative package path from a git marketplace source for skills-lane install.
 * Performs a shallow clone and sparse checkout of packagePath only.
 */
export async function materializeGitMarketplacePackage(
  source: GitSourceDescriptor,
  options: {
    hanakoHome: string;
    packagePath: string;
    gitBinary?: string;
    timeoutMs?: number;
    execGit?: typeof runGit;
  },
): Promise<{ packageRoot: string; resolvedRevision: string; repoRoot: string }> {
  const sourceId = assertMarketplaceId(source.id);
  assertSafeRelativeIndexPath(options.packagePath);
  const normalized = normalizeGitMarketplaceUrl(source.gitUrl);
  const gitUrl = assertPublicGitHttpsUrl(normalized.gitUrl).href;
  const gitRef = assertStrictGitRef(source.gitRef || normalized.gitRef);

  const cacheRoot = path.join(options.hanakoHome, GIT_MARKETPLACE_CACHE_DIR, sourceId, "packages");
  const staging = path.join(cacheRoot, `pkg-${Date.now()}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const execGit = options.execGit || runGit;
  const gitBin = options.gitBinary || "git";
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const branch = gitRef.startsWith("refs/")
    ? gitRef.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "")
    : gitRef;

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

  const rev = (await execGit(gitBin, ["-C", staging, "rev-parse", "HEAD"], { timeoutMs })).trim();
  const packageRoot = path.join(staging, options.packagePath);
  if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
    throw Object.assign(
      new Error(`Package path not found in git tree: ${options.packagePath}`),
      { code: "PLUGIN_MARKETPLACE_SOURCE_INVALID" },
    );
  }
  return { packageRoot, resolvedRevision: rev, repoRoot: staging };
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
