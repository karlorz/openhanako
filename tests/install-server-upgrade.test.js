import { describe, expect, it } from "vitest";

import {
  buildUpgradePlan,
  buildInstallPlan,
  buildStatusPlan,
  createShellUpgradeOps,
  createSystemdUnit,
  executeUpgradePlan,
  resolveLinuxAsset,
  resolvePrivilegeModel,
} from "../scripts/install-server.mjs";

const metadata = {
  tag: "v0.400.0",
  prerelease: false,
  assets: [
    {
      platform: "linux",
      arch: "x64",
      name: "hanaagent-server-v0.400.0-linux-x64.tar.gz",
      url: "https://example.test/hanaagent-server-v0.400.0-linux-x64.tar.gz",
      sha256: "x".repeat(64),
    },
    {
      platform: "linux",
      arch: "arm64",
      name: "hanaagent-server-v0.400.0-linux-arm64.tar.gz",
      url: "https://example.test/hanaagent-server-v0.400.0-linux-arm64.tar.gz",
      sha256: "a".repeat(64),
    },
  ],
};

describe("install-server upgrade planner", () => {
  it("selects the linux-arm64 release asset for arm64 hosts", () => {
    expect(resolveLinuxAsset(metadata, { platform: "linux", arch: "arm64" })).toMatchObject({
      name: "hanaagent-server-v0.400.0-linux-arm64.tar.gz",
      sha256: "a".repeat(64),
    });
  });

  it("lets root mode proceed without sudo", () => {
    expect(resolvePrivilegeModel({ uid: 0, hasSudo: false })).toEqual({
      mode: "root",
      commandPrefix: [],
    });
  });

  it("fails early for non-root hosts without sudo", () => {
    expect(() => resolvePrivilegeModel({ uid: 501, hasSudo: false })).toThrow(/sudo is required/i);
  });

  it("creates a dry-run upgrade plan with backup before service mutation", () => {
    const plan = buildUpgradePlan({
      metadata,
      currentVersion: "v0.323.0",
      platform: "linux",
      arch: "arm64",
      uid: 0,
      hasSudo: false,
      dryRun: true,
    });

    expect(plan.dryRun).toBe(true);
    expect(plan.asset.name).toBe("hanaagent-server-v0.400.0-linux-arm64.tar.gz");
    expect(plan.paths.dataDir).toBe("/var/lib/hanaagent");
    expect(plan.steps.map((step) => step.id)).toEqual([
      "preflight",
      "backup",
      "download",
      "verify-checksum",
      "extract-release",
      "switch-current",
      "restart-service",
      "health-check",
    ]);
    expect(plan.steps.findIndex((step) => step.id === "backup")).toBeLessThan(
      plan.steps.findIndex((step) => step.id === "switch-current"),
    );
    expect(plan.steps.some((step) => /rm -rf|reinit-data|delete data/i.test(step.command))).toBe(false);
  });

  it("generates a systemd unit that preserves HANA_HOME outside the release directory", () => {
    const unit = createSystemdUnit();

    expect(unit).toContain("User=hanaagent");
    expect(unit).toContain("Environment=HANA_HOME=/var/lib/hanaagent");
    expect(unit).toContain("ExecStart=/opt/hanaagent/current/hana-server");
  });

  it("rolls back to the previous release when health verification fails after restart", async () => {
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
      verifyChecksum: async () => calls.push("verify-checksum"),
      extractRelease: async () => calls.push("extract-release"),
      switchCurrent: async (target) => calls.push(`switch:${target}`),
      restartService: async () => calls.push("restart"),
      healthCheck: async () => {
        calls.push("health-check");
        throw new Error("health failed");
      },
      rollback: async (target) => calls.push(`rollback:${target}`),
    });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(calls).toEqual([
      "preflight",
      "backup",
      "download",
      "verify-checksum",
      "extract-release",
      "switch:/opt/hanaagent/releases/v0.400.0-linux-arm64",
      "restart",
      "health-check",
      "rollback:/opt/hanaagent/releases/v0.323.0",
    ]);
  });

  it("does not roll back or mutate service state when backup fails before release switch", async () => {
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
      backup: async () => {
        calls.push("backup");
        throw new Error("backup failed");
      },
      download: async () => calls.push("download"),
      verifyChecksum: async () => calls.push("verify-checksum"),
      extractRelease: async () => calls.push("extract-release"),
      switchCurrent: async (target) => calls.push(`switch:${target}`),
      restartService: async () => calls.push("restart"),
      healthCheck: async () => calls.push("health-check"),
      rollback: async (target) => calls.push(`rollback:${target}`),
    });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(calls).toEqual(["preflight", "backup"]);
  });

  it("shell operations execute backup before symlink switch without data-clearing commands", async () => {
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
    const ops = createShellUpgradeOps({
      run: async (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        return { status: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-06-16T14-00-00Z",
      stagingDir: "/tmp/hanaagent-upgrade-test",
      backupDir: "/opt/hanaagent/backups",
    });

    await ops.preflight(plan);
    await ops.backup(plan);
    await ops.download(plan);
    await ops.verifyChecksum(plan);
    await ops.extractRelease(plan);
    await ops.switchCurrent(plan.targetReleaseDir, plan);
    await ops.restartService(plan);

    const backupIndex = calls.findIndex((call) => call.includes("tar -czf"));
    const switchIndex = calls.findIndex((call) => call.includes("ln -sfn"));

    expect(backupIndex).toBeGreaterThanOrEqual(0);
    expect(backupIndex).toBeLessThan(switchIndex);
    expect(calls.join("\n")).not.toMatch(/rm -rf|reinit-data|delete data/i);
  });

  it("install plan covers sg01 without SSH deploy, git reset, or local build commands", () => {
    const plan = buildInstallPlan({
      metadata,
      platform: "linux",
      arch: "arm64",
      uid: 0,
      hasSudo: false,
      dryRun: true,
      hostProfile: "sg01",
    });

    expect(plan.hostProfile).toBe("sg01");
    expect(plan.asset.name).toBe("hanaagent-server-v0.400.0-linux-arm64.tar.gz");
    expect(plan.paths.serviceName).toBe("hanaagent");
    expect(plan.steps.map((step) => step.id)).toEqual([
      "preflight",
      "create-user",
      "create-directories",
      "download",
      "verify-checksum",
      "extract-release",
      "write-systemd-unit",
      "switch-current",
      "enable-service",
      "restart-service",
      "health-check",
    ]);
    expect(plan.steps.map((step) => step.command).join("\n")).not.toMatch(
      /ssh|git reset|npm ci|npm run build:server|rm -rf|cp -R|deploy-sg01-server/i,
    );
  });

  it("status plan is read-only and reports the hanaagent service/current release", () => {
    const plan = buildStatusPlan({ hostProfile: "sg01" });

    expect(plan.hostProfile).toBe("sg01");
    expect(plan.steps.every((step) => step.readOnly)).toBe(true);
    expect(plan.steps.map((step) => step.id)).toEqual([
      "read-current-link",
      "read-service-state",
      "read-service-enabled",
      "read-listening-address",
      "read-last-backup",
    ]);
    expect(plan.steps.map((step) => step.command).join("\n")).toContain("systemctl is-active hanaagent");
    expect(plan.steps.map((step) => step.command).join("\n")).not.toMatch(/restart|stop|start|rm -rf/i);
  });
});
