import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildUpgradePlan,
  buildInstallPlan,
  buildReinitDataDryRunPlan,
  buildReinitDataConfirmPlan,
  buildStatusPlan,
  createShellReinitDataOps,
  createShellUpgradeOps,
  createSystemdUnit,
  deriveUpgradeHostDefaults,
  executeReinitDataPlan,
  executeReinitDataRestore,
  executeUpgradePlan,
  loadReinitDataPlan,
  resolveHanaDataRoot,
  resolveLinuxAsset,
  resolvePrivilegeModel,
  resolveRelease,
  selectServerAsset,
  runUpgrade,
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
      "write-systemd-unit",
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

  it("preserves existing sg01 service context when deriving upgrade defaults", () => {
    const unitText = `[Service]
User=root
Group=root
WorkingDirectory=/opt/hanaagent/server
Environment=HANA_HOME=/root/.hanako
Environment=HANA_PORT=14500
Environment=HANA_SERVER_OWNER=standalone
ExecStart=/opt/hanaagent/server/hana-server
`;

    const defaults = deriveUpgradeHostDefaults({ unitText });
    const plan = buildUpgradePlan({
      metadata,
      currentVersion: "v0.323.0",
      platform: "linux",
      arch: "arm64",
      uid: 0,
      hasSudo: false,
      dryRun: true,
      paths: defaults.paths,
      previousReleaseDir: defaults.previousReleaseDir,
      serviceUser: defaults.serviceUser,
      serviceGroup: defaults.serviceGroup,
      serviceEnvironment: defaults.serviceEnvironment,
    });
    const migratedUnit = createSystemdUnit({
      paths: plan.paths,
      user: plan.serviceUser,
      group: plan.serviceGroup,
      environment: plan.serviceEnvironment,
    });

    expect(plan.paths.dataDir).toBe("/root/.hanako");
    expect(plan.previousReleaseDir).toBe("/opt/hanaagent/server");
    expect(migratedUnit).toContain("User=root");
    expect(migratedUnit).toContain("Group=root");
    expect(migratedUnit).toContain("Environment=HANA_HOME=/root/.hanako");
    expect(migratedUnit).toContain("Environment=HANA_PORT=14500");
    expect(migratedUnit).toContain("Environment=HANA_SERVER_OWNER=standalone");
    expect(migratedUnit).toContain("ExecStart=/opt/hanaagent/current/hana-server");
  });

  it("preserves non-managed hardening/logging directives through an upgrade", () => {
    // Real sg01 unit carried Documentation, TimeoutStopSec, StandardOutput/Error,
    // SyslogIdentifier, PrivateTmp, ProtectSystem, NoNewPrivileges, and a custom
    // RestartSec. The installer owns WorkingDirectory/ExecStart/User/Group/HANA_*
    // but must not silently drop the rest — PrivateTmp=true and SyslogIdentifier
    // are operational/security-relevant and were lost in the .3 upgrade.
    const unitText = `[Unit]
Description=HanaAgent Server (headless)
Documentation=https://github.com/liliMozi/openhanako
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/opt/hanaagent/server
Environment=HANA_HOME=/root/.hanako
Environment=HANA_PORT=14500
Environment=HANA_SERVER_OWNER=standalone
ExecStart=/opt/hanaagent/server/hana-server
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hanaagent

NoNewPrivileges=false
PrivateTmp=true
ProtectSystem=false

[Install]
WantedBy=multi-user.target
`;

    const defaults = deriveUpgradeHostDefaults({ unitText });
    const plan = buildUpgradePlan({
      metadata,
      currentVersion: "v0.323.0",
      platform: "linux",
      arch: "arm64",
      uid: 0,
      hasSudo: false,
      dryRun: true,
      paths: defaults.paths,
      previousReleaseDir: defaults.previousReleaseDir,
      serviceUser: defaults.serviceUser,
      serviceGroup: defaults.serviceGroup,
      serviceEnvironment: defaults.serviceEnvironment,
    });
    const migratedUnit = createSystemdUnit({
      paths: plan.paths,
      user: plan.serviceUser,
      group: plan.serviceGroup,
      environment: plan.serviceEnvironment,
      // carry through the directives the installer does not own
      preserve: defaults.preserve,
    });

    // managed fields still migrated to the stable symlink
    expect(migratedUnit).toContain("WorkingDirectory=/opt/hanaagent/current");
    expect(migratedUnit).toContain("ExecStart=/opt/hanaagent/current/hana-server");
    expect(migratedUnit).toContain("User=root");
    expect(migratedUnit).toContain("Environment=HANA_HOME=/root/.hanako");
    // preserved operational/security directives
    expect(migratedUnit).toContain("Documentation=https://github.com/liliMozi/openhanako");
    expect(migratedUnit).toContain("TimeoutStopSec=20");
    expect(migratedUnit).toContain("StandardOutput=journal");
    expect(migratedUnit).toContain("StandardError=journal");
    expect(migratedUnit).toContain("SyslogIdentifier=hanaagent");
    expect(migratedUnit).toContain("PrivateTmp=true");
    expect(migratedUnit).toContain("ProtectSystem=false");
    expect(migratedUnit).toContain("NoNewPrivileges=false");
    // a custom RestartSec in the prior unit survives (not reset to the default 3)
    expect(migratedUnit).toContain("RestartSec=5");
  });

  it("derives a preserve block from the prior unit listing carry-through directives", () => {
    // deriveUpgradeHostDefaults must surface what to preserve so the upgrade
    // path can hand it to createSystemdUnit without re-parsing the unit.
    const unitText = `[Unit]
Description=HanaAgent Server (headless)
Documentation=https://github.com/liliMozi/openhanako
After=network-online.target
Wants=network-online.target

[Service]
User=root
Group=root
ExecStart=/opt/hanaagent/server/hana-server
RestartSec=5
TimeoutStopSec=20
SyslogIdentifier=hanaagent
PrivateTmp=true
`;
    const defaults = deriveUpgradeHostDefaults({ unitText });

    expect(defaults.preserve).toMatchObject({
      unit: { Documentation: "https://github.com/liliMozi/openhanako" },
    });
    expect(defaults.preserve.service.RestartSec).toBe("5");
    expect(defaults.preserve.service.TimeoutStopSec).toBe("20");
    expect(defaults.preserve.service.SyslogIdentifier).toBe("hanaagent");
    expect(defaults.preserve.service.PrivateTmp).toBe("true");
    // managed fields excluded from preserve
    expect(defaults.preserve.service).not.toHaveProperty("User");
    expect(defaults.preserve.service).not.toHaveProperty("Group");
    expect(defaults.preserve.service).not.toHaveProperty("ExecStart");
    expect(defaults.preserve.service).not.toHaveProperty("WorkingDirectory");
    // Description/After/Wants are managed [Unit] defaults, not preserved
    expect(defaults.preserve.unit).not.toHaveProperty("Description");
    expect(defaults.preserve.unit).not.toHaveProperty("After");
    expect(defaults.preserve.unit).not.toHaveProperty("Wants");
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
      writeSystemdUnit: async () => calls.push("write-unit"),
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
      "write-unit",
      "restart",
      "health-check",
      "rollback:/opt/hanaagent/releases/v0.323.0",
    ]);
  });

  it("rolls back when the current-link switch fails after mutating the link", async () => {
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
      switchCurrent: async (target) => {
        calls.push(`switch:${target}`);
        throw new Error("switch failed after link mutation");
      },
      writeSystemdUnit: async () => calls.push("write-unit"),
      restartService: async () => calls.push("restart"),
      healthCheck: async () => calls.push("health-check"),
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
      writeSystemdUnit: async () => calls.push("write-unit"),
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
    await ops.writeSystemdUnit(plan);
    await ops.restartService(plan);

    const backupIndex = calls.findIndex((call) => call.includes("tar -czf"));
    const switchIndex = calls.findIndex((call) => call.includes("ln -sfn"));
    const writeUnitIndex = calls.findIndex((call) => call.includes("cp ") && call.includes("hanaagent.service"));

    expect(backupIndex).toBeGreaterThanOrEqual(0);
    expect(backupIndex).toBeLessThan(switchIndex);
    expect(switchIndex).toBeLessThan(writeUnitIndex);
    expect(calls.join("\n")).not.toMatch(/rm -rf|reinit-data|delete data/i);
  });

  it("extracts server bundle contents into the release root", async () => {
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
    const staging = "/tmp/hanaagent-upgrade-extract-test";
    const archivePath = path.posix.join(staging, "hanaagent-server-v0.400.0-linux-arm64.tar.gz");
    const ops = createShellUpgradeOps({
      run: async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "sha256sum") return { status: 0, stdout: `${ARM64_SHA256}  ${args[0]}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      stagingDir: staging,
    });

    await ops.download(plan);
    await ops.verifyChecksum(plan);
    await ops.extractRelease(plan);

    expect(calls).toContainEqual([
      "tar",
      ["-xzf", archivePath, "-C", plan.targetReleaseDir, "--strip-components=1"],
    ]);
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

  it("downloads and verifies against the <asset>.sha256 sidecar when metadata has no inline sha256", async () => {
    // GitHub-resolved assets carry sha256: null; the download op must fetch
    // <url>.sha256 and verifyChecksum must read it.
    const sidecarSha = "f".repeat(64);
    const sidecarMetadata = {
      tag: "v0.400.0",
      prerelease: false,
      assets: [{
        platform: "linux",
        arch: "arm64",
        name: "hanaagent-server-v0.400.0-linux-arm64.tar.gz",
        url: "https://example.test/hanaagent-server-v0.400.0-linux-arm64.tar.gz",
        sha256: null,
      }],
    };
    const plan = buildUpgradePlan({
      metadata: sidecarMetadata,
      currentVersion: "v0.323.0",
      platform: "linux",
      arch: "arm64",
      uid: 0,
      hasSudo: false,
      dryRun: false,
    });
    expect(plan.asset.sha256).toBeNull();

    const staging = "/tmp/hanaagent-upgrade-sidecar-test";
    const archivePath = path.posix.join(staging, "hanaagent-server-v0.400.0-linux-arm64.tar.gz");
    const sidecarPath = `${archivePath}.sha256`;
    const calls = [];
    const ops = createShellUpgradeOps({
      run: async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "sha256sum") return { status: 0, stdout: `${sidecarSha}  ${args[0]}\n`, stderr: "" };
        if (cmd === "curl" && args.includes("-o") && args[args.length - 1] === sidecarPath) {
          fs.mkdirSync(staging, { recursive: true });
          fs.writeFileSync(sidecarPath, `${sidecarSha}  hanaagent-server-v0.400.0-linux-arm64.tar.gz\n`);
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      stagingDir: staging,
    });

    await ops.download(plan);
    // sidecar curl is emitted because sha256 is null
    expect(calls).toContainEqual(["curl", ["-fL", `${plan.asset.url}.sha256`, "-o", sidecarPath]]);
    await ops.verifyChecksum(plan);
    // sha256sum ran on the archive and matched the sidecar value (no throw)
    expect(calls).toContainEqual(["sha256sum", [archivePath]]);
  });

  it("buildUpgradePlan refuses a prerelease metadata file unless channel is prerelease", () => {
    const preMeta = { ...metadata, prerelease: true };
    expect(() => buildUpgradePlan({ metadata: preMeta, currentVersion: "v0.323.0", platform: "linux", arch: "arm64" }))
      .toThrow(/prerelease/i);
    const plan = buildUpgradePlan({ metadata: preMeta, currentVersion: "v0.323.0", platform: "linux", arch: "arm64", channel: "prerelease" });
    expect(plan.tag).toBe("v0.400.0");
  });

  it("keeps executable upgrade operations inside an explicit command allowlist", async () => {
    const plan = buildUpgradePlan({
      metadata,
      currentVersion: "v0.323.0",
      platform: "linux",
      arch: "arm64",
      uid: 0,
      hasSudo: false,
      dryRun: false,
    });
    const commands = [];
    const ops = createShellUpgradeOps({
      run: async (cmd, args) => {
        commands.push(cmd);
        if (cmd === "sha256sum") return { status: 0, stdout: `${ARM64_SHA256}  ${args[0]}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    await ops.preflight(plan);
    await ops.backup(plan);
    await ops.download(plan);
    await ops.verifyChecksum(plan);
    await ops.extractRelease(plan);
    await ops.switchCurrent(plan.targetReleaseDir, plan);
    await ops.writeSystemdUnit(plan);
    await ops.restartService(plan);
    await ops.healthCheck(plan);
    await ops.rollback(plan.previousReleaseDir, plan);

    expect(new Set(commands)).toEqual(new Set(["systemctl", "tar", "sha256sum", "curl", "mkdir", "ln", "cp"]));
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
    expect(saved.confirmation.status).toBe("requires-confirm");
    expect(saved.confirmation.reason).not.toMatch(/not implemented/i);
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

  it("loads a reinit-data plan by id and rejects missing plans", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-reinit-load-"));
    const dataRoot = path.join(tmpDir, "hana-home");
    const planDir = path.join(tmpDir, "plans");
    const dryRun = writeReinitDataDryRunPlan(buildReinitDataDryRunPlan({
      dataRoot,
      planDir,
      now: new Date("2026-06-16T15:00:00.000Z"),
    }));

    expect(loadReinitDataPlan(dryRun.planId, { planDir })).toMatchObject({
      kind: "install-server-reinit-data-dry-run-plan",
      planId: dryRun.planId,
      dataRoot,
    });
    expect(() => loadReinitDataPlan("missing-plan", { planDir })).toThrow(/not found|missing/i);
  });

  it("refuses expired or data-root-mismatched reinit-data confirmation plans", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-reinit-confirm-"));
    const dryRun = buildReinitDataDryRunPlan({
      dataRoot: path.join(tmpDir, "hana-home"),
      planDir: path.join(tmpDir, "plans"),
      now: new Date("2026-06-16T15:00:00.000Z"),
    });

    expect(() => buildReinitDataConfirmPlan({
      plan: dryRun,
      now: new Date("2026-06-16T16:00:01.000Z"),
      dataRoot: dryRun.dataRoot,
      uid: 0,
      hasSudo: false,
    })).toThrow(/expired/i);
    expect(() => buildReinitDataConfirmPlan({
      plan: dryRun,
      now: new Date("2026-06-16T15:30:00.000Z"),
      dataRoot: path.join(tmpDir, "other-hana-home"),
      uid: 0,
      hasSudo: false,
    })).toThrow(/data root/i);
  });

  it("confirms reinit-data only after backup verification and writes an audit", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-reinit-execute-"));
    const dataRoot = path.join(tmpDir, "hana-home");
    const planDir = path.join(tmpDir, "plans");
    fs.mkdirSync(dataRoot, { recursive: true });
    const dryRun = buildReinitDataDryRunPlan({
      dataRoot,
      planDir,
      now: new Date("2026-06-16T15:00:00.000Z"),
      serviceState: { active: "active" },
      paths: { installRoot: path.join(tmpDir, "install") },
    });
    const confirmPlan = buildReinitDataConfirmPlan({
      plan: dryRun,
      now: new Date("2026-06-16T15:30:00.000Z"),
      dataRoot,
      uid: 0,
      hasSudo: false,
    });
    const calls = [];
    const result = await executeReinitDataPlan(confirmPlan, {
      preflight: async () => calls.push("preflight"),
      stopService: async () => calls.push("stop"),
      createBackup: async () => calls.push("backup"),
      verifyBackup: async () => calls.push("verify-backup"),
      moveDataRootAside: async () => calls.push("move-aside"),
      startService: async () => calls.push("start"),
      healthCheck: async () => calls.push("health"),
      writeAudit: async () => calls.push("audit"),
    });

    expect(result).toMatchObject({ ok: true, resetStarted: true });
    expect(calls).toEqual([
      "preflight",
      "stop",
      "backup",
      "verify-backup",
      "move-aside",
      "start",
      "health",
      "audit",
    ]);
  });

  it("does not reset data when reinit-data backup fails", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-reinit-backup-fail-"));
    const dataRoot = path.join(tmpDir, "hana-home");
    const dryRun = buildReinitDataDryRunPlan({
      dataRoot,
      planDir: path.join(tmpDir, "plans"),
      now: new Date("2026-06-16T15:00:00.000Z"),
      paths: { installRoot: path.join(tmpDir, "install") },
    });
    const confirmPlan = buildReinitDataConfirmPlan({
      plan: dryRun,
      now: new Date("2026-06-16T15:30:00.000Z"),
      dataRoot,
      uid: 0,
      hasSudo: false,
    });
    const calls = [];
    const result = await executeReinitDataPlan(confirmPlan, {
      preflight: async () => calls.push("preflight"),
      stopService: async () => calls.push("stop"),
      createBackup: async () => {
        calls.push("backup");
        throw new Error("backup failed");
      },
      verifyBackup: async () => calls.push("verify-backup"),
      moveDataRootAside: async () => calls.push("move-aside"),
      startService: async () => calls.push("start"),
      healthCheck: async () => calls.push("health"),
      writeAudit: async () => calls.push("audit"),
    });

    expect(result).toMatchObject({ ok: false, resetStarted: false, serviceRestarted: true });
    expect(calls).toEqual(["preflight", "stop", "backup", "start"]);
  });

  it("restores only after verifying the backup archive", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-reinit-restore-"));
    const dataRoot = path.join(tmpDir, "hana-home");
    const backupPath = path.join(tmpDir, "backups", "hanaagent-backup.tar.gz");
    const calls = [];
    const result = await executeReinitDataRestore({
      backupPath,
      dataRoot,
      serviceName: "hanaagent",
      auditPath: `${backupPath}.restore-audit.json`,
    }, {
      verifyBackup: async () => calls.push("verify-backup"),
      stopService: async () => calls.push("stop"),
      moveDataRootAside: async () => calls.push("move-aside"),
      restoreBackup: async () => calls.push("restore"),
      startService: async () => calls.push("start"),
      healthCheck: async () => calls.push("health"),
      writeAudit: async () => calls.push("audit"),
    });

    expect(result).toMatchObject({ ok: true, restoreStarted: true });
    expect(calls).toEqual([
      "verify-backup",
      "stop",
      "move-aside",
      "restore",
      "start",
      "health",
      "audit",
    ]);
  });

  it("keeps executable reinit-data shell operations inside an explicit command allowlist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-reinit-shell-"));
    const dataRoot = path.join(tmpDir, "hana-home");
    const backupPath = path.join(tmpDir, "backups", "hanaagent-backup.tar.gz");
    fs.mkdirSync(dataRoot, { recursive: true });
    const dryRun = buildReinitDataDryRunPlan({
      dataRoot,
      planDir: path.join(tmpDir, "plans"),
      now: new Date("2026-06-16T15:00:00.000Z"),
      paths: { installRoot: path.join(tmpDir, "install") },
    });
    const confirmPlan = {
      ...buildReinitDataConfirmPlan({
        plan: dryRun,
        now: new Date("2026-06-16T15:30:00.000Z"),
        dataRoot,
        uid: 0,
        hasSudo: false,
      }),
      backup: {
        ...dryRun.backup,
        destination: backupPath,
        manifest: `${backupPath}.manifest.json`,
      },
    };
    const calls = [];
    const ops = createShellReinitDataOps({
      run: async (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (cmd === "sha256sum") return { status: 0, stdout: `${"b".repeat(64)}  ${args[0]}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-06-16T15-30-00Z",
    });

    await ops.preflight(confirmPlan);
    await ops.stopService(confirmPlan);
    await ops.createBackup(confirmPlan);
    await ops.verifyBackup(confirmPlan);
    await ops.moveDataRootAside(confirmPlan);
    await ops.startService(confirmPlan);
    await ops.healthCheck(confirmPlan);

    expect(new Set(calls.map((call) => call.split(/\s+/)[0]))).toEqual(
      new Set(["test", "systemctl", "mkdir", "tar", "sha256sum", "mv"]),
    );
    expect(calls.join("\n")).not.toMatch(/rm -rf|delete data|truncate|wipe|sh -c/i);
  });
});

const MOCK_RELEASES = [
  {
    tag_name: "v0.323.0-karlorz.1",
    prerelease: true,
    assets: [
      { name: "hanaagent-server-v0.323.0-karlorz.1-linux-arm64.tar.gz", browser_download_url: "https://x.test/srv-linux-arm64.tar.gz" },
      { name: "hanaagent-server-v0.323.0-karlorz.1-linux-x64.tar.gz", browser_download_url: "https://x.test/srv-linux-x64.tar.gz" },
    ],
  },
  {
    tag_name: "v0.300.0",
    prerelease: false,
    assets: [
      { name: "hanaagent-server-v0.300.0-linux-arm64.tar.gz", browser_download_url: "https://x.test/old-linux-arm64.tar.gz" },
    ],
  },
];
const mockClient = {
  listReleases: async () => MOCK_RELEASES,
  getRelease: async (tag) => MOCK_RELEASES.find((r) => r.tag_name === tag) ?? null,
};

describe("install-server release resolution", () => {
  it("selectServerAsset picks the linux-arm64 asset", () => {
    const meta = {
      tag: "v0.300.0",
      prerelease: false,
      assets: [
        { platform: "linux", arch: "x64", name: "a", url: "u1", sha256: "b".repeat(64) },
        { platform: "linux", arch: "arm64", name: "b", url: "u2", sha256: "c".repeat(64) },
      ],
    };
    expect(selectServerAsset(meta, { platform: "linux", arch: "arm64" }).name).toBe("b");
  });

  it("selectServerAsset normalizes arch aliases (amd64 -> x64)", () => {
    const meta = {
      tag: "v1",
      prerelease: false,
      assets: [{ platform: "linux", arch: "x64", name: "n", url: "u", sha256: "d".repeat(64) }],
    };
    expect(selectServerAsset(meta, { platform: "linux", arch: "amd64" }).name).toBe("n");
  });

  it("selectServerAsset throws when no matching asset exists", () => {
    const meta = {
      tag: "v1",
      prerelease: false,
      assets: [{ platform: "linux", arch: "x64", name: "a", url: "u", sha256: "d".repeat(64) }],
    };
    expect(() => selectServerAsset(meta, { platform: "linux", arch: "arm64" })).toThrow();
  });

  it("selectServerAsset refuses non-linux hosts", () => {
    const meta = { tag: "v1", prerelease: false, assets: [{ platform: "linux", arch: "arm64", name: "a", url: "u", sha256: "d".repeat(64) }] };
    expect(() => selectServerAsset(meta, { platform: "darwin", arch: "arm64" })).toThrow();
  });

  it("resolveRelease returns latest stable (skips prerelease) by default", async () => {
    const meta = await resolveRelease({}, mockClient);
    expect(meta.tag).toBe("v0.300.0");
    expect(meta.prerelease).toBe(false);
    expect(meta.assets[0].platform).toBe("linux");
    expect(meta.assets[0].name).toBe("hanaagent-server-v0.300.0-linux-arm64.tar.gz");
    expect(meta.assets[0].url).toBe("https://x.test/old-linux-arm64.tar.gz");
  });

  it("resolveRelease returns the latest release including prereleases when channel is prerelease", async () => {
    const meta = await resolveRelease({ channel: "prerelease" }, mockClient);
    expect(meta.tag).toBe("v0.323.0-karlorz.1");
    expect(meta.prerelease).toBe(true);
  });

  it("resolveRelease refuses a prerelease without --channel prerelease", async () => {
    await expect(resolveRelease({ version: "v0.323.0-karlorz.1" }, mockClient)).rejects.toThrow(/prerelease/i);
  });

  it("resolveRelease accepts a prerelease with channel prerelease", async () => {
    const meta = await resolveRelease({ version: "v0.323.0-karlorz.1", channel: "prerelease" }, mockClient);
    expect(meta.tag).toBe("v0.323.0-karlorz.1");
    expect(meta.prerelease).toBe(true);
  });

  it("resolveRelease throws on unknown version", async () => {
    await expect(resolveRelease({ version: "v9.9.9" }, mockClient)).rejects.toThrow(/not found/i);
  });

  it("resolveRelease requires an injected httpClient", async () => {
    await expect(resolveRelease({}, null)).rejects.toThrow(/httpClient/i);
  });

  it("resolveRelease throws when no stable release exists and no version given", async () => {
    const onlyPre = { listReleases: async () => [MOCK_RELEASES[0]], getRelease: async () => null };
    await expect(resolveRelease({}, onlyPre)).rejects.toThrow(/stable/i);
  });

  it("resolveRelease throws when the resolved release has no linux asset", async () => {
    const noLinux = {
      listReleases: async () => [{ tag_name: "v0.1.0", prerelease: false, assets: [{ name: "HanaAgent-0.1.0.dmg", browser_download_url: "u" }] }],
      getRelease: async () => null,
    };
    await expect(resolveRelease({}, noLinux)).rejects.toThrow(/Linux/i);
  });
});

describe("install-server runUpgrade (command resolution)", () => {
  const runOpts = (overrides = {}) => ({
    httpClient: mockClient,
    currentVersion: "v0.290.0",
    platform: "linux",
    arch: "arm64",
    ...overrides,
  });

  it("zero-arg resolves latest stable and builds a dry-run plan", async () => {
    const plan = await runUpgrade([], runOpts());
    expect(plan.tag).toBe("v0.300.0");
    expect(plan.dryRun).toBe(true);
    expect(plan.asset.name).toBe("hanaagent-server-v0.300.0-linux-arm64.tar.gz");
    // resolved asset has no sha256 until the sidecar is fetched at download time
    expect(plan.asset.sha256).toBeNull();
  });

  it("--version pin resolves that tag (with --channel prerelease)", async () => {
    const plan = await runUpgrade(["--version", "v0.323.0-karlorz.1", "--channel", "prerelease"], runOpts());
    expect(plan.tag).toBe("v0.323.0-karlorz.1");
  });

  it("explicit --metadata wins and skips the GitHub fetch", async () => {
    const explicit = {
      tag: "vX",
      prerelease: false,
      assets: [{ platform: "linux", arch: "arm64", name: "n", url: "u", sha256: "a".repeat(64) }],
    };
    const noFetch = { listReleases: async () => { throw new Error("should not fetch"); }, getRelease: async () => { throw new Error("should not fetch"); } };
    const plan = await runUpgrade(["--metadata", "<file>"], runOpts({ httpClient: noFetch, metadata: explicit }));
    expect(plan.tag).toBe("vX");
    expect(plan.asset.sha256).toBe("a".repeat(64));
  });

  it("reads --metadata <file> from disk when no metadata object is injected", async () => {
    // runUpgrade is the testable wrapper for the upgrade command; main() reads
    // --metadata <file> via readJson. The helper must read it too, so argv with
    // --metadata resolves without a separately injected metadata object.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-runupgrade-meta-"));
    const metaFile = path.join(tmpDir, "release.json");
    const fileMetadata = {
      tag: "vFromFile",
      prerelease: false,
      assets: [{ platform: "linux", arch: "arm64", name: "nf", url: "uf", sha256: "b".repeat(64) }],
    };
    fs.writeFileSync(metaFile, `${JSON.stringify(fileMetadata)}\n`);
    const noFetch = { listReleases: async () => { throw new Error("should not fetch"); }, getRelease: async () => { throw new Error("should not fetch"); } };

    const plan = await runUpgrade(["--metadata", metaFile], runOpts({ httpClient: noFetch }));

    expect(plan.tag).toBe("vFromFile");
    expect(plan.asset.name).toBe("nf");
    expect(plan.asset.sha256).toBe("b".repeat(64));
  });

  it("injected metadata object wins over --metadata <file>", async () => {
    // When both are present, the explicit object is authoritative (matches main(),
    // which only reads the file when no other metadata path applies).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-runupgrade-meta-wins-"));
    const metaFile = path.join(tmpDir, "release.json");
    fs.writeFileSync(metaFile, `${JSON.stringify({
      tag: "vFromFile",
      prerelease: false,
      assets: [{ platform: "linux", arch: "arm64", name: "fileasset", url: "uf", sha256: "b".repeat(64) }],
    })}\n`);
    const injected = {
      tag: "vInjected",
      prerelease: false,
      assets: [{ platform: "linux", arch: "arm64", name: "inj", url: "ui", sha256: "c".repeat(64) }],
    };
    const noFetch = { listReleases: async () => { throw new Error("should not fetch"); }, getRelease: async () => { throw new Error("should not fetch"); } };

    const plan = await runUpgrade(["--metadata", metaFile], runOpts({ httpClient: noFetch, metadata: injected }));

    expect(plan.tag).toBe("vInjected");
    expect(plan.asset.name).toBe("inj");
  });

  it("zero-arg propagates resolution failure (no stable release)", async () => {
    const onlyPre = { listReleases: async () => [MOCK_RELEASES[0]], getRelease: async () => null };
    await expect(runUpgrade([], runOpts({ httpClient: onlyPre }))).rejects.toThrow(/stable/i);
  });
});
