"use strict";

const {
  LEGACY_RAW_PROFILE,
  normalizeReleaseProfile,
} = require("../shared/release-profile.cjs");

function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function markLegacyArtifactName(value) {
  if (typeof value !== "string" || value.includes("-legacy-raw.")) return value;
  return value.replace(/\.\$\{ext\}$/, "-legacy-raw.${ext}");
}

function createElectronBuilderConfig({ profile, baseConfig }) {
  const normalizedProfile = normalizeReleaseProfile(profile);
  const config = cloneConfig(baseConfig);
  if (normalizedProfile !== LEGACY_RAW_PROFILE) return config;

  config.files = Array.isArray(config.files) ? [...config.files] : [];
  if (!config.files.includes("desktop/dist-renderer/**")) {
    config.files.push("desktop/dist-renderer/**");
  }

  const resources = Array.isArray(config.extraResources) ? config.extraResources : [];
  config.extraResources = resources.filter((resource) => resource?.to !== "seed/");
  if (!config.extraResources.some((resource) => resource?.to === "server/")) {
    config.extraResources.push({ from: "dist-server/${os}-${arch}/", to: "server/" });
  }

  for (const platform of ["mac", "win", "linux"]) {
    if (!config[platform] || typeof config[platform] !== "object") continue;
    if (config[platform].artifactName) {
      config[platform].artifactName = markLegacyArtifactName(config[platform].artifactName);
    }
  }
  return config;
}

module.exports = {
  createElectronBuilderConfig,
  markLegacyArtifactName,
};
