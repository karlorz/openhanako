import fs from "fs";
import os from "os";
import path from "path";
import { spawn as defaultSpawn } from "child_process";
import {
  buildWin32LegacyAclDiagnosticArgs,
  buildWin32LegacyProfileCleanupArgs,
  resolveWin32SandboxHelper,
} from "./win32-sandbox-helper.js";

const LEGACY_PROFILE_PREFIX = "com.hanako.sandbox.";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

function isWin32PathLike(value) {
  return /^[a-z]:[\\/]|^\\\\/i.test(String(value || ""));
}

function joinWin32Aware(root, ...segments) {
  if (!root) return null;
  return isWin32PathLike(root)
    ? path.win32.join(root, ...segments)
    : path.join(root, ...segments);
}

function normalizeWin32Aware(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = isWin32PathLike(raw) ? path.win32.normalize(raw) : path.resolve(raw);
  return normalized.replace(/[\\/]+$/g, (suffix) => {
    if (/^[a-z]:[\\/]$/i.test(normalized)) return suffix.slice(0, 1);
    if (normalized === "/" || normalized === "\\") return suffix.slice(0, 1);
    return "";
  });
}

function pushExistingUnique(out, seen, raw, existsSync) {
  const normalized = normalizeWin32Aware(raw);
  if (!normalized) return;
  if (!existsSync(normalized)) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(normalized);
}

function driveRoot(value) {
  const match = String(value || "").match(/^[A-Za-z]:/);
  return match ? `${match[0].toUpperCase()}\\` : null;
}

export function isLegacyWin32SandboxProfileName(name) {
  return typeof name === "string" && /^com\.hanako\.sandbox\.\d+\.\d+$/i.test(name);
}

function packagesRoots({ env, homedir }) {
  const roots = [];
  if (env.LOCALAPPDATA) roots.push(path.win32.join(env.LOCALAPPDATA, "Packages"));
  const home = env.USERPROFILE || homedir?.();
  if (home) roots.push(path.win32.join(home, "AppData", "Local", "Packages"));
  return [...new Set(roots.filter(Boolean).map((p) => path.win32.normalize(p)))];
}

function discoverLegacyProfileNames({ env, readdirSync, existsSync, homedir }) {
  const names = [];
  const seen = new Set();
  for (const root of packagesRoots({ env, homedir })) {
    if (!existsSync(root)) continue;
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries || []) {
      const name = typeof entry === "string" ? entry : entry?.name;
      if (!isLegacyWin32SandboxProfileName(name)) continue;
      if (entry && typeof entry !== "string" && typeof entry.isDirectory === "function" && !entry.isDirectory()) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

function win32DriveRoots(env) {
  const roots = [];
  const push = (value) => {
    const root = driveRoot(value);
    if (root) roots.push(root);
  };
  push(env.SystemDrive);
  push(env.HOMEDRIVE);
  for (let code = 67; code <= 90; code += 1) roots.push(`${String.fromCharCode(code)}:\\`);
  return roots;
}

export function collectWin32LegacySandboxMigrationTargets({
  platform = process.platform,
  hanakoHome,
  workspaceRoots = [],
  env = process.env,
  resourcesPath = process.resourcesPath,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  homedir = os.homedir,
} = {}) {
  if (platform !== "win32") return { aclPaths: [], profileNames: [] };

  const aclPaths = [];
  const seen = new Set();
  const push = (target) => pushExistingUnique(aclPaths, seen, target, existsSync);

  if (hanakoHome) {
    push(hanakoHome);
    push(joinWin32Aware(hanakoHome, ".ephemeral"));
    push(joinWin32Aware(hanakoHome, "agents"));
    push(joinWin32Aware(hanakoHome, "session-files"));
    push(joinWin32Aware(hanakoHome, "uploads"));
  }
  for (const root of workspaceRoots || []) push(root);
  if (resourcesPath) {
    push(resourcesPath);
    push(joinWin32Aware(resourcesPath, "git"));
  }
  push(env.USERPROFILE);
  try { push(homedir?.()); } catch {}
  for (const root of win32DriveRoots(env)) push(root);

  return {
    aclPaths,
    profileNames: discoverLegacyProfileNames({ env, readdirSync, existsSync, homedir }),
  };
}

function appendChunk(current, chunk, maxBytes) {
  const next = current + String(chunk || "");
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  return next.slice(0, maxBytes) + "\n[truncated]";
}

function runHelper(helperPath, args, {
  spawn = defaultSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      try { child?.kill?.(); } catch {}
      finish({ code: null, timedOut: true });
    }, timeoutMs);

    try {
      child = spawn(helperPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ code: null, error: err });
      return;
    }

    child.stdout?.on?.("data", (chunk) => {
      stdout = appendChunk(stdout, chunk, maxOutputBytes);
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr = appendChunk(stderr, chunk, maxOutputBytes);
    });
    child.on?.("error", (err) => finish({ code: null, error: err }));
    child.on?.("close", (code) => finish({ code }));
  });
}

function buildMigrationArgs({ targets, cleanup }) {
  const args = [];
  const profileNames = targets.profileNames || [];
  if (targets.aclPaths?.length) {
    if (cleanup) {
      for (const name of profileNames) args.push("--legacy-appcontainer-profile", name);
    }
    args.push(...buildWin32LegacyAclDiagnosticArgs({
      cleanup,
      paths: targets.aclPaths,
    }));
  }
  if (cleanup && profileNames.length) {
    args.push(...buildWin32LegacyProfileCleanupArgs({ profileNames }));
  }
  return args;
}

export async function runWin32LegacySandboxMigration({
  platform = process.platform,
  hanakoHome,
  workspaceRoots = [],
  cleanup = false,
  targets,
  helperPath,
  resolveHelper = resolveWin32SandboxHelper,
  env = process.env,
  spawn = defaultSpawn,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  resourcesPath = process.resourcesPath,
  homedir = os.homedir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (platform !== "win32") return { status: "skipped", reason: "platform" };

  const helper = helperPath || resolveHelper({ env, resourcesPath, existsSync });
  if (!helper) return { status: "skipped", reason: "helper-unavailable" };

  const resolvedTargets = targets || collectWin32LegacySandboxMigrationTargets({
    platform,
    hanakoHome,
    workspaceRoots,
    env,
    resourcesPath,
    existsSync,
    readdirSync,
    homedir,
  });
  const args = buildMigrationArgs({ targets: resolvedTargets, cleanup });
  if (args.length === 0) {
    return { status: "clean", cleanup, helperPath: helper, targets: resolvedTargets };
  }

  const result = await runHelper(helper, args, { spawn, timeoutMs });
  if (result.error || result.timedOut) {
    return {
      status: "failed",
      cleanup,
      helperPath: helper,
      targets: resolvedTargets,
      ...result,
      error: result.error?.message || (result.timedOut ? "timeout" : "helper failed"),
    };
  }

  const status = result.code === 0 ? "clean" : result.code === 3 ? "findings" : "failed";
  return {
    status,
    cleanup,
    helperPath: helper,
    targets: resolvedTargets,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function summarizeWin32LegacySandboxMigration(result) {
  if (!result) return "no result";
  if (result.status === "skipped") return `skipped (${result.reason})`;
  const aclCount = result.targets?.aclPaths?.length || 0;
  const profileCount = result.targets?.profileNames?.length || 0;
  return `${result.status}; cleanup=${result.cleanup ? "on" : "off"}; aclPaths=${aclCount}; profiles=${profileCount}`;
}
