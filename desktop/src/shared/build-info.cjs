const fs = require("fs");
const path = require("path");

const BUILD_INFO_FILE_NAME = "build-info.json";

const DEFAULT_BUILD_INFO = Object.freeze({
  appVersion: null,
  channel: "release",
  sourceRepo: "liliMozi/openhanako",
  gitSha: null,
  baseTag: null,
  dirty: null,
  updateEnabled: true,
  signatureKind: null,
});

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBuildInfo(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const channel = stringOrNull(input.channel) || DEFAULT_BUILD_INFO.channel;
  return {
    appVersion: stringOrNull(input.appVersion),
    channel,
    sourceRepo: stringOrNull(input.sourceRepo) || DEFAULT_BUILD_INFO.sourceRepo,
    gitSha: stringOrNull(input.gitSha),
    baseTag: stringOrNull(input.baseTag),
    dirty: typeof input.dirty === "boolean" ? input.dirty : null,
    updateEnabled: input.updateEnabled === false ? false : true,
    signatureKind: stringOrNull(input.signatureKind),
  };
}

function resolveBuildInfoPath({ resourcesPath = process.resourcesPath } = {}) {
  if (!resourcesPath) return null;
  return path.join(resourcesPath, BUILD_INFO_FILE_NAME);
}

function readBuildInfo(options = {}) {
  const filePath = resolveBuildInfoPath(options);
  if (!filePath) return normalizeBuildInfo();

  try {
    return normalizeBuildInfo(JSON.parse(fs.readFileSync(filePath, "utf-8")));
  } catch {
    return normalizeBuildInfo();
  }
}

module.exports = {
  BUILD_INFO_FILE_NAME,
  DEFAULT_BUILD_INFO,
  normalizeBuildInfo,
  readBuildInfo,
  resolveBuildInfoPath,
};
