import fs from "fs";
import path from "path";

export const DEFAULT_LOCAL_MARKETPLACE_MAX_BYTES = 2 * 1024 * 1024;

export interface ContainedPathOptions {
  rootDir: string;
  candidatePath: string;
  /** When true, candidatePath may be absolute only if still contained after realpath. Default false. */
  allowAbsolute?: boolean;
}

export interface ContainedFileOptions extends ContainedPathOptions {
  maxBytes?: number;
}

/**
 * Resolve candidatePath under rootDir with realpath containment.
 * Rejects absolute candidates by default, lexical traversal, and symlink escape.
 */
export function resolveContainedPath(options: ContainedPathOptions): string {
  const rootDir = options.rootDir;
  const candidatePath = options.candidatePath;
  if (typeof rootDir !== "string" || !rootDir) {
    throw pathError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "rootDir is required");
  }
  if (typeof candidatePath !== "string" || !candidatePath) {
    throw pathError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "candidatePath is required");
  }
  if (candidatePath.includes("\0")) {
    throw pathError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Path contains NUL");
  }

  if (!options.allowAbsolute && path.isAbsolute(candidatePath)) {
    throw pathError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Absolute paths are not allowed");
  }

  // Lexical traversal check on the provided candidate before join.
  const normalizedCandidate = candidatePath.replace(/\\/g, "/");
  if (
    normalizedCandidate === ".."
    || normalizedCandidate.startsWith("../")
    || normalizedCandidate.includes("/../")
    || normalizedCandidate.endsWith("/..")
  ) {
    throw pathError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Path traversal is not allowed");
  }

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(rootDir);
  } catch (err: any) {
    throw pathError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", `rootDir is not accessible: ${err?.message || err}`);
  }

  const joined = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(rootReal, candidatePath);

  let candidateReal: string;
  try {
    candidateReal = fs.realpathSync(joined);
  } catch (err: any) {
    throw pathError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", `Path is not accessible: ${err?.message || err}`);
  }

  const rel = path.relative(rootReal, candidateReal);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw pathError(
      "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN",
      "Path escapes allowed root (symlink or containment failure)",
    );
  }
  return candidateReal;
}

export function assertContainedRegularFile(options: ContainedFileOptions): string {
  const resolved = resolveContainedPath(options);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err: any) {
    throw pathError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", `Cannot stat path: ${err?.message || err}`);
  }
  if (!stat.isFile()) {
    throw pathError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Path must be a regular file");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_LOCAL_MARKETPLACE_MAX_BYTES;
  if (stat.size > maxBytes) {
    throw pathError("PLUGIN_MARKETPLACE_FETCH_LIMIT", `File exceeds size limit of ${maxBytes} bytes`);
  }
  return resolved;
}

function pathError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
