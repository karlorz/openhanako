"use strict";

const SIGNED_PROFILE = "signed";
const LEGACY_RAW_PROFILE = "legacy-raw";
const SERVER_BUILD_SEED = "seed";
const SERVER_BUILD_RUNTIME_ONLY = "runtime-only";

function normalizeReleaseProfile(value, fallback = SIGNED_PROFILE) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!candidate) {
    const normalizedFallback = typeof fallback === "string" ? fallback.trim().toLowerCase() : "";
    if (normalizedFallback === SIGNED_PROFILE) return SIGNED_PROFILE;
    if (normalizedFallback === LEGACY_RAW_PROFILE) return LEGACY_RAW_PROFILE;
    throw new TypeError(`Unknown release profile fallback: ${fallback}`);
  }
  if (candidate === SIGNED_PROFILE || candidate === LEGACY_RAW_PROFILE) return candidate;
  throw new TypeError(`Unknown release profile: ${value}. Expected signed or legacy-raw.`);
}

function resolveServerBuildMode(env = process.env) {
  const explicit = typeof env?.HANA_SERVER_BUILD_MODE === "string"
    ? env.HANA_SERVER_BUILD_MODE.trim().toLowerCase()
    : "";
  if (explicit === SERVER_BUILD_SEED || explicit === SERVER_BUILD_RUNTIME_ONLY) {
    return explicit;
  }
  if (explicit) {
    throw new TypeError(
      `HANA_SERVER_BUILD_MODE must be ${SERVER_BUILD_SEED} or ${SERVER_BUILD_RUNTIME_ONLY}; received ${env.HANA_SERVER_BUILD_MODE}`,
    );
  }
  return normalizeReleaseProfile(env?.HANA_RELEASE_PROFILE) === LEGACY_RAW_PROFILE
    ? SERVER_BUILD_RUNTIME_ONLY
    : SERVER_BUILD_SEED;
}

function artifactUpdatesEnabledForProfile(profile, updateEnabled = true) {
  return normalizeReleaseProfile(profile) === SIGNED_PROFILE && updateEnabled !== false;
}

module.exports = {
  LEGACY_RAW_PROFILE,
  SIGNED_PROFILE,
  SERVER_BUILD_RUNTIME_ONLY,
  SERVER_BUILD_SEED,
  artifactUpdatesEnabledForProfile,
  normalizeReleaseProfile,
  resolveServerBuildMode,
};
