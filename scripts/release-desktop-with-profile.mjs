#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const {
  resolveReleaseProfileFromEnv,
} = require("../shared/release-profile.cjs");

export function buildDesktopReleaseCommand({
  requested = "auto",
  action = "dist",
  env = process.env,
  platform = process.platform,
} = {}) {
  const npmScripts = { dist: "dist", pack: "pack", install: "install:local" };
  if (!npmScripts[action]) {
    throw new TypeError(`Unknown desktop release action: ${action}. Expected dist, pack, or install.`);
  }
  const result = resolveReleaseProfileFromEnv({ requested, env });
  return {
    ...result,
    command: platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", npmScripts[action]],
    env: { ...env, HANA_RELEASE_PROFILE: result.profile },
  };
}

function parseArgs(argv) {
  const args = { requested: "auto", action: "dist" };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--profile" && option !== "--action") {
      throw new TypeError("Usage: node scripts/release-desktop-with-profile.mjs [--profile auto|signed|legacy-raw] [--action dist|pack|install]");
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
    if (option === "--profile") args.requested = value;
    else args.action = value;
  }
  return args;
}

function executeDesktopRelease(release, spawn = spawnSync) {
  let tempDir = null;
  try {
    if (release.profile === "signed" && !release.env.HANA_SIGN_KEY && release.env.HANA_SIGN_KEY_PEM) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-sign-key-"));
      const keyPath = path.join(tempDir, "signing.pem");
      fs.writeFileSync(keyPath, release.env.HANA_SIGN_KEY_PEM, { mode: 0o600 });
      fs.chmodSync(keyPath, 0o600);
      release.env.HANA_SIGN_KEY = keyPath;
      delete release.env.HANA_SIGN_KEY_PEM;
    }
    const child = spawn(release.command, release.args, { env: release.env, stdio: "inherit" });
    if (child.error) throw child.error;
    return child;
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function runDesktopRelease({
  requested = "auto",
  action = "dist",
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
} = {}) {
  const release = buildDesktopReleaseCommand({ requested, action, env, platform });
  return executeDesktopRelease(release, spawn);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const release = buildDesktopReleaseCommand(args);
  console.log(`[release-desktop] resolved ${release.profile} (${release.reason})`);
  const child = executeDesktopRelease(release);
  if (child.status !== 0) process.exitCode = child.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[release-desktop] ${error?.message || error}`);
    process.exitCode = 1;
  }
}
