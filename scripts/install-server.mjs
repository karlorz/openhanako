#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

export const DEFAULT_PATHS = Object.freeze({
  installRoot: "/opt/hanaagent",
  installBin: "/usr/local/bin/install-server",
  installImpl: "/opt/hanaagent/install/install-server.mjs",
  releasesDir: "/opt/hanaagent/releases",
  currentLink: "/opt/hanaagent/current",
  dataDir: "/var/lib/hanaagent",
  configDir: "/etc/hanaagent",
  serviceUnit: "/etc/systemd/system/hanaagent.service",
  serviceName: "hanaagent",
});

function fail(message) {
  throw new Error(message);
}

export function resolvePrivilegeModel({ uid = typeof process.getuid === "function" ? process.getuid() : 0, hasSudo = commandExists("sudo") } = {}) {
  if (uid === 0) {
    return { mode: "root", commandPrefix: [] };
  }
  if (!hasSudo) {
    fail("sudo is required for non-root install-server operations. Re-run as root or install sudo first.");
  }
  return { mode: "sudo", commandPrefix: ["sudo"] };
}

export function resolveLinuxAsset(metadata, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "linux") {
    fail(`install-server supports Linux only; got ${platform}`);
  }
  const normalizedArch = normalizeArch(arch);
  const asset = (metadata.assets ?? []).find((item) => {
    return item.platform === "linux" && normalizeArch(item.arch) === normalizedArch;
  });
  if (!asset) {
    fail(`No Linux ${normalizedArch} server asset found in release metadata`);
  }
  if (!/^[a-fA-F0-9]{64}$/.test(asset.sha256 ?? "")) {
    fail(`Release asset ${asset.name ?? asset.url ?? normalizedArch} is missing a valid sha256`);
  }
  return asset;
}

export function normalizeArch(arch) {
  switch (arch) {
    case "x64":
    case "amd64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      fail(`Unsupported Linux architecture: ${arch}`);
  }
}

export function buildUpgradePlan({
  metadata,
  currentVersion,
  platform = process.platform,
  arch = process.arch,
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  hasSudo = commandExists("sudo"),
  dryRun = true,
  paths = {},
} = {}) {
  if (!metadata?.tag) {
    fail("Release metadata must include a tag");
  }
  if (metadata.prerelease) {
    fail("Prerelease upgrade requires an explicit prerelease channel; not enabled in this plan");
  }
  if (!currentVersion) {
    fail("Current installed version is required before planning an upgrade");
  }

  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const normalizedArch = normalizeArch(arch);
  const targetReleaseDir = path.posix.join(resolvedPaths.releasesDir, `${metadata.tag}-linux-${normalizedArch}`);
  const previousReleaseDir = path.posix.join(resolvedPaths.releasesDir, currentVersion);
  const privilege = resolvePrivilegeModel({ uid, hasSudo });
  const asset = resolveLinuxAsset(metadata, { platform, arch: normalizedArch });

  const steps = [
    {
      id: "preflight",
      mutatesService: false,
      command: "verify linux host, systemd, existing install, data directory, and service state",
    },
    {
      id: "backup",
      mutatesService: false,
      command: `create and verify backup of ${resolvedPaths.configDir} and ${resolvedPaths.dataDir}`,
    },
    {
      id: "download",
      mutatesService: false,
      command: `download ${asset.url} to staging`,
    },
    {
      id: "verify-checksum",
      mutatesService: false,
      command: `verify sha256 ${asset.sha256}`,
    },
    {
      id: "extract-release",
      mutatesService: false,
      command: `extract ${asset.name ?? "server artifact"} to ${targetReleaseDir}`,
    },
    {
      id: "switch-current",
      mutatesService: true,
      command: `atomically switch ${resolvedPaths.currentLink} to ${targetReleaseDir}`,
    },
    {
      id: "restart-service",
      mutatesService: true,
      command: `systemctl restart ${resolvedPaths.serviceName}`,
    },
    {
      id: "health-check",
      mutatesService: false,
      command: "verify local server health endpoint",
    },
  ];

  assertNoDestructiveDataSteps(steps);

  return {
    kind: "install-server-upgrade-plan",
    dryRun,
    tag: metadata.tag,
    currentVersion,
    platform: "linux",
    arch: normalizedArch,
    asset,
    paths: resolvedPaths,
    privilege,
    targetReleaseDir,
    previousReleaseDir,
    steps,
  };
}

