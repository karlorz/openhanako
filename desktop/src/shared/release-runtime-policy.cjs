"use strict";

const fs = require("fs");
const path = require("path");
const {
  LEGACY_RAW_PROFILE,
  SIGNED_PROFILE,
  artifactUpdatesEnabledForProfile,
  normalizeReleaseProfile,
} = require("../../../shared/release-profile.cjs");

const RAW_SERVER_REQUIRED_FILES = [
  "bootstrap.js",
  "bundle/index.js",
  "server-build-info.json",
];

function pathExists(fsImpl, filePath) {
  try {
    return fsImpl.existsSync(filePath);
  } catch {
    return false;
  }
}

function directoryExists(fsImpl, filePath) {
  if (!pathExists(fsImpl, filePath)) return false;
  try {
    return fsImpl.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(fsImpl, filePath) {
  if (!pathExists(fsImpl, filePath)) return false;
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readObject(fsImpl, filePath) {
  try {
    const value = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizeBuildMetadata(buildInfo) {
  const value = buildInfo && typeof buildInfo === "object" ? buildInfo : {};
  const releaseProfile = normalizeReleaseProfile(value.releaseProfile);
  return {
    ...value,
    releaseProfile,
    artifactUpdatesEnabled: artifactUpdatesEnabledForProfile(
      releaseProfile,
      value.artifactUpdatesEnabled !== false && value.updateEnabled !== false,
    ) && value.artifactUpdatesEnabled !== false,
  };
}

function validateRawLayout({ fsImpl, serverRoot, rendererRoot }) {
  const missing = [];
  const serverRendererRoot = path.join(serverRoot, "desktop", "dist-renderer");
  const wrappers = ["hana-server", "hana-server.exe"];
  if (!wrappers.some((name) => fileExists(fsImpl, path.join(serverRoot, name)))) {
    missing.push("server/hana-server or server/hana-server.exe");
  }
  for (const relativePath of RAW_SERVER_REQUIRED_FILES) {
    if (!fileExists(fsImpl, path.join(serverRoot, ...relativePath.split("/")))) {
      missing.push(`server/${relativePath}`);
    }
  }
  const runtimes = ["node", "node.exe", "hana-server.exe"];
  if (!runtimes.some((name) => fileExists(fsImpl, path.join(serverRoot, name)))) {
    missing.push("server/node or server/hana-server.exe");
  }
  if (!fileExists(fsImpl, path.join(rendererRoot, "index.html"))) {
    missing.push("bundled renderer index.html");
  }
  if (!fileExists(fsImpl, path.join(serverRendererRoot, "mobile.html"))) {
    missing.push("server/desktop/dist-renderer/mobile.html");
  }

  if (missing.length > 0) {
    throw new Error(`legacy-raw packaged layout is incomplete: ${missing.join(", ")}`);
  }

  const serverBuildInfo = readObject(fsImpl, path.join(serverRoot, "server-build-info.json"));
  if (!serverBuildInfo) {
    throw new Error("legacy-raw server-build-info.json must contain a JSON object");
  }
}

/**
 * Resolve the only packaged resource layout permitted for this build.
 *
 * Dev mode intentionally returns before inspecting resources. Packaged builds
 * must choose exactly one of the signed seed layout or the explicitly marked
 * legacy raw layout; a raw tree without the marker is never accepted.
 */
function resolvePackagedLayout({
  appIsPackaged,
  resourcesPath,
  buildInfo,
  rendererRoot,
  fsImpl = fs,
} = {}) {
  if (!appIsPackaged) return { mode: "dev" };
  if (!resourcesPath) throw new Error("Packaged app resourcesPath is missing");

  const metadata = normalizeBuildMetadata(buildInfo);
  const seedRoot = path.join(resourcesPath, "seed");
  const serverRoot = path.join(resourcesPath, "server");
  const hasSeed = directoryExists(fsImpl, seedRoot);
  const hasRaw = directoryExists(fsImpl, serverRoot);

  if (hasSeed && hasRaw) {
    throw new Error(
      `Mixed packaged layout detected: both ${seedRoot} and ${serverRoot} are present. `
        + "Reinstall HanaAgent with one release profile.",
    );
  }

  if (metadata.releaseProfile === LEGACY_RAW_PROFILE) {
    if (hasSeed) {
      throw new Error("legacy-raw release profile cannot contain a signed seed layout");
    }
    if (!hasRaw) {
      throw new Error(`legacy-raw packaged layout is missing ${serverRoot}`);
    }
    validateRawLayout({
      fsImpl,
      serverRoot,
      rendererRoot: rendererRoot || path.join(resourcesPath, "app", "desktop", "dist-renderer"),
    });
    return {
      mode: LEGACY_RAW_PROFILE,
      serverRoot,
      rendererRoot: rendererRoot || path.join(resourcesPath, "app", "desktop", "dist-renderer"),
      serverRendererRoot: path.join(serverRoot, "desktop", "dist-renderer"),
      buildInfo: metadata,
    };
  }

  if (hasRaw && !hasSeed) {
    throw new Error(
      `Unmarked legacy raw layout detected at ${serverRoot}. `
        + "Set HANA_RELEASE_PROFILE=legacy-raw and rebuild; refusing to boot unmarked resources.",
    );
  }
  if (!hasSeed) {
    throw new Error(
      `Missing packaged artifact layout under ${resourcesPath}. `
        + "Expected signed seed resources or an explicitly marked legacy-raw package.",
    );
  }
  for (const relativePath of ["seed-train.json", "seed-train.json.sig"]) {
    if (!fileExists(fsImpl, path.join(seedRoot, relativePath))) {
      throw new Error(`Signed packaged layout is missing seed/${relativePath}`);
    }
  }
  return { mode: SIGNED_PROFILE, seedRoot, buildInfo: metadata };
}

function artifactUpdateAvailability(buildInfo) {
  const metadata = normalizeBuildMetadata(buildInfo);
  if (metadata.releaseProfile === LEGACY_RAW_PROFILE) {
    return { enabled: false, reason: "Artifact OTA is disabled for legacy-raw packages" };
  }
  if (metadata.channel === "local" || metadata.channel === "dev") {
    return { enabled: false, reason: "Artifact OTA is disabled for local development builds" };
  }
  if (metadata.updateEnabled === false || metadata.artifactUpdatesEnabled !== true) {
    return { enabled: false, reason: "Artifact OTA is disabled by build metadata" };
  }
  return { enabled: true, reason: null };
}

module.exports = {
  RAW_SERVER_REQUIRED_FILES,
  artifactUpdateAvailability,
  resolvePackagedLayout,
};
