#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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

export function buildInstallPlan({
  metadata,
  platform = process.platform,
  arch = process.arch,
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  hasSudo = commandExists("sudo"),
  dryRun = true,
  hostProfile = "default",
  paths = {},
} = {}) {
  if (!metadata?.tag) {
    fail("Release metadata must include a tag");
  }
  if (metadata.prerelease) {
    fail("Prerelease install requires an explicit prerelease channel; not enabled in this plan");
  }

  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const normalizedArch = normalizeArch(arch);
  const targetReleaseDir = path.posix.join(resolvedPaths.releasesDir, `${metadata.tag}-linux-${normalizedArch}`);
  const privilege = resolvePrivilegeModel({ uid, hasSudo });
  const asset = resolveLinuxAsset(metadata, { platform, arch: normalizedArch });
  const steps = [
    {
      id: "preflight",
      command: "verify linux host, systemd, artifact metadata, and target paths",
    },
    {
      id: "create-user",
      command: "create hanaagent system user and group if missing",
    },
    {
      id: "create-directories",
      command: `create ${resolvedPaths.installRoot}, ${resolvedPaths.releasesDir}, ${resolvedPaths.configDir}, and ${resolvedPaths.dataDir}`,
    },
    {
      id: "download",
      command: `download ${asset.url} to staging`,
    },
    {
      id: "verify-checksum",
      command: `verify sha256 ${asset.sha256}`,
    },
    {
      id: "extract-release",
      command: `extract ${asset.name ?? "server artifact"} to ${targetReleaseDir}`,
    },
    {
      id: "write-systemd-unit",
      command: `write ${resolvedPaths.serviceUnit} for ${resolvedPaths.serviceName}`,
    },
    {
      id: "switch-current",
      command: `atomically switch ${resolvedPaths.currentLink} to ${targetReleaseDir}`,
    },
    {
      id: "enable-service",
      command: `systemctl enable ${resolvedPaths.serviceName}`,
    },
    {
      id: "restart-service",
      command: `systemctl restart ${resolvedPaths.serviceName}`,
    },
    {
      id: "health-check",
      command: "verify local server health endpoint",
    },
  ];

  assertNoDestructiveDataSteps(steps);

  return {
    kind: "install-server-install-plan",
    dryRun,
    hostProfile,
    tag: metadata.tag,
    platform: "linux",
    arch: normalizedArch,
    asset,
    paths: resolvedPaths,
    privilege,
    targetReleaseDir,
    steps,
  };
}

export function buildStatusPlan({ hostProfile = "default", paths = {} } = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  return {
    kind: "install-server-status-plan",
    hostProfile,
    paths: resolvedPaths,
    steps: [
      {
        id: "read-current-link",
        readOnly: true,
        command: `readlink ${resolvedPaths.currentLink}`,
      },
      {
        id: "read-service-state",
        readOnly: true,
        command: `systemctl is-active ${resolvedPaths.serviceName}`,
      },
      {
        id: "read-service-enabled",
        readOnly: true,
        command: `systemctl is-enabled ${resolvedPaths.serviceName}`,
      },
      {
        id: "read-listening-address",
        readOnly: true,
        command: "inspect configured bind address and listening port",
      },
      {
        id: "read-last-backup",
        readOnly: true,
        command: `list latest backup under ${path.posix.join(resolvedPaths.installRoot, "backups")}`,
      },
    ],
  };
}

