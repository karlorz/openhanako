import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildUpgradePlan,
  buildInstallPlan,
  buildReinitDataDryRunPlan,
  buildStatusPlan,
  createShellUpgradeOps,
  createSystemdUnit,
  executeUpgradePlan,
  resolveHanaDataRoot,
  resolveLinuxAsset,
  resolvePrivilegeModel,
  writeReinitDataDryRunPlan,
} from "../scripts/install-server.mjs";

const ARM64_SHA256 = "a".repeat(64);

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
      sha256: ARM64_SHA256,
    },
  ],
};

describe("install-server upgrade planner", () => {
  it("selects the linux-arm64 release asset for arm64 hosts", () => {
    expect(resolveLinuxAsset(metadata, { platform: "linux", arch: "arm64" })).toMatchObject({
      name: "hanaagent-server-v0.400.0-linux-arm64.tar.gz",
      sha256: ARM64_SHA256,
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
        if (cmd === "sha256sum") return { status: 0, stdout: `${ARM64_SHA256}  ${args[0]}\n`, stderr: "" };
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

  it("verifies checksums without interpolating release asset names into a shell", async () => {
    const hostileName = "hanaagent-server-v0.400.0-linux-arm64.tar.gz'; touch pwn #";
    const hostileMetadata = {
      ...metadata,
      assets: [{
        ...metadata.assets[1],
        name: hostileName,
      }],
    };
    const plan = buildUpgradePlan({
      metadata: hostileMetadata,
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
        calls.push([cmd, args]);
        if (cmd === "sha256sum") return { status: 0, stdout: `${ARM64_SHA256}  ${args[0]}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      stagingDir: "/tmp/hanaagent-upgrade-test",
    });

    await ops.download(plan);
    await ops.verifyChecksum(plan);

    expect(calls).toContainEqual([
      "curl",
      ["-fL", plan.asset.url, "-o", path.posix.join("/tmp/hanaagent-upgrade-test", hostileName)],
    ]);
    expect(calls).toContainEqual([
      "sha256sum",
      [path.posix.join("/tmp/hanaagent-upgrade-test", hostileName)],
    ]);
    expect(calls.some(([cmd, args]) => cmd === "sh" && args.includes("-c"))).toBe(false);
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

  it("resolves reinit-data data root from HANA_HOME before falling back to ~/.hanako", () => {
    expect(resolveHanaDataRoot({ env: { HANA_HOME: "/srv/hana-data" }, homeDir: "/home/hana" })).toBe("/srv/hana-data");
    expect(resolveHanaDataRoot({ env: {}, homeDir: "/home/hana" })).toBe("/home/hana/.hanako");
  });

  it("writes a reinit-data dry-run plan without mutating the data root", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-reinit-plan-"));
    const dataRoot = path.join(tmpDir, "hana-home");
    const planDir = path.join(tmpDir, "plans");
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "provider-catalog.json"), "{\"providers\":[]}\n");
    fs.writeFileSync(path.join(dataRoot, "sessions.json"), "{\"sessions\":[\"keep-until-confirm\"]}\n");

    const before = fs.readdirSync(dataRoot).sort();
    const plan = buildReinitDataDryRunPlan({
      dataRoot,
      planDir,
      now: new Date("2026-06-16T15:00:00.000Z"),
      serviceState: { active: "active", enabled: "enabled", mainPid: "1972422" },
    });
    const written = writeReinitDataDryRunPlan(plan);
    const after = fs.readdirSync(dataRoot).sort();
    const saved = JSON.parse(fs.readFileSync(written.planFile, "utf8"));

    expect(after).toEqual(before);
    expect(saved).toMatchObject({
      kind: "install-server-reinit-data-dry-run-plan",
      dryRun: true,
      mutatesData: false,
      dataRoot,
      service: {
        name: "hanaagent",
        active: "active",
        enabled: "enabled",
        mainPid: "1972422",
      },
    });
    expect(saved.planId).toMatch(/^reinit-20260616T150000Z-[a-f0-9]{8}$/);
    expect(saved.planFile).toBe(path.join(planDir, `${saved.planId}.json`));
    expect(saved.backup.destination).toContain(saved.planId);
    expect(saved.backup.restoreCommand).toContain("reinit-data --restore");
    expect(saved.exportCategories.map((item) => item.id)).toEqual([
      "providers_llm",
      "connected_remote_hana",
    ]);
    expect(saved.notPreserved).toEqual(expect.arrayContaining([
      "agents",
      "memories",
      "sessions",
      "workspaces",
      "plugins",
      "uploaded_files",
    ]));
    expect(JSON.stringify(saved)).not.toMatch(/rm -rf|truncate|delete data|wipe/i);
  });

  it("keeps reinit-data confirm and restore fail-closed until backup/restore are implemented", () => {
    const script = path.join(process.cwd(), "scripts", "install-server.mjs");
    const confirm = spawnSync(process.execPath, [script, "reinit-data", "--confirm", "plan-1"], { encoding: "utf8" });
    const restore = spawnSync(process.execPath, [script, "reinit-data", "--restore", "/tmp/backup.tar.gz"], { encoding: "utf8" });

    expect(confirm.status).not.toBe(0);
    expect(`${confirm.stdout}\n${confirm.stderr}`).toMatch(/not implemented|dry-run/i);
    expect(restore.status).not.toBe(0);
    expect(`${restore.stdout}\n${restore.stderr}`).toMatch(/not implemented|dry-run/i);
  });
});
