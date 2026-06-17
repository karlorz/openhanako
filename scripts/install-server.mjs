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

// Selects the host's Linux server asset from normalized release metadata.
// Reused by buildUpgradePlan so resolution and plan-building share one path.
export function selectServerAsset(metadata, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "linux") {
    fail(`install-server supports Linux only; got ${platform}`);
  }
  const normalizedArch = normalizeArch(arch);
  const asset = (metadata.assets ?? []).find((item) => {
    return item.platform === "linux" && normalizeArch(item.arch) === normalizedArch;
  });
  if (!asset) {
    fail(`No Linux ${normalizedArch} server asset found in release ${metadata.tag ?? "(no tag)"}`);
  }
  return asset;
}

// Matches hanaagent-server-<tag>-<os>-<arch>.tar.gz asset names published by
// scripts/pack-server-bundle.mjs. os uses the dist-server mapping (mac/win/linux).
const SERVER_ASSET_NAME_RE = /^hanaagent-server-(.+)-(linux|mac|win)-(arm64|x64)\.tar\.gz$/;

function assetFromGithubAsset(g) {
  const m = SERVER_ASSET_NAME_RE.exec(g.name ?? "");
  if (!m) return null;
  return { platform: m[2], arch: m[3], name: g.name, url: g.browser_download_url, sha256: null };
}

