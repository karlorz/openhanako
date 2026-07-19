import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUTO_PROFILE,
  LEGACY_RAW_PROFILE,
  SIGNED_PROFILE,
  inspectSigningKeyState,
  normalizeReleaseProfile,
  normalizeReleaseProfileRequest,
  resolveRequestedReleaseProfile,
  resolveServerBuildMode,
} from "../shared/release-profile.cjs";
import { normalizeBuildInfo } from "../desktop/src/shared/build-info.cjs";

const tempDirs = [];

function privateKeyPem(type = "ed25519") {
  const options = type === "rsa" ? { modulusLength: 2048 } : undefined;
  const { privateKey } = generateKeyPairSync(type, options);
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

function writeTempKey(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-release-key-"));
  tempDirs.push(dir);
  const keyPath = path.join(dir, "signing.pem");
  fs.writeFileSync(keyPath, contents);
  return keyPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("release profile contract", () => {
  it("defaults to the fail-closed signed profile", () => {
    expect(normalizeReleaseProfile()).toBe(SIGNED_PROFILE);
    expect(normalizeReleaseProfile(" ")).toBe(SIGNED_PROFILE);
  });

  it("accepts only the explicit legacy raw profile", () => {
    expect(normalizeReleaseProfile(LEGACY_RAW_PROFILE)).toBe(LEGACY_RAW_PROFILE);
    expect(() => normalizeReleaseProfile("unsigned"))
      .toThrow(/release profile/i);
  });

  it("accepts auto only as a request and resolves it to a concrete profile", () => {
    expect(normalizeReleaseProfileRequest("auto")).toBe(AUTO_PROFILE);
    expect(resolveRequestedReleaseProfile({ requested: AUTO_PROFILE, keyState: "available" }))
      .toEqual({ profile: SIGNED_PROFILE, reason: "auto-signing-key" });
    expect(resolveRequestedReleaseProfile({ requested: AUTO_PROFILE, keyState: "absent" }))
      .toEqual({ profile: LEGACY_RAW_PROFILE, reason: "auto-no-signing-key" });
    expect(() => normalizeReleaseProfile("auto")).toThrow(/release profile/i);
  });

  it("fails closed for an explicit signed request without signing material", () => {
    expect(resolveRequestedReleaseProfile({ requested: SIGNED_PROFILE, keyState: "available" }))
      .toEqual({ profile: SIGNED_PROFILE, reason: "explicit-signed" });
    expect(() => resolveRequestedReleaseProfile({ requested: SIGNED_PROFILE, keyState: "absent" }))
      .toThrow(/signing material/i);
    expect(resolveRequestedReleaseProfile({ requested: LEGACY_RAW_PROFILE, keyState: "available" }))
      .toEqual({ profile: LEGACY_RAW_PROFILE, reason: "explicit-legacy-raw" });
  });

  it("accepts only usable Ed25519 private signing material", () => {
    const validPem = privateKeyPem();
    const validPath = writeTempKey(validPem);

    expect(inspectSigningKeyState({})).toBe("absent");
    expect(inspectSigningKeyState({ HANA_SIGN_KEY_PEM: validPem })).toBe("available");
    expect(inspectSigningKeyState({ HANA_SIGN_KEY: validPath })).toBe("available");
    expect(inspectSigningKeyState({ HANA_SIGN_KEY_PEM: "" })).toBe("absent");
    expect(inspectSigningKeyState({ HANA_SIGN_KEY: "" })).toBe("absent");
    expect(inspectSigningKeyState({ HANA_SIGN_KEY_PEM: " \n\t", HANA_SIGN_KEY: "  " })).toBe("absent");
    expect(() => inspectSigningKeyState({ HANA_SIGN_KEY_PEM: "not a pem" })).toThrow(/Ed25519/i);
    expect(() => inspectSigningKeyState({ HANA_SIGN_KEY_PEM: privateKeyPem("rsa") })).toThrow(/Ed25519/i);
    expect(() => inspectSigningKeyState({ HANA_SIGN_KEY: writeTempKey("not a pem") })).toThrow(/Ed25519/i);
    expect(() => inspectSigningKeyState({ HANA_SIGN_KEY: "/definitely/missing/hana-sign-key.pem" }))
      .toThrow(/HANA_SIGN_KEY/);
  });

  it("validates every configured signing input instead of hiding a broken path", () => {
    expect(() => inspectSigningKeyState({
      HANA_SIGN_KEY_PEM: privateKeyPem(),
      HANA_SIGN_KEY: "/definitely/missing/hana-sign-key.pem",
    })).toThrow(/HANA_SIGN_KEY/);
  });

  it("rejects a configured but unreadable local signing key", () => {
    const unreadableFs = {
      readFileSync() {
        throw new Error("permission denied");
      },
    };

    expect(() => inspectSigningKeyState({ HANA_SIGN_KEY: "/configured/key.pem" }, unreadableFs))
      .toThrow(/HANA_SIGN_KEY/);
  });

  it("selects runtime-only server output only when explicitly requested", () => {
    expect(resolveServerBuildMode({})).toBe("seed");
    expect(resolveServerBuildMode({ HANA_RELEASE_PROFILE: LEGACY_RAW_PROFILE })).toBe("runtime-only");
    expect(resolveServerBuildMode({ HANA_SERVER_BUILD_MODE: "runtime-only" })).toBe("runtime-only");
    expect(() => resolveServerBuildMode({ HANA_SERVER_BUILD_MODE: "raw-but-unknown" }))
      .toThrow(/HANA_SERVER_BUILD_MODE/);
  });

  it("forces update paths off for a marked legacy package", () => {
    expect(normalizeBuildInfo({
      releaseProfile: LEGACY_RAW_PROFILE,
      updateEnabled: true,
      artifactUpdatesEnabled: true,
    })).toMatchObject({
      releaseProfile: LEGACY_RAW_PROFILE,
      updateEnabled: false,
      artifactUpdatesEnabled: false,
    });
    expect(normalizeBuildInfo({ releaseProfile: SIGNED_PROFILE }))
      .toMatchObject({ releaseProfile: SIGNED_PROFILE, updateEnabled: true, artifactUpdatesEnabled: true });
  });
});
