import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const rootDir = process.cwd();
const scriptPath = path.join(rootDir, "scripts", "resolve-release-profile.mjs");

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.HANA_SIGN_KEY;
  delete env.HANA_SIGN_KEY_PEM;
  return { ...env, ...extra };
}

function validPem() {
  return generateKeyPairSync("ed25519").privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
}

describe("resolve-release-profile CLI", () => {
  it("resolves absent key material to marked legacy raw without printing the secret", () => {
    const output = execFileSync(process.execPath, [scriptPath, "--requested", "auto", "--json"], {
      cwd: rootDir,
      env: cleanEnv(),
      encoding: "utf8",
    });
    const value = JSON.parse(output);
    expect(value).toEqual({ profile: "legacy-raw", reason: "auto-no-signing-key" });
    expect(output).not.toContain("HANA_SIGN_KEY_PEM");
  });

  it("writes only the concrete profile and reason to a GitHub output file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-release-profile-"));
    const outputPath = path.join(tempDir, "github-output");
    try {
      execFileSync(process.execPath, [
        scriptPath,
        "--requested", "auto",
        "--github-output", outputPath,
      ], {
        cwd: rootDir,
        env: cleanEnv({ HANA_SIGN_KEY_PEM: validPem() }),
        encoding: "utf8",
      });
      expect(fs.readFileSync(outputPath, "utf8")).toBe(
        "release_profile=signed\nrelease_profile_reason=auto-signing-key\n",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects an explicit signed request when signing material is absent", () => {
    expect(() => execFileSync(process.execPath, [scriptPath, "--requested", "signed", "--json"], {
      cwd: rootDir,
      env: cleanEnv(),
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow(/signing material/i);
  });

  it("fails auto resolution for malformed configured material", () => {
    const child = spawnSync(process.execPath, [scriptPath, "--requested", "auto", "--json"], {
      cwd: rootDir,
      env: cleanEnv({ HANA_SIGN_KEY_PEM: "malformed" }),
      encoding: "utf8",
    });

    expect(child.status).not.toBe(0);
    expect(child.stderr).toMatch(/Ed25519/i);
    expect(child.stdout).not.toContain("legacy-raw");
  });

  it("rejects missing CLI option values", () => {
    const child = spawnSync(process.execPath, [scriptPath, "--requested"], {
      cwd: rootDir,
      env: cleanEnv(),
      encoding: "utf8",
    });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toMatch(/requires a value/i);
  });

  it("fails explicit legacy raw for configured but unusable signing material", () => {
    const missingPath = spawnSync(process.execPath, [scriptPath, "--requested", "legacy-raw", "--json"], {
      cwd: rootDir,
      env: cleanEnv({ HANA_SIGN_KEY: "/definitely/missing/hana-sign-key.pem" }),
      encoding: "utf8",
    });
    const malformedInline = spawnSync(process.execPath, [scriptPath, "--requested", "legacy-raw", "--json"], {
      cwd: rootDir,
      env: cleanEnv({ HANA_SIGN_KEY_PEM: "malformed" }),
      encoding: "utf8",
    });

    expect(missingPath.status).not.toBe(0);
    expect(missingPath.stderr).toMatch(/HANA_SIGN_KEY/i);
    expect(malformedInline.status).not.toBe(0);
    expect(malformedInline.stderr).toMatch(/Ed25519/i);
    expect(missingPath.stdout).not.toContain("legacy-raw");
    expect(malformedInline.stdout).not.toContain("legacy-raw");
  });

  it("rejects an output option without a file path", () => {
    expect(() => execFileSync(process.execPath, [scriptPath, "--github-output"], {
      cwd: rootDir,
      env: { ...process.env },
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow(/requires a path/i);
  });
});
