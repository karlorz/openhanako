const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeServerPlatformArch,
  parseForkReleaseTag,
} = require("./remote-server-release-catalog.cjs");

const SERVER_BUILD_INFO_FILE_NAME = "server-build-info.json";
const RUNTIME_VERSION_RE = /^\d+\.\d+\.\d+$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/i;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function optionalString(value, pattern) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function normalizeServerBuildInfo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) return null;
  if (typeof value.runtimeVersion !== "string" || !RUNTIME_VERSION_RE.test(value.runtimeVersion)) return null;

  const releaseTag = optionalString(value.releaseTag, /^.+$/);
  const gitSha = optionalString(value.gitSha, GIT_SHA_RE);
  const sourceRepository = optionalString(value.sourceRepository, REPOSITORY_RE);
  if (releaseTag === undefined || gitSha === undefined || sourceRepository === undefined) return null;

  if (releaseTag) {
    const parsed = parseForkReleaseTag(releaseTag);
    if (!parsed || parsed.runtimeVersion !== value.runtimeVersion) return null;
  }

  let platform = null;
  let arch = null;
  const hasRuntimeFacts = value.platform !== null && value.platform !== undefined
    || value.arch !== null && value.arch !== undefined;
  if (hasRuntimeFacts) {
    const normalized = normalizeServerPlatformArch(value.platform, value.arch);
    if (!normalized) return null;
    platform = normalized.platform;
    arch = normalized.arch;
  }

  return Object.freeze({
    schemaVersion: 1,
    runtimeVersion: value.runtimeVersion,
    releaseTag,
    gitSha: gitSha ? gitSha.toLowerCase() : null,
    sourceRepository,
    platform,
    arch,
  });
}

function readServerBuildInfo({ rootDir = null, fsImpl = fs } = {}) {
  if (typeof rootDir !== "string" || rootDir.length === 0) return null;
  try {
    const value = JSON.parse(fsImpl.readFileSync(path.join(rootDir, SERVER_BUILD_INFO_FILE_NAME), "utf8"));
    return normalizeServerBuildInfo(value);
  } catch {
    return null;
  }
}

module.exports = {
  SERVER_BUILD_INFO_FILE_NAME,
  normalizeServerBuildInfo,
  readServerBuildInfo,
};
