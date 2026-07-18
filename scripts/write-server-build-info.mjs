#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import buildInfoModule from "../shared/server-build-info.cjs";
import releaseCatalogModule from "../shared/remote-server-release-catalog.cjs";

const { SERVER_BUILD_INFO_FILE_NAME, normalizeServerBuildInfo } = buildInfoModule;
const { parseForkReleaseTag } = releaseCatalogModule;
const __filename = fileURLToPath(import.meta.url);

export function createServerBuildInfo({
  rootDir,
  releaseTag = null,
  gitSha = null,
  sourceRepository = null,
  platform = null,
  arch = null,
  fsImpl = fs,
} = {}) {
  const packageJson = JSON.parse(fsImpl.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const runtimeVersion = packageJson?.version;
  if (typeof runtimeVersion !== "string") throw new TypeError("Server package version is missing");

  if (releaseTag) {
    const parsed = parseForkReleaseTag(releaseTag);
    if (!parsed) throw new TypeError(`Invalid fork release tag: ${releaseTag}`);
    if (parsed.runtimeVersion !== runtimeVersion) {
      throw new TypeError(`Fork release tag ${releaseTag} does not match package version ${runtimeVersion}`);
    }
  }

  const buildInfo = normalizeServerBuildInfo({
    schemaVersion: 1,
    runtimeVersion,
    releaseTag,
    gitSha,
    sourceRepository,
    platform,
    arch,
  });
  if (!buildInfo) throw new TypeError("Invalid server build evidence");
  return buildInfo;
}

export function writeServerBuildInfo({ outputRoot, fsImpl = fs, ...options } = {}) {
  const buildInfo = createServerBuildInfo({ ...options, fsImpl });
  const outputPath = path.join(outputRoot, SERVER_BUILD_INFO_FILE_NAME);
  fsImpl.writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
  return { outputPath, buildInfo };
}

if (process.argv[1] === __filename) {
  const [, , outputRoot, releaseTag = "", gitSha = "", sourceRepository = "", platform = "", arch = ""] = process.argv;
  if (!outputRoot) {
    console.error("usage: write-server-build-info.mjs <output-root> [release-tag] [git-sha] [source-repository] [platform] [arch]");
    process.exit(2);
  }
  console.log(JSON.stringify(writeServerBuildInfo({
    outputRoot,
    rootDir: outputRoot,
    releaseTag: releaseTag || null,
    gitSha: gitSha || null,
    sourceRepository: sourceRepository || null,
    platform: platform || null,
    arch: arch || null,
  }), null, 2));
}
