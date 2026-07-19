"use strict";

const { createPrivateKey } = require("node:crypto");

const AUTO_PROFILE = "auto";
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

function normalizeReleaseProfileRequest(value, fallback = AUTO_PROFILE) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!candidate) return normalizeReleaseProfileRequest(fallback, AUTO_PROFILE);
  if (candidate === AUTO_PROFILE || candidate === SIGNED_PROFILE || candidate === LEGACY_RAW_PROFILE) {
    return candidate;
  }
  throw new TypeError(`Unknown release profile request: ${value}. Expected auto, signed, or legacy-raw.`);
}

function inspectSigningKeyState(env = process.env, fs = require("fs")) {
  const inlineConfigured = typeof env?.HANA_SIGN_KEY_PEM === "string" && env.HANA_SIGN_KEY_PEM.trim() !== "";
  const fileConfigured = typeof env?.HANA_SIGN_KEY === "string" && env.HANA_SIGN_KEY.trim() !== "";
  if (!inlineConfigured && !fileConfigured) return "absent";

  const validatePrivateEd25519 = (name, material) => {
    try {
      const key = createPrivateKey(material);
      if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
        throw new Error("key is not a private Ed25519 key");
      }
    } catch (error) {
      if (error?.message?.includes("private Ed25519 key")) {
        throw new Error(`${name} must contain a private Ed25519 key.`);
      }
      throw new Error(`${name} must contain a parseable private Ed25519 key.`);
    }
  };

  if (inlineConfigured) validatePrivateEd25519("HANA_SIGN_KEY_PEM", env.HANA_SIGN_KEY_PEM);

  if (fileConfigured) {
    let material;
    try {
      material = fs.readFileSync(env.HANA_SIGN_KEY);
    } catch {
      throw new Error("HANA_SIGN_KEY is configured but signing material cannot be read.");
    }
    validatePrivateEd25519("HANA_SIGN_KEY", material);
  }
  return "available";
}

function resolveRequestedReleaseProfile({ requested = AUTO_PROFILE, keyState }) {
  const normalizedRequest = normalizeReleaseProfileRequest(requested);
  if (keyState !== "available" && keyState !== "absent") {
    throw new TypeError(`Unknown signing key state: ${keyState}. Expected available or absent.`);
  }
  if (normalizedRequest === LEGACY_RAW_PROFILE) {
    return { profile: LEGACY_RAW_PROFILE, reason: "explicit-legacy-raw" };
  }
  if (normalizedRequest === SIGNED_PROFILE) {
    if (keyState !== "available") {
      throw new Error("Signed releases require available signing material.");
    }
    return { profile: SIGNED_PROFILE, reason: "explicit-signed" };
  }
  return keyState === "available"
    ? { profile: SIGNED_PROFILE, reason: "auto-signing-key" }
    : { profile: LEGACY_RAW_PROFILE, reason: "auto-no-signing-key" };
}

function resolveReleaseProfileFromEnv({
  requested = AUTO_PROFILE,
  env = process.env,
  fs = require("fs"),
} = {}) {
  const normalizedRequest = normalizeReleaseProfileRequest(requested);
  const keyState = normalizedRequest === LEGACY_RAW_PROFILE
    ? "absent"
    : inspectSigningKeyState(env, fs);
  return resolveRequestedReleaseProfile({ requested: normalizedRequest, keyState });
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
  AUTO_PROFILE,
  LEGACY_RAW_PROFILE,
  SIGNED_PROFILE,
  SERVER_BUILD_RUNTIME_ONLY,
  SERVER_BUILD_SEED,
  artifactUpdatesEnabledForProfile,
  inspectSigningKeyState,
  normalizeReleaseProfile,
  normalizeReleaseProfileRequest,
  resolveReleaseProfileFromEnv,
  resolveRequestedReleaseProfile,
  resolveServerBuildMode,
};
