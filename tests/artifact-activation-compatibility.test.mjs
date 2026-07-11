import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildArtifactActivationCompatibilityReport,
  buildStatusPlan,
  buildUpgradePlan,
  executeUpgradePlan,
  probeInstallActivationState,
  summarizeBackupRequiredState,
} from "../scripts/install-server.mjs";
import {
  buildServerRuntimePackagingCompatibilityReport,
} from "../scripts/build-server-runtime-assets.mjs";

const ARM64_SHA256 = "a".repeat(64);

const metadata = {
  tag: "v0.400.0",
  prerelease: false,
  assets: [
    {
      platform: "linux",
      arch: "arm64",
      name: "hanaagent-server-v0.400.0-linux-arm64.tar.gz",
      url: "https://example.test/hanaagent-server-v0.400.0-linux-arm64.tar.gz",
      sha256: ARM64_SHA256,
    },
  ],
};

describe("artifact activation compatibility", () => {
  it("reports the fork's current probe-only activation model", () => {
    const report = buildArtifactActivationCompatibilityReport();
    expect(report).toEqual(expect.objectContaining({
      safeExtraction: "probe-only",
      manifestSignature: "probe-only",
      pointerStore: "not-adopted",
      atomicActivation: "current-symlink",
      rollback: "current-release-symlink",
      productionBehaviorChanged: false,
    }));
  });

  it("keeps status planning read-only while exposing the activation probe step", () => {
    const plan = buildStatusPlan({ hostProfile: "sg01" });
    expect(plan.steps.every((step) => step.readOnly)).toBe(true);
    expect(plan.steps.map((step) => step.id)).toContain("probe-activation-compatibility");
    expect(plan.steps.map((step) => step.command).join("\n")).not.toMatch(/ln -sfn|extract|write pointer|rm -rf/i);
  });

  it("probes install activation state without mutating links or pointers", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-activation-probe-"));
    const installRoot = path.join(tmpDir, "opt", "hanaagent");
    const releasesDir = path.join(installRoot, "releases");
    const previousRelease = path.join(releasesDir, "v0.323.0-linux-arm64");
    const currentLink = path.join(installRoot, "current");
    const backupDir = path.join(installRoot, "backups");
    const candidateRoot = path.join(tmpDir, "candidate");
    fs.mkdirSync(previousRelease, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(path.join(candidateRoot, "shared", "artifact-core"), { recursive: true });
    fs.mkdirSync(path.join(candidateRoot, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(backupDir, "hanaagent-backup-1.tar.gz"), "backup\n");
    for (const relative of [
      "shared/artifact-core/index.cjs",
      "shared/artifact-core/activation.cjs",
      "shared/artifact-core/manifest.cjs",
      "shared/artifact-core/pointer-store.cjs",
      "shared/artifact-core/ustar.cjs",
      "scripts/artifact-keygen.mjs",
      "scripts/artifact-sign.mjs",
    ]) {
      fs.writeFileSync(path.join(candidateRoot, relative), "probe-only\n");
    }
    fs.symlinkSync(previousRelease, currentLink);

    const beforeTarget = fs.readlinkSync(currentLink);
    const probe = probeInstallActivationState({
      paths: {
        installRoot,
        releasesDir,
        currentLink,
      },
      candidateRoot,
    });
    const afterTarget = fs.readlinkSync(currentLink);

    expect(afterTarget).toBe(beforeTarget);
    expect(probe).toMatchObject({
      kind: "install-server-activation-probe",
      readOnly: true,
      currentLink,
      currentTarget: previousRelease,
      currentRelease: "v0.323.0-linux-arm64",
      previousReleasePathStrategy: "current-release-symlink",
      backupDir,
      backupArchives: ["hanaagent-backup-1.tar.gz"],
      checksumSupport: {
        inlineSha256: true,
        sidecarSha256: true,
        blocksActivationOnMismatch: true,
      },
      productionBehaviorChanged: false,
      candidateArtifactCore: {
        present: true,
        probed: true,
      },
    });
    expect(probe.artifactActivationCompatibility).toEqual(expect.objectContaining({
      safeExtraction: "probe-only",
      pointerStore: "not-adopted",
      productionBehaviorChanged: false,
    }));
    expect(fs.existsSync(path.join(installRoot, "artifacts"))).toBe(false);
  });

  it("recognizes upstream artifact-core while retaining current-symlink activation", () => {
    const report = buildServerRuntimePackagingCompatibilityReport({ rootDir: process.cwd() });
    expect(report).toMatchObject({
      kind: "server-runtime-packaging-compatibility",
      includesArtifactCore: true,
      artifactCorePathsPresent: [
        "shared/artifact-core/index.cjs",
        "shared/artifact-core/activation.cjs",
        "shared/artifact-core/manifest.cjs",
        "shared/artifact-core/pointer-store.cjs",
        "shared/artifact-core/ustar.cjs",
      ],
      productionBehaviorChanged: false,
      activationModel: "current-symlink",
    });
  });

  it("retains previous release path in upgrade plans for rollback", () => {
    const plan = buildUpgradePlan({
      metadata,
      currentVersion: "v0.323.0",
      platform: "linux",
      arch: "arm64",
      uid: 0,
      hasSudo: false,
      dryRun: true,
      previousReleaseDir: "/opt/hanaagent/releases/v0.323.0-linux-arm64",
    });
    expect(plan.previousReleaseDir).toBe("/opt/hanaagent/releases/v0.323.0-linux-arm64");
    expect(plan.steps.map((step) => step.id)).toEqual(expect.arrayContaining([
      "verify-checksum",
      "switch-current",
    ]));
  });

  it("prevents activation when checksum verification fails", async () => {
    const plan = buildUpgradePlan({
      metadata,
      currentVersion: "v0.323.0",
      platform: "linux",
      arch: "arm64",
      uid: 0,
      hasSudo: false,
      dryRun: false,
    });
    const calls = [];
    const result = await executeUpgradePlan(plan, {
      preflight: async () => calls.push("preflight"),
      backup: async () => calls.push("backup"),
      download: async () => calls.push("download"),
      verifyChecksum: async () => {
        calls.push("verify-checksum");
        throw new Error("sha256 mismatch");
      },
      extractRelease: async () => calls.push("extract-release"),
      switchCurrent: async (target) => calls.push(`switch:${target}`),
      writeSystemdUnit: async () => calls.push("write-unit"),
      restartService: async () => calls.push("restart"),
      healthCheck: async () => calls.push("health-check"),
      rollback: async (target) => calls.push(`rollback:${target}`),
    });

    expect(result).toMatchObject({ ok: false, rolledBack: false, error: "sha256 mismatch" });
    expect(calls).toEqual(["preflight", "backup", "download", "verify-checksum"]);
  });

  it("restores the previous current link after runtime-start failure", async () => {
    const plan = buildUpgradePlan({
      metadata,
      currentVersion: "v0.323.0",
      platform: "linux",
      arch: "arm64",
      uid: 0,
      hasSudo: false,
      dryRun: false,
      previousReleaseDir: "/opt/hanaagent/releases/v0.323.0-linux-arm64",
    });
    const calls = [];
    const result = await executeUpgradePlan(plan, {
      preflight: async () => calls.push("preflight"),
      backup: async () => calls.push("backup"),
      download: async () => calls.push("download"),
      verifyChecksum: async () => calls.push("verify-checksum"),
      extractRelease: async () => calls.push("extract-release"),
      switchCurrent: async (target) => calls.push(`switch:${target}`),
      writeSystemdUnit: async () => calls.push("write-unit"),
      restartService: async () => {
        calls.push("restart");
        throw new Error("runtime start failed");
      },
      healthCheck: async () => calls.push("health-check"),
      rollback: async (target) => calls.push(`rollback:${target}`),
    });

    expect(result).toMatchObject({ ok: false, rolledBack: true });
    expect(calls).toEqual([
      "preflight",
      "backup",
      "download",
      "verify-checksum",
      "extract-release",
      "switch:/opt/hanaagent/releases/v0.400.0-linux-arm64",
      "write-unit",
      "restart",
      "rollback:/opt/hanaagent/releases/v0.323.0-linux-arm64",
    ]);
  });

  it("inspects required backup state without printing secrets", () => {
    const secretToken = "super-secret-device-token-xyz";
    const summary = summarizeBackupRequiredState([
      "root/.hanako/auth.json",
      "root/.hanako/device-credentials.json",
      "root/.hanako/server-network.json",
      "root/.hanako/agents/hana/sessions/one.jsonl",
      "root/.hanako/agents/hana/desk/cron-jobs.json",
    ]);

    expect(summary).toEqual({
      configuration: true,
      agents: true,
      sessions: true,
      auth: true,
      redacted: true,
    });
    expect(JSON.stringify(summary)).not.toContain(secretToken);
    expect(JSON.stringify(summary)).not.toMatch(/password|token|secret/i);
  });
});
