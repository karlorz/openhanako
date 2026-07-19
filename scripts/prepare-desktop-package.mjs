#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { signAndSmokeTestServerRuntime } from "./build-server-artifact.mjs";

const require = createRequire(import.meta.url);
const { LEGACY_RAW_PROFILE } = require("../shared/release-profile.cjs");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function prepareDesktopPackage({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  root = rootDir,
  signAndSmoke = signAndSmokeTestServerRuntime,
} = {}) {
  if (env.HANA_RELEASE_PROFILE !== LEGACY_RAW_PROFILE || platform !== "darwin") {
    return { skipped: true };
  }
  const normalizedArch = arch === "arm64" ? "arm64" : "x64";
  const outDir = path.join(root, "dist-server", `mac-${normalizedArch}`);
  await signAndSmoke(outDir, { env });
  return { skipped: false, outDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await prepareDesktopPackage();
  } catch (error) {
    console.error(`[prepare-desktop-package] ${error?.message || error}`);
    process.exitCode = 1;
  }
}