// Resolves release metadata for upgrade/install. httpClient is injected so this
// is unit-testable without network; createGithubReleasesClient provides the real
// one for the CLI. Returns { tag, prerelease, assets[] } with only Linux assets.
// GitHub Releases does not expose asset sha256, so assets carry sha256: null —
// the download op verifies against the <asset>.sha256 sidecar at install time.
export async function resolveRelease({ version, channel = "stable", repo = "karlorz/openhanako" } = {}, httpClient) {
  if (!httpClient) fail("resolveRelease requires an injected httpClient");
  let gh;
  if (version) {
    gh = await httpClient.getRelease(version);
    if (!gh) fail(`Release not found: ${version}`);
  } else {
    const all = await httpClient.listReleases();
    gh = all.find((r) => !r.prerelease) ?? null;
    if (!gh) fail("No stable release found; pass --version or --channel prerelease");
  }
  if (gh.prerelease && channel !== "prerelease") {
    fail(`Release ${gh.tag_name} is a prerelease; re-run with --channel prerelease`);
  }
  const assets = (gh.assets ?? []).map(assetFromGithubAsset).filter((a) => a && a.platform === "linux");
  if (assets.length === 0) {
    fail(`Release ${gh.tag_name} has no Linux server bundle asset`);
  }
  return { tag: gh.tag_name, prerelease: !!gh.prerelease, repo, assets };
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
      status: "requires-confirm",
      reason: "Run this command only after reviewing the plan; confirmation creates and verifies a backup before moving the data root aside.",
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

export function loadReinitDataPlan(planIdOrFile, { planDir = "/var/lib/hanaagent/reinit-plans" } = {}) {
  const planFile = resolveReinitPlanFile(planIdOrFile, { planDir });
  if (!fs.existsSync(planFile)) {
    fail(`reinit-data plan not found: ${planFile}`);
  }
  const plan = readJson(planFile);
  if (plan?.kind !== "install-server-reinit-data-dry-run-plan") {
    fail(`reinit-data plan has unsupported kind: ${plan?.kind ?? "missing"}`);
  }
  return plan;
}

export function buildReinitDataConfirmPlan({
  plan,
  now = new Date(),
  dataRoot = resolveHanaDataRoot(),
  paths = {},
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  hasSudo = commandExists("sudo"),
} = {}) {
  if (plan?.kind !== "install-server-reinit-data-dry-run-plan") {
    fail("reinit-data --confirm requires a dry-run plan");
  }
  const expiresAt = new Date(plan.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    fail(`reinit-data plan ${plan.planId ?? "(missing id)"} has invalid expiresAt`);
  }
  if (expiresAt.getTime() <= now.getTime()) {
    fail(`reinit-data plan ${plan.planId} expired at ${plan.expiresAt}; run reinit-data --dry-run again`);
  }
  if (path.resolve(dataRoot) !== path.resolve(plan.dataRoot)) {
    fail(`reinit-data data root mismatch: plan=${plan.dataRoot} current=${dataRoot}`);
  }

  const resolvedPaths = { ...DEFAULT_PATHS, ...(plan.paths ?? {}), ...paths };
  const backupDestination = plan.backup?.destination
    ?? path.join(resolvedPaths.installRoot, "backups", `${plan.planId}.tar.gz`);
  const confirmedAt = now.toISOString();
  const auditPath = plan.audit?.reportPath
    ?? path.join(resolvedPaths.installRoot, "backups", `${plan.planId}.audit.json`);
  const asidePath = `${dataRoot}.aside-${formatPlanTimestamp(now)}`;

  return {
    ...plan,
    kind: "install-server-reinit-data-confirm-plan",
    dryRun: false,
    mutatesData: true,
    confirmedAt,
    sourcePlanFile: plan.planFile,
    platform: "linux",
    dataRoot,
    paths: resolvedPaths,
    privilege: resolvePrivilegeModel({ uid, hasSudo }),
    backup: {
      ...(plan.backup ?? {}),
      destination: backupDestination,
      manifest: plan.backup?.manifest ?? `${backupDestination}.manifest.json`,
      restoreCommand: `node scripts/install-server.mjs reinit-data --restore ${backupDestination}`,
    },
    asidePath,
    audit: {
      ...(plan.audit ?? {}),
      reportPath: auditPath,
      redactSecrets: true,
    },
  };
}

export async function executeReinitDataPlan(plan, ops = {}) {
  const requiredOps = [
    "preflight",
    "stopService",
    "createBackup",
    "verifyBackup",
    "moveDataRootAside",
    "startService",
    "healthCheck",
    "writeAudit",
  ];
  for (const op of requiredOps) {
    if (typeof ops[op] !== "function") {
      fail(`executeReinitDataPlan requires ops.${op}`);
    }
  }

  let resetStarted = false;
  let serviceStopped = false;
  let serviceRestarted = false;
  let startAttempted = false;
  let backupResult = null;
  let asideResult = null;
  try {
    await ops.preflight(plan);
    await ops.stopService(plan);
    serviceStopped = true;
    backupResult = await ops.createBackup(plan);
    await ops.verifyBackup(plan, backupResult);
    resetStarted = true;
    asideResult = await ops.moveDataRootAside(plan);
    startAttempted = true;
    await ops.startService(plan);
    serviceRestarted = true;
    await ops.healthCheck(plan);
    const auditResult = await ops.writeAudit({
      action: "reinit-data-confirm",
      ok: true,
      plan,
      backup: backupResult,
      asidePath: asideResult?.asidePath ?? plan.asidePath,
    });
    return {
      ok: true,
      resetStarted,
      serviceRestarted,
      backupPath: backupResult?.backupPath ?? plan.backup?.destination,
      manifestPath: backupResult?.manifestPath ?? plan.backup?.manifest,
      asidePath: asideResult?.asidePath ?? plan.asidePath,
      auditPath: auditResult?.auditPath ?? plan.audit?.reportPath,
      restoreCommand: plan.backup?.restoreCommand,
    };
  } catch (error) {
    let restartError = null;
    if (serviceStopped && !serviceRestarted && !startAttempted) {
      startAttempted = true;
      try {
        await ops.startService(plan);
        serviceRestarted = true;
      } catch (serviceError) {
        restartError = serviceError instanceof Error ? serviceError.message : String(serviceError);
      }
    }
    return {
      ok: false,
      resetStarted,
      serviceRestarted,
      backupPath: backupResult?.backupPath ?? plan.backup?.destination,
      manifestPath: backupResult?.manifestPath ?? plan.backup?.manifest,
      restoreCommand: plan.backup?.restoreCommand,
      error: error instanceof Error ? error.message : String(error),
      ...(restartError ? { restartError } : {}),
    };
  }
}

export async function executeReinitDataRestore(options, ops = {}) {
  const requiredOps = [
    "verifyBackup",
    "stopService",
    "moveDataRootAside",
    "restoreBackup",
    "startService",
    "healthCheck",
    "writeAudit",
  ];
  for (const op of requiredOps) {
    if (typeof ops[op] !== "function") {
      fail(`executeReinitDataRestore requires ops.${op}`);
    }
  }
  if (!options?.backupPath) {
    fail("reinit-data --restore requires backupPath");
  }

  const restorePlan = {
    kind: "install-server-reinit-data-restore-plan",
    platform: "linux",
    backupPath: options.backupPath,
    dataRoot: options.dataRoot ?? resolveHanaDataRoot(),
    service: { name: options.serviceName ?? DEFAULT_PATHS.serviceName },
    paths: { ...DEFAULT_PATHS, ...(options.paths ?? {}) },
    privilege: options.privilege ?? resolvePrivilegeModel({
      uid: options.uid,
      hasSudo: options.hasSudo,
    }),
    audit: {
      reportPath: options.auditPath ?? `${options.backupPath}.restore-audit.json`,
      redactSecrets: true,
    },
    asidePath: options.asidePath ?? `${options.dataRoot ?? resolveHanaDataRoot()}.pre-restore-${defaultTimestamp()}`,
  };

  let restoreStarted = false;
  let serviceStopped = false;
  let serviceRestarted = false;
  let startAttempted = false;
  let backupVerification = null;
  let asideResult = null;
  try {
    backupVerification = await ops.verifyBackup(restorePlan);
    await ops.stopService(restorePlan);
    serviceStopped = true;
    restoreStarted = true;
    asideResult = await ops.moveDataRootAside(restorePlan);
    await ops.restoreBackup(restorePlan, backupVerification);
    startAttempted = true;
    await ops.startService(restorePlan);
    serviceRestarted = true;
    await ops.healthCheck(restorePlan);
    const auditResult = await ops.writeAudit({
      action: "reinit-data-restore",
      ok: true,
      plan: restorePlan,
      backup: backupVerification,
      asidePath: asideResult?.asidePath ?? restorePlan.asidePath,
    });
    return {
      ok: true,
      restoreStarted,
      serviceRestarted,
      backupPath: restorePlan.backupPath,
      asidePath: asideResult?.asidePath ?? restorePlan.asidePath,
      auditPath: auditResult?.auditPath ?? restorePlan.audit.reportPath,
    };
  } catch (error) {
    let restartError = null;
    if (serviceStopped && !serviceRestarted && !startAttempted) {
      startAttempted = true;
      try {
        await ops.startService(restorePlan);
        serviceRestarted = true;
      } catch (serviceError) {
        restartError = serviceError instanceof Error ? serviceError.message : String(serviceError);
      }
    }
    return {
      ok: false,
      restoreStarted,
      serviceRestarted,
      backupPath: restorePlan.backupPath,
      error: error instanceof Error ? error.message : String(error),
      ...(restartError ? { restartError } : {}),
    };
  }
}

export async function executeReinitDataBackup(options, ops = {}) {
  const requiredOps = ["stopService", "createBackup", "verifyBackup", "startService"];
  for (const op of requiredOps) {
    if (typeof ops[op] !== "function") {
      fail(`executeReinitDataBackup requires ops.${op}`);
    }
  }
  if (!options?.outputPath) {
    fail("backup requires --output <path>");
  }
  const backupPlan = {
    kind: "install-server-reinit-data-backup-plan",
    platform: "linux",
    dataRoot: options.dataRoot ?? resolveHanaDataRoot(),
    service: { name: options.serviceName ?? DEFAULT_PATHS.serviceName },
    paths: { ...DEFAULT_PATHS, ...(options.paths ?? {}) },
    privilege: options.privilege ?? resolvePrivilegeModel({
      uid: options.uid,
      hasSudo: options.hasSudo,
    }),
    backup: {
      destination: options.outputPath,
      manifest: options.manifestPath ?? `${options.outputPath}.manifest.json`,
      restoreCommand: `node scripts/install-server.mjs reinit-data --restore ${options.outputPath}`,
    },
  };
  let serviceStopped = false;
  let serviceRestarted = false;
  let backupResult = null;
  try {
    await ops.stopService(backupPlan);
    serviceStopped = true;
    backupResult = await ops.createBackup(backupPlan);
    const verification = await ops.verifyBackup(backupPlan, backupResult);
    await ops.startService(backupPlan);
    serviceRestarted = true;
    return {
      ok: true,
      serviceRestarted,
      backupPath: backupResult.backupPath,
      manifestPath: backupResult.manifestPath,
      archiveSha256: verification.archiveSha256,
      restoreCommand: backupPlan.backup.restoreCommand,
    };
  } catch (error) {
    let restartError = null;
    if (serviceStopped && !serviceRestarted) {
      try {
        await ops.startService(backupPlan);
        serviceRestarted = true;
      } catch (serviceError) {
        restartError = serviceError instanceof Error ? serviceError.message : String(serviceError);
      }
    }
    return {
      ok: false,
      serviceRestarted,
      backupPath: backupResult?.backupPath ?? backupPlan.backup.destination,
      manifestPath: backupResult?.manifestPath ?? backupPlan.backup.manifest,
      error: error instanceof Error ? error.message : String(error),
      ...(restartError ? { restartError } : {}),
    };
  }
}

const SAFE_REINIT_COMMANDS = new Set(["systemctl", "tar", "sha256sum", "mkdir", "mv", "chown", "test"]);

export function createShellReinitDataOps({
  run = runCommand,
  now = defaultTimestamp,
  owner = "root:root",
} = {}) {
  async function checked(cmd, args, options = {}) {
    if (!SAFE_REINIT_COMMANDS.has(cmd)) {
      fail(`Unexpected reinit-data operation command: ${cmd}`);
    }
    const prefix = options.privileged ? (options.plan?.privilege?.commandPrefix ?? []) : [];
    const commandArgs = [...prefix, cmd, ...args];
    const command = commandArgs.shift();
    const result = await run(command, commandArgs);
    if (result.status !== 0) {
      fail(`${cmd} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
    }
    return result;
  }

  return {
    async preflight(plan) {
      if ((plan.platform ?? "linux") !== "linux") {
        fail(`reinit-data execution supports Linux only; got ${plan.platform}`);
      }
      await checked("test", ["-d", plan.dataRoot], { plan, privileged: true });
      return true;
    },
    async stopService(plan) {
      await checked("systemctl", ["stop", resolvePlanServiceName(plan)], { plan, privileged: true });
      return true;
    },
    async createBackup(plan) {
      const backupPath = resolvePlanBackupPath(plan);
      const manifestPath = resolvePlanManifestPath(plan);
      const parent = path.dirname(plan.dataRoot);
      const basename = path.basename(plan.dataRoot);
      await checked("mkdir", ["-p", path.dirname(backupPath)], { plan, privileged: true });
      await checked("tar", ["-czpf", backupPath, "-C", parent, basename], { plan, privileged: true });
      const listing = await checked("tar", ["-tzf", backupPath], { plan, privileged: true });
      const checksum = await checked("sha256sum", [backupPath], { plan, privileged: true });
      const archiveSha256 = parseSha256sum(checksum.stdout, backupPath);
      writeBackupManifest(manifestPath, {
        kind: "hanaagent-reinit-data-backup-manifest",
        createdAt: new Date().toISOString(),
        backupPath,
        dataRoot: plan.dataRoot,
        archiveSha256,
        entries: parseTarListing(listing.stdout),
        planId: plan.planId ?? null,
        sourcePlanFile: plan.sourcePlanFile ?? plan.planFile ?? null,
      });
      return { backupPath, manifestPath, archiveSha256 };
    },
    async verifyBackup(plan) {
      const backupPath = resolvePlanBackupPath(plan);
      const manifestPath = resolvePlanManifestPath(plan);
      const listing = await checked("tar", ["-tzf", backupPath], { plan, privileged: true });
      const checksum = await checked("sha256sum", [backupPath], { plan, privileged: true });
      const archiveSha256 = parseSha256sum(checksum.stdout, backupPath);
      if (fs.existsSync(manifestPath)) {
        const manifest = readJson(manifestPath);
        if (manifest.archiveSha256 && manifest.archiveSha256 !== archiveSha256) {
          fail(`backup sha256 mismatch for ${backupPath}: expected ${manifest.archiveSha256}, got ${archiveSha256}`);
        }
      }
      return {
        backupPath,
        manifestPath,
        archiveSha256,
        entries: parseTarListing(listing.stdout),
      };
    },
    async moveDataRootAside(plan) {
      const asidePath = plan.asidePath ?? `${plan.dataRoot}.aside-${now()}`;
      if (!fs.existsSync(plan.dataRoot)) {
        return { asidePath: null, skipped: true };
      }
      await checked("mkdir", ["-p", path.dirname(asidePath)], { plan, privileged: true });
      await checked("mv", [plan.dataRoot, asidePath], { plan, privileged: true });
      return { asidePath };
    },
    async restoreBackup(plan) {
      const backupPath = resolvePlanBackupPath(plan);
      await checked("mkdir", ["-p", path.dirname(plan.dataRoot)], { plan, privileged: true });
      await checked("tar", ["-xzpf", backupPath, "-C", path.dirname(plan.dataRoot)], { plan, privileged: true });
      await checked("chown", ["-R", owner, plan.dataRoot], { plan, privileged: true });
      return { dataRoot: plan.dataRoot };
    },
    async startService(plan) {
      await checked("systemctl", ["start", resolvePlanServiceName(plan)], { plan, privileged: true });
      return true;
    },
    async healthCheck(plan) {
      await checked("systemctl", ["is-active", "--quiet", resolvePlanServiceName(plan)], { plan, privileged: true });
      return true;
    },
    async writeAudit(event) {
      const plan = event.plan ?? event;
      const auditPath = plan.audit?.reportPath ?? `${resolvePlanBackupPath(plan)}.audit.json`;
      const audit = {
        kind: "hanaagent-reinit-data-audit",
        action: event.action ?? "reinit-data",
        ok: event.ok ?? true,
        writtenAt: new Date().toISOString(),
        planId: plan.planId ?? null,
        dataRoot: plan.dataRoot,
        backupPath: event.backup?.backupPath ?? plan.backupPath ?? plan.backup?.destination ?? null,
        manifestPath: event.backup?.manifestPath ?? plan.backup?.manifest ?? null,
        asidePath: event.asidePath ?? plan.asidePath ?? null,
        restoreCommand: plan.backup?.restoreCommand ?? (plan.backupPath
          ? `node scripts/install-server.mjs reinit-data --restore ${plan.backupPath}`
          : null),
        redacted: true,
      };
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
      return { auditPath };
    },
  };
}

function assertNoDestructiveDataSteps(steps) {
  // Plan descriptions are part of the dry-run contract; executable upgrade ops
  // are separately constrained by SAFE_UPGRADE_COMMANDS below.
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
    switchedCurrent = true;
    await ops.switchCurrent(plan.targetReleaseDir, plan);
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

const SAFE_UPGRADE_COMMANDS = new Set(["systemctl", "tar", "sha256sum", "curl", "mkdir", "ln"]);

export function createShellUpgradeOps({
  run = runCommand,
  now = defaultTimestamp,
  stagingDir = path.posix.join(os.tmpdir(), "hanaagent-upgrade"),
  backupDir = path.posix.join(DEFAULT_PATHS.installRoot, "backups"),
} = {}) {
  let downloadedArchive = null;
  let backupArchive = null;

  async function checked(cmd, args, options = {}) {
    if (!SAFE_UPGRADE_COMMANDS.has(cmd)) {
      fail(`Unexpected upgrade operation command: ${cmd}`);
    }
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
        await checked(command, ["--version"], { plan });
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

function resolveReinitPlanFile(planIdOrFile, { planDir }) {
  if (typeof planIdOrFile !== "string" || !planIdOrFile.trim()) {
    fail("reinit-data plan id or file path is required");
  }
  const value = planIdOrFile.trim();
  const looksLikePath = path.isAbsolute(value)
    || value.endsWith(".json")
    || value.includes("/")
    || value.includes("\\");
  if (looksLikePath) {
    return value;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    fail(`reinit-data plan id contains unsupported characters: ${value}`);
  }
  return path.join(planDir, `${value}.json`);
}

function resolvePlanServiceName(plan) {
  return plan.service?.name ?? plan.paths?.serviceName ?? DEFAULT_PATHS.serviceName;
}

function resolvePlanBackupPath(plan) {
  const backupPath = plan.backupPath ?? plan.backup?.destination;
  if (typeof backupPath !== "string" || !backupPath.trim()) {
    fail("reinit-data operation requires a backup path");
  }
  return backupPath;
}

function resolvePlanManifestPath(plan) {
  return plan.manifestPath ?? plan.backup?.manifest ?? `${resolvePlanBackupPath(plan)}.manifest.json`;
}

function parseSha256sum(stdout, backupPath) {
  const digest = String(stdout || "").trim().split(/\s+/)[0]?.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest ?? "")) {
    fail(`sha256sum did not return a valid digest for ${backupPath}`);
  }
  return digest;
}

function parseTarListing(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function writeBackupManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
  node scripts/install-server.mjs backup --output <path> [--data-root <path>]
  node scripts/install-server.mjs reinit-data [--dry-run] [--data-root <path>] [--plan-dir <path>]
  node scripts/install-server.mjs reinit-data --confirm <plan-id> [--data-root <path>] [--plan-dir <path>]
  node scripts/install-server.mjs reinit-data --restore <backup-path> [--data-root <path>]

Notes:
  upgrade dry-run is safe and does not mutate host state.
  reinit-data --confirm requires a non-expired dry-run plan and creates a verified backup before moving data aside.
  reinit-data --restore verifies the backup archive before replacing the current data root.`;
}

function parseArgs(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { help: true, dryRun: true };
  }
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
      case "--output":
        options.outputPath = rest[++i];
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
      const dryRunPlan = loadReinitDataPlan(options.confirmPlanId, { planDir: options.planDir });
      const confirmPlan = buildReinitDataConfirmPlan({
        plan: dryRunPlan,
        dataRoot: options.dataRoot || resolveHanaDataRoot(),
      });
      executeReinitDataPlan(confirmPlan, createShellReinitDataOps()).then((result) => {
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
      }).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
      return;
    }
    if (options.restorePath) {
      executeReinitDataRestore({
        backupPath: options.restorePath,
        dataRoot: options.dataRoot || resolveHanaDataRoot(),
        serviceName: DEFAULT_PATHS.serviceName,
      }, createShellReinitDataOps()).then((result) => {
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
      }).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
      return;
    }
    if (!options.dryRun) {
      fail("reinit-data execution requires --confirm <plan-id>; run reinit-data --dry-run first.");
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
    if (!options.outputPath) fail("backup requires --output <path>");
    executeReinitDataBackup({
      outputPath: options.outputPath,
      dataRoot: options.dataRoot || resolveHanaDataRoot(),
      serviceName: DEFAULT_PATHS.serviceName,
    }, createShellReinitDataOps()).then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
    return;
  }
  fail(`Unknown command: ${options.command}`);
}

if (process.argv[1] === __filename) {
  main();
}