function assertNoDestructiveDataSteps(steps) {
  const unsafe = steps.find((step) => /rm -rf|delete data|clear data|reinit-data|wipe|truncate/i.test(step.command));
  if (unsafe) {
    fail(`Unsafe upgrade step is not allowed: ${unsafe.command}`);
  }
}

export function createSystemdUnit({
  user = "hanaagent",
  group = "hanaagent",
  paths = DEFAULT_PATHS,
} = {}) {
  return `[Unit]
Description=HanaAgent Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Group=${group}
Environment=HANA_HOME=${paths.dataDir}
WorkingDirectory=${paths.currentLink}
ExecStart=${paths.currentLink}/hana-server
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
`;
}

export async function executeUpgradePlan(plan, ops = {}) {
  if (plan.dryRun) {
    return { ok: true, dryRun: true, plan };
  }
  const requiredOps = [
    "preflight",
    "backup",
    "download",
    "verifyChecksum",
    "extractRelease",
    "switchCurrent",
    "restartService",
    "healthCheck",
    "rollback",
  ];
  for (const op of requiredOps) {
    if (typeof ops[op] !== "function") {
      fail(`executeUpgradePlan requires ops.${op}`);
    }
  }

  let switchedCurrent = false;
  try {
    await ops.preflight(plan);
    await ops.backup(plan);
    await ops.download(plan);
    await ops.verifyChecksum(plan);
    await ops.extractRelease(plan);
    await ops.switchCurrent(plan.targetReleaseDir, plan);
    switchedCurrent = true;
    await ops.restartService(plan);
    await ops.healthCheck(plan);
    return { ok: true, rolledBack: false };
  } catch (error) {
    if (switchedCurrent) {
      await ops.rollback(plan.previousReleaseDir, plan);
    }
    return {
      ok: false,
      rolledBack: switchedCurrent,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createShellUpgradeOps({
  run = runCommand,
  now = defaultTimestamp,
  stagingDir = path.posix.join(os.tmpdir(), "hanaagent-upgrade"),
  backupDir = path.posix.join(DEFAULT_PATHS.installRoot, "backups"),
} = {}) {
  let downloadedArchive = null;
  let backupArchive = null;

  async function checked(cmd, args, options = {}) {
    const commandArgs = options.privileged ? [...options.plan.privilege.commandPrefix, cmd, ...args] : [cmd, ...args];
    const command = commandArgs.shift();
    const result = await run(command, commandArgs);
    if (result.status !== 0) {
      fail(`${cmd} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
    }
    return result;
  }

  return {
    async preflight(plan) {
      if (plan.platform !== "linux") fail("install-server upgrade can only execute on Linux");
      for (const command of ["systemctl", "tar", "sha256sum", "curl", "mkdir", "ln"]) {
        await checked("sh", ["-c", `command -v ${command}`], { plan });
      }
      return true;
    },
    async backup(plan) {
      const stamp = now();
      backupArchive = path.posix.join(backupDir, `hanaagent-backup-${stamp}.tar.gz`);
      await checked("mkdir", ["-p", backupDir], { plan, privileged: true });
      await checked(
        "tar",
        [
          "-czf",
          backupArchive,
          "--ignore-failed-read",
          plan.paths.configDir,
          plan.paths.dataDir,
          plan.paths.currentLink,
        ],
        { plan, privileged: true },
      );
      await checked("tar", ["-tzf", backupArchive], { plan, privileged: true });
      return { backupArchive };
    },
    async download(plan) {
      await checked("mkdir", ["-p", stagingDir], { plan, privileged: true });
      downloadedArchive = path.posix.join(stagingDir, plan.asset.name ?? `hanaagent-${plan.tag}.tar.gz`);
      await checked("curl", ["-fL", plan.asset.url, "-o", downloadedArchive], { plan, privileged: true });
      return { downloadedArchive };
    },
    async verifyChecksum(plan) {
      if (!downloadedArchive) fail("download must run before verifyChecksum");
      await checked("sh", ["-c", `printf '%s  %s\n' '${plan.asset.sha256}' '${downloadedArchive}' | sha256sum -c -`], {
        plan,
        privileged: true,
      });
      return true;
    },
    async extractRelease(plan) {
      if (!downloadedArchive) fail("download must run before extractRelease");
      await checked("mkdir", ["-p", plan.targetReleaseDir], { plan, privileged: true });
      await checked("tar", ["-xzf", downloadedArchive, "-C", plan.targetReleaseDir, "--strip-components=0"], {
        plan,
        privileged: true,
      });
      return true;
    },
    async switchCurrent(targetReleaseDir, plan) {
      await checked("ln", ["-sfn", targetReleaseDir, plan.paths.currentLink], { plan, privileged: true });
      return true;
    },
    async restartService(plan) {
      await checked("systemctl", ["daemon-reload"], { plan, privileged: true });
      await checked("systemctl", ["restart", plan.paths.serviceName], { plan, privileged: true });
      return true;
    },
    async healthCheck(plan) {
      await checked("systemctl", ["is-active", "--quiet", plan.paths.serviceName], { plan, privileged: true });
      return true;
    },
    async rollback(previousReleaseDir, plan) {
      await checked("ln", ["-sfn", previousReleaseDir, plan.paths.currentLink], { plan, privileged: true });
      await checked("systemctl", ["restart", plan.paths.serviceName], { plan, privileged: true });
      return true;
    },
  };
}

function defaultTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  if (result.error) {
    return { status: 1, stdout: "", stderr: result.error.message };
  }
  return result;
}

function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function usage() {
  return `install-server - HanaAgent Linux server installer

Usage:
  node scripts/install-server.mjs upgrade --metadata <release.json> --current-version <version> [--dry-run]
  node scripts/install-server.mjs upgrade --metadata <release.json> --current-version <version> --platform linux --arch arm64 --dry-run
  node scripts/install-server.mjs status
  node scripts/install-server.mjs backup --output <path>

Notes:
  upgrade dry-run is safe and does not mutate host state.
  destructive reset/import is intentionally separate as reinit-data and is not implemented here.`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, dryRun: true };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    switch (arg) {
      case "--metadata":
        options.metadataPath = rest[++i];
        break;
      case "--current-version":
        options.currentVersion = rest[++i];
        break;
      case "--platform":
        options.platform = rest[++i];
        break;
      case "--arch":
        options.arch = rest[++i];
        break;
      case "--execute":
        options.dryRun = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.command || options.help) {
    console.log(usage());
    return;
  }
  if (options.command === "upgrade") {
    if (!options.metadataPath) fail("upgrade requires --metadata <release.json>");
    const plan = buildUpgradePlan({
      metadata: readJson(options.metadataPath),
      currentVersion: options.currentVersion,
      platform: options.platform,
      arch: options.arch,
      dryRun: options.dryRun,
    });
    if (options.dryRun) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      executeUpgradePlan(plan, createShellUpgradeOps()).then((result) => {
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
      }).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
    }
    return;
  }
  if (options.command === "status") {
    console.log(JSON.stringify({ serviceName: DEFAULT_PATHS.serviceName, currentLink: DEFAULT_PATHS.currentLink }, null, 2));
    return;
  }
  if (options.command === "backup") {
    fail("backup command requires host integration; use upgrade planning/tests until implementation wires shell operations.");
  }
  fail(`Unknown command: ${options.command}`);
}

if (process.argv[1] === __filename) {
  main();
}
