import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildDesktopReleaseCommand,
  runDesktopRelease,
} from "../scripts/release-desktop-with-profile.mjs";

function validPem() {
  return generateKeyPairSync("ed25519").privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
}

describe("attended desktop release command", () => {
  it("uses the shared auto resolver and a platform-specific npm executable", () => {
    const command = buildDesktopReleaseCommand({
      requested: "auto",
      env: {},
      platform: "win32",
    });

    expect(command).toMatchObject({
      profile: "legacy-raw",
      command: "npm.cmd",
      args: ["run", "dist"],
    });
    expect(command.env.HANA_RELEASE_PROFILE).toBe("legacy-raw");
  });

  it.each([
    ["pack", "pack"],
    ["install", "install:local"],
    ["dist", "dist"],
  ])("selects the profile-aware %s command", (action, npmScript) => {
    const command = buildDesktopReleaseCommand({ requested: "legacy-raw", action, env: {}, platform: "linux" });
    expect(command.args).toEqual(["run", npmScript]);
    expect(command.env.HANA_RELEASE_PROFILE).toBe("legacy-raw");
  });

  it("materializes inline PEM with mode 0600 and cleans it after the child exits", () => {
    let materializedPath;
    const inlinePem = validPem();
    const spawn = vi.fn((_command, _args, options) => {
      materializedPath = options.env.HANA_SIGN_KEY;
      expect(fs.readFileSync(materializedPath, "utf8")).toBe(inlinePem);
      expect(options.env.HANA_SIGN_KEY_PEM).toBeUndefined();
      expect(fs.statSync(materializedPath).mode & 0o777).toBe(0o600);
      return { status: 0 };
    });

    const result = runDesktopRelease({
      requested: "signed",
      action: "pack",
      env: { HANA_SIGN_KEY_PEM: inlinePem },
      platform: "linux",
      spawn,
    });

    expect(result.status).toBe(0);
    expect(materializedPath).toBeTruthy();
    expect(fs.existsSync(materializedPath)).toBe(false);
  });

  it("preserves an explicitly supplied key path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-explicit-key-"));
    const keyPath = path.join(dir, "signing.pem");
    fs.writeFileSync(keyPath, validPem(), { mode: 0o600 });
    const spawn = vi.fn((_command, _args, options) => {
      expect(options.env.HANA_SIGN_KEY).toBe(keyPath);
      return { status: 0 };
    });

    try {
      runDesktopRelease({ requested: "signed", env: { HANA_SIGN_KEY: keyPath }, platform: "linux", spawn });
      expect(fs.existsSync(keyPath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves a valid explicit key path without forwarding redundant inline PEM", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-dual-key-"));
    const keyPath = path.join(dir, "signing.pem");
    const inlinePem = validPem();
    fs.writeFileSync(keyPath, validPem(), { mode: 0o600 });
    const spawn = vi.fn((_command, _args, options) => {
      expect(options.env.HANA_SIGN_KEY).toBe(keyPath);
      expect(options.env.HANA_SIGN_KEY_PEM).toBeUndefined();
      return { status: 0 };
    });

    try {
      runDesktopRelease({
        requested: "signed",
        env: { HANA_SIGN_KEY: keyPath, HANA_SIGN_KEY_PEM: inlinePem },
        platform: "linux",
        spawn,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a whitespace key path as absent and materializes inline PEM", () => {
    let materializedPath;
    const inlinePem = validPem();
    const spawn = vi.fn((_command, _args, options) => {
      materializedPath = options.env.HANA_SIGN_KEY;
      expect(materializedPath.trim()).not.toBe("");
      expect(fs.readFileSync(materializedPath, "utf8")).toBe(inlinePem);
      expect(options.env.HANA_SIGN_KEY_PEM).toBeUndefined();
      expect(fs.statSync(materializedPath).mode & 0o777).toBe(0o600);
      return { status: 0 };
    });

    runDesktopRelease({
      requested: "signed",
      env: { HANA_SIGN_KEY: "   ", HANA_SIGN_KEY_PEM: inlinePem },
      platform: "linux",
      spawn,
    });

    expect(materializedPath).toBeTruthy();
    expect(fs.existsSync(materializedPath)).toBe(false);
  });
});
