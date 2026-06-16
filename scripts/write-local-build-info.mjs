#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BUILD_INFO_FILE_NAME = "build-info.json";

function readPackageVersion(rootDir) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
  return packageJson.version || null;
}

function gitOutput(args, { rootDir, execFileSyncImpl = execFileSync } = {}) {
  try {
    return execFileSyncImpl("git", args, {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function createLocalBuildInfo({
  rootDir = path.resolve(__dirname, ".."),
  env = process.env,
  execFileSyncImpl = execFileSync,
} = {}) {
  const gitSha = env.HANA_LOCAL_BUILD_SHA
    || gitOutput(["rev-parse", "--short=12", "HEAD"], { rootDir, execFileSyncImpl });
  const baseTag = env.HANA_LOCAL_BUILD_BASE_TAG
    || gitOutput(["describe", "--tags", "--abbrev=0", "HEAD"], { rootDir, execFileSyncImpl });
  const dirtyOutput = gitOutput(["status", "--porcelain"], { rootDir, execFileSyncImpl });

  return {
    appVersion: readPackageVersion(rootDir),
    channel: "local",
    sourceRepo: env.HANA_LOCAL_BUILD_SOURCE_REPO || "karlorz/openhanako",
    gitSha,
    baseTag,
    dirty: dirtyOutput === null ? null : dirtyOutput.length > 0,
    updateEnabled: false,
    signatureKind: "adhoc",
  };
}

export function writeLocalBuildInfo({
  appPath = "/Applications/HanaAgent.app",
  rootDir = path.resolve(__dirname, ".."),
  env = process.env,
  execFileSyncImpl = execFileSync,
} = {}) {
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const outputPath = path.join(resourcesDir, BUILD_INFO_FILE_NAME);
  const buildInfo = createLocalBuildInfo({ rootDir, env, execFileSyncImpl });

  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf-8");
  return { outputPath, buildInfo };
}

export async function main() {
  const appPath = process.argv[2] || process.env.HANA_LOCAL_BUILD_APP || "/Applications/HanaAgent.app";
  const { outputPath, buildInfo } = writeLocalBuildInfo({ appPath });
  console.log(`[write-local-build-info] wrote ${outputPath}`);
  console.log(`[write-local-build-info] ${buildInfo.sourceRepo}@${buildInfo.gitSha || "unknown"} (${buildInfo.baseTag || "no-tag"})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[write-local-build-info] ${err?.message || err}`);
    process.exitCode = 1;
  });
}