export function resolveHanaDataRoot({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const configured = typeof env.HANA_HOME === "string" ? env.HANA_HOME.trim() : "";
  return configured || path.join(homeDir, ".hanako");
}

export function buildReinitDataDryRunPlan({
  dataRoot = resolveHanaDataRoot(),
  planDir = "/var/lib/hanaagent/reinit-plans",
  now = new Date(),
  serviceName = DEFAULT_PATHS.serviceName,
  serviceState = {},
  paths = {},
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const stamp = formatPlanTimestamp(now);
  const shortHash = createHash("sha256")
    .update(`${createdAt}\n${dataRoot}\n${serviceName}`)
    .digest("hex")
    .slice(0, 8);
  const planId = `reinit-${stamp}-${shortHash}`;
  const backupDestination = path.join(resolvedPaths.installRoot, "backups", `${planId}.tar.gz`);
  const planFile = path.join(planDir, `${planId}.json`);

  return {
    kind: "install-server-reinit-data-dry-run-plan",
    dryRun: true,
    mutatesData: false,
    planId,
    createdAt,
    expiresAt,
    dataRoot,
    planFile,
    service: {
      name: serviceName,
      active: serviceState.active ?? null,
      enabled: serviceState.enabled ?? null,
      mainPid: serviceState.mainPid ?? null,
    },
    backup: {
      destination: backupDestination,
      manifest: `${backupDestination}.manifest.json`,
      includes: [
        dataRoot,
        resolvedPaths.serviceUnit,
        planFile,
      ],
      restoreCommand: `node scripts/install-server.mjs reinit-data --restore ${backupDestination}`,
    },
    exportCategories: [
      {
        id: "providers_llm",
        description: "Provider credentials, model catalog, provider catalog, and LLM preferences required for calls after reinit.",
        candidateFiles: [
          "auth.json",
          "models.json",
          "models-cache.json",
          "provider-catalog.json",
          "provider-plugins/",
          "user/preferences.json",
        ],
      },
      {
        id: "connected_remote_hana",
        description: "Access, device, and server network settings required for a paired desktop client to reconnect.",
        candidateFiles: [
          "server-network.json",
          "server-info.json",
          "server-node.json",
          "devices.json",
          "device-credentials.json",
          "pairing-sessions.json",
          "users.json",
          "studios.json",
        ],
      },
    ],
    notPreserved: [
      "persona",
      "agents",
      "memories",
      "sessions",
      "workspaces",
      "desk_content",
      "plugins",
      "plugin_state",
      "uploaded_files",
      "generated_media",
      "general_preferences",
    ],
    wouldRemoveOrReplace: [
      path.join(dataRoot, "agents"),
      path.join(dataRoot, "sessions"),
      path.join(dataRoot, "workspaces"),
      path.join(dataRoot, "uploads"),
      path.join(dataRoot, "session-files"),
      path.join(dataRoot, "provider-plugins"),
    ],
    healthChecks: [
      `systemctl is-active ${serviceName}`,
      "authenticated GET /api/health",
      "paired desktop LAN reconnect smoke",
    ],
    confirmation: {
      confirmCommand: `node scripts/install-server.mjs reinit-data --confirm ${planId}`,
      status: "not-implemented",
      reason: "Dry-run planning is implemented first; confirm requires backup, restore, import, and audit gates before destructive behavior is allowed.",
    },
    audit: {
      reportPath: path.join(resolvedPaths.installRoot, "backups", `${planId}.audit.json`),
      redactSecrets: true,
    },
  };
}

export function writeReinitDataDryRunPlan(plan) {
  if (!plan?.planFile) {
    fail("reinit-data dry-run plan requires planFile");
  }
  fs.mkdirSync(path.dirname(plan.planFile), { recursive: true });
  fs.writeFileSync(plan.planFile, `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
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
      downloadedArchive = path.posix.join(stagingDir, safeAssetArchiveName(plan));
      await checked("curl", ["-fL", plan.asset.url, "-o", downloadedArchive], { plan, privileged: true });
      return { downloadedArchive };
    },
    async verifyChecksum(plan) {
      if (!downloadedArchive) fail("download must run before verifyChecksum");
      const result = await checked("sha256sum", [downloadedArchive], {
        plan,
        privileged: true,
      });
      const actual = String(result.stdout || "").trim().split(/\s+/)[0]?.toLowerCase();
      const expected = String(plan.asset.sha256 || "").toLowerCase();
      if (actual !== expected) {
        fail(`sha256 mismatch for ${downloadedArchive}: expected ${expected}, got ${actual || "unknown"}`);
      }
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

function safeAssetArchiveName(plan) {
  const fallback = `hanaagent-${plan.tag}.tar.gz`;
  const name = typeof plan.asset?.name === "string" && plan.asset.name.trim()
    ? plan.asset.name.trim()
    : fallback;
  if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    fail(`Release asset name must be a filename: ${name}`);
  }
  return name;
}

function defaultTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function formatPlanTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
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

function inspectServiceState(serviceName = DEFAULT_PATHS.serviceName) {
  const active = runCommand("systemctl", ["is-active", serviceName]);
  const enabled = runCommand("systemctl", ["is-enabled", serviceName]);
  const mainPid = runCommand("systemctl", ["show", "-p", "MainPID", "--value", serviceName]);
  return {
    active: active.status === 0 ? active.stdout.trim() : null,
    enabled: enabled.status === 0 ? enabled.stdout.trim() : null,
    mainPid: mainPid.status === 0 ? mainPid.stdout.trim() : null,
  };
}

function usage() {
  return `install-server - HanaAgent Linux server installer

Usage:
  node scripts/install-server.mjs upgrade --metadata <release.json> --current-version <version> [--dry-run]
  node scripts/install-server.mjs install --metadata <release.json> --platform linux --arch arm64 --dry-run
  node scripts/install-server.mjs upgrade --metadata <release.json> --current-version <version> --platform linux --arch arm64 --dry-run
  node scripts/install-server.mjs status
  node scripts/install-server.mjs backup --output <path>
  node scripts/install-server.mjs reinit-data [--dry-run] [--data-root <path>] [--plan-dir <path>]

Notes:
  upgrade dry-run is safe and does not mutate host state.
  reinit-data currently supports dry-run planning only; confirm/restore fail closed until backup and restore gates are implemented.`;
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
      case "--data-root":
        options.dataRoot = rest[++i];
        break;
      case "--plan-dir":
        options.planDir = rest[++i];
        break;
      case "--confirm":
        options.confirmPlanId = rest[++i];
        break;
      case "--restore":
        options.restorePath = rest[++i];
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
  if (options.command === "install") {
    if (!options.metadataPath) fail("install requires --metadata <release.json>");
    const plan = buildInstallPlan({
      metadata: readJson(options.metadataPath),
      platform: options.platform,
      arch: options.arch,
      dryRun: options.dryRun,
    });
    console.log(JSON.stringify(plan, null, 2));
    if (!options.dryRun) {
      fail("Host-mutating install execution is not wired yet; run dry-run or implement tested install ops.");
    }
    return;
  }
  if (options.command === "status") {
    console.log(JSON.stringify(buildStatusPlan(), null, 2));
    return;
  }
  if (options.command === "reinit-data") {
    if (options.confirmPlanId) {
      fail("reinit-data --confirm is not implemented yet; run reinit-data --dry-run only until backup/restore gates are wired.");
    }
    if (options.restorePath) {
      fail("reinit-data --restore is not implemented yet; run reinit-data --dry-run only until backup/restore gates are wired.");
    }
    if (!options.dryRun) {
      fail("reinit-data execution is not implemented yet; run reinit-data --dry-run only.");
    }
    const plan = buildReinitDataDryRunPlan({
      dataRoot: options.dataRoot || resolveHanaDataRoot(),
      planDir: options.planDir,
      serviceState: inspectServiceState(DEFAULT_PATHS.serviceName),
    });
    console.log(JSON.stringify(writeReinitDataDryRunPlan(plan), null, 2));
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
