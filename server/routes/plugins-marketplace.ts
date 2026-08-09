import { Hono } from "hono";
import fs from "fs";
import path from "path";
import os from "os";
import { extractZip } from "../../lib/extract-zip.ts";
import {
  createDefaultPluginMarketplace,
  getMarketplacePluginVersionState,
} from "../../lib/plugin-marketplace.ts";
import { PluginMarketplaceService } from "../../lib/plugin-marketplace-service.ts";
import { descriptorFromMarketplaceSourceInput } from "../../lib/plugin-marketplace-sources.ts";
import { PluginSourceSwitchCoordinator, createInProcessQuiesceHandle } from "../../lib/plugin-source-switch.ts";
import {
  LEGACY_UNQUALIFIED_MARKETPLACE_ID,
  PluginInstallRecords,
} from "../../lib/plugin-install-records.ts";
import { PluginArtifactStore } from "../../lib/plugin-artifact-store.ts";
import {
  createPluginInstallBackup,
  restorePluginInstallBackup,
} from "../../lib/plugin-install-backups.ts";
import { inspectMarketplacePackage } from "../../lib/plugin-marketplace-inspector.ts";
import { emitAppEvent } from "../app-events.ts";
import { uninstallMarketplaceSkillPackage } from "../../lib/plugin-marketplace-skill-uninstall.ts";
import { refreshMarketplaceSkillRuntime } from "../../lib/plugin-marketplace-skill-runtime.ts";
import { safeFetchBytes } from "../../lib/plugin-marketplace-network-policy.ts";
import {
  marketplacePluginDataDir,
  marketplacePluginSecretsDir,
  PluginTrustStore,
} from "../../lib/plugin-trust-store.ts";
import { PluginMarketplaceNativeLifecycle } from "../../lib/plugin-marketplace-native-lifecycle.ts";
import { readMarketplaceActiveMarker } from "../../lib/plugin-marketplace-active-marker.ts";
import {
  assertArtifactDigest,
  assertMarketplaceId,
  assertPluginId,
} from "../../lib/plugin-marketplace-identity.ts";
import { isLocalOwnerPrincipal, isStudioOwnerPrincipal } from "../http/route-security.ts";
import { createModuleLogger } from "../../lib/debug-log.ts";
import {
  createPluginRouteError,
  installPluginFromPath,
  readAuthPrincipal,
  reconcileMissingPluginDirectories,
  removePluginInstallRecord,
  safePathSegment,
} from "./plugins.ts";

const log = createModuleLogger("plugin-marketplace");

const MAX_PLUGIN_RELEASE_PACKAGE_SIZE = 50 * 1024 * 1024;

function defaultCommunityPluginDir(pm: any, pluginId: string) {
  const userPluginsDir = typeof pm?.getUserPluginsDir === "function"
    ? pm.getUserPluginsDir()
    : null;
  if (!userPluginsDir) return null;
  return path.join(userPluginsDir, safePathSegment(pluginId, pluginId));
}

function readLiveOrReconciledInstallRecord(engine: any, pm: any, pluginId: string, installedPlugin: any) {
  if (installedPlugin) return null;
  const record = typeof engine?.getPluginInstallRecord === "function"
    ? engine.getPluginInstallRecord(pluginId)
    : null;
  if (!record) return null;
  const defaultDir = defaultCommunityPluginDir(pm, pluginId);
  if (defaultDir && !fs.existsSync(defaultDir)) {
    removePluginInstallRecord(engine, pluginId);
    return null;
  }
  return record;
}

function readActiveMarketplaceMarker(engine: any, pm: any, pluginId: string) {
  const entryDir = pm?.findPluginEntry?.({ id: pluginId, source: "community" })?.pluginDir || null;
  const fallbackDir = defaultCommunityPluginDir(pm, pluginId)
    || path.join(engine.hanakoHome, "plugins", safePathSegment(pluginId, pluginId));
  for (const pluginDir of new Set([entryDir, fallbackDir].filter(Boolean))) {
    const marker = readMarketplaceActiveMarker(pluginDir as string, pluginId);
    if (marker) return marker;
  }
  return null;
}

function validateExactManagedDeletionTarget(rootDir: string, targetDir: string): string {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetDir);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw createPluginRouteError(
      "Marketplace deletion path is outside its managed root",
      409,
      "PLUGIN_MARKETPLACE_STATE_PATH_UNSAFE",
    );
  }

  let current = root;
  for (const segment of ["", ...relative.split(path.sep)]) {
    if (segment) current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw createPluginRouteError(
        "Marketplace deletion refuses symlinked managed paths",
        409,
        "PLUGIN_MARKETPLACE_STATE_PATH_UNSAFE",
      );
    }
  }
  return target;
}

function removeValidatedRuntimeStateDirectory(runtimeStateDir: string): boolean {
  if (!fs.existsSync(runtimeStateDir)) return false;
  fs.rmSync(runtimeStateDir, { recursive: true, force: true });
  return true;
}

function removeValidatedInstallBackupDirectory(installBackupDir: string): boolean {
  if (!fs.existsSync(installBackupDir)) return false;
  fs.rmSync(installBackupDir, { recursive: true, force: true });
  return true;
}

async function downloadMarketplaceRelease({ engine, plugin }: { engine: any; plugin: any }) {
  const dist = plugin?.distribution;
  if (!dist || dist.kind !== "release") {
    const err = new Error("Plugin has no release distribution") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  if (!dist.packageUrl || !dist.sha256) {
    const err = new Error("Plugin release distribution is missing packageUrl or sha256") as Error & { status: number };
    err.status = 400;
    throw err;
  }

  const expectedSha256 = String(dist.sha256).trim();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    const err = new Error("Plugin release sha256 must be 64 lowercase hex characters") as Error & { status: number };
    err.status = 400;
    throw err;
  }

  const fetchImpl = engine.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    const err = new Error("fetch is unavailable") as Error & { status: number };
    err.status = 500;
    throw err;
  }
  if (!engine.hanakoHome) {
    const err = new Error("HANA_HOME is unavailable for plugin release installation") as Error & { status: number };
    err.status = 500;
    throw err;
  }

  let body: Buffer;
  try {
    ({ body } = await safeFetchBytes(dist.packageUrl, {
      fetchImpl,
      expectedSha256,
      maxBytes: MAX_PLUGIN_RELEASE_PACKAGE_SIZE,
      allowQuery: true,
    }));
  } catch (cause: any) {
    const message = cause?.message || "Plugin release download failed";
    const err = new Error(message) as Error & { status: number; code?: string };
    err.status = /too large|size limit/i.test(message) ? 413 : 502;
    err.code = cause?.code;
    throw err;
  }

  const pluginId = safePathSegment(plugin.id, "plugin");
  const version = safePathSegment(plugin.version, "0.0.0");
  const downloadsDir = path.join(engine.hanakoHome, "plugin-install-sources", pluginId, version);
  fs.mkdirSync(downloadsDir, { recursive: true });
  const packagePath = path.join(downloadsDir, `${pluginId}-${version}.zip`);
  fs.writeFileSync(packagePath, body);
  return packagePath;
}

function isMarketplacePluginInstallable(plugin: any, marketplace: any) {
  if (plugin.distribution?.kind === "source") {
    return !!marketplace.resolveSourceDistribution(plugin);
  }
  if (plugin.distribution?.kind === "release") {
    return !!(plugin.distribution.packageUrl && plugin.distribution.sha256);
  }
  return false;
}

function marketplacePluginForVersion(plugin: any, versionState: any) {
  return {
    ...plugin,
    version: versionState.selectedVersion || plugin.version,
    compatibility: versionState.selectedCompatibility || plugin.compatibility || {},
    distribution: versionState.selectedDistribution || null,
  };
}

function getEngineAppVersion(engine: any) {
  if (typeof engine.getAppVersion === "function") return engine.getAppVersion();
  return engine.appVersion || "0.0.0";
}

function sanitizeMarketplacePluginForClient(plugin: any) {
  const {
    readme: _readme,
    readmePath: _readmePath,
    distribution,
    versions,
    ...rest
  } = plugin;
  return {
    ...rest,
    distribution: distribution
      ? {
          kind: distribution.kind,
          ...(distribution.path ? { path: distribution.path } : {}),
          ...(distribution.packageUrl ? { packageUrl: distribution.packageUrl } : {}),
          ...(distribution.sha256 ? { sha256: distribution.sha256 } : {}),
        }
      : null,
    versions: Array.isArray(versions)
      ? versions.map((item) => ({
          version: item.version,
          compatibility: item.compatibility || {},
          distribution: item.distribution
            ? {
                kind: item.distribution.kind,
                ...(item.distribution.path ? { path: item.distribution.path } : {}),
                ...(item.distribution.packageUrl ? { packageUrl: item.distribution.packageUrl } : {}),
                ...(item.distribution.sha256 ? { sha256: item.distribution.sha256 } : {}),
              }
            : null,
        }))
      : [],
  };
}

export function getMarketplaceService(engine: any) {
  let service = engine.pluginMarketplaceService as PluginMarketplaceService | undefined;
  if (!service) {
    if (!engine.hanakoHome) {
      throw new Error("HANA_HOME is required for multi-source marketplace service");
    }
    service = new PluginMarketplaceService({
      hanakoHome: engine.hanakoHome,
      fetchOptions: engine.fetch ? { fetchImpl: engine.fetch } : undefined,
    });
    engine.pluginMarketplaceService = service;
  }
  service.startClaudeCompatibilityPolling?.();
  return service;
}

/**
 * Marketplace registry, source-switch and native lifecycle routes.
 * Mounted inside createPluginsRoute at "/" so the effective paths stay
 * under /api/plugins with unchanged precedence (registered where the
 * first marketplace route used to be).
 * @param {import('../../core/engine.ts').HanaEngine} engine
 */

export function createMarketplaceRoutes(engine: any): Hono {
  const route = new Hono();

  function getMarketplace() {
    return engine.pluginMarketplace || createDefaultPluginMarketplace({
      hanakoHome: engine.hanakoHome,
      fetchImpl: engine.fetch,
    } as any);
  }

  function getNativeMarketplaceLifecycle() {
    let lifecycle = engine.pluginMarketplaceNativeLifecycle as PluginMarketplaceNativeLifecycle | undefined;
    if (!lifecycle) {
      lifecycle = new PluginMarketplaceNativeLifecycle({
        service: getMarketplaceService(engine),
        trustStore: new PluginTrustStore({ hanakoHome: engine.hanakoHome }),
      });
      engine.pluginMarketplaceNativeLifecycle = lifecycle;
    }
    return lifecycle;
  }

  function principalFlags(c: any) {
    // HTTP auth middleware sets authPrincipal (not requestPrincipal). Local desktop
    // loopback tokens are kind=local_user + credentialKind=loopback_token.
    const principal = readAuthPrincipal(c)
      || c.get?.("requestPrincipal")
      || c.env?.requestPrincipal
      || null;
    const isLocalOwner = isLocalOwnerPrincipal(principal);
    // Local owner counts as studio.owner for marketplace mutations (desktop Settings).
    const isStudioOwner = isStudioOwnerPrincipal(principal)
      || isLocalOwner
      || principal?.scopes?.includes?.("studio.owner") === true
      || principal?.role === "owner";
    return { isLocalOwner, isStudioOwner, principal };
  }

  function expectedRegistryPreconditionsFromBody(body: any) {
    return {
      expectedRevision: typeof body?.expectedRevision === "number" ? body.expectedRevision : undefined,
      expectedDigest: typeof body?.expectedDigest === "string" ? body.expectedDigest : undefined,
    };
  }

  function expectedRegistryPreconditionsFromQuery(c: any) {
    const rawRevision = c.req.query("expectedRevision");
    const parsedRevision = rawRevision !== undefined ? Number(rawRevision) : undefined;
    return {
      expectedRevision: Number.isInteger(parsedRevision) ? parsedRevision : undefined,
      expectedDigest: c.req.query("expectedDigest") || undefined,
    };
  }

  function marketplaceAccessPayload(flags: ReturnType<typeof principalFlags>) {
    return {
      isStudioOwner: flags.isStudioOwner,
      isLocalOwner: flags.isLocalOwner,
      connectionKind: flags.principal?.connectionKind || flags.principal?.kind || "unknown",
    };
  }

  function marketplaceDiagnosticsPayload(
    svc: ReturnType<typeof getMarketplaceService>,
    flags: ReturnType<typeof principalFlags>,
  ) {
    const report = svc.getControlPlaneDiagnostics({
      // Studio owners may need the complete snapshot to make a safe full
      // activations replacement. Non-owners receive only the metadata needed
      // to inspect revision/schema health; service-local paths and control
      // plane maps remain private.
      forRemote: !flags.isLocalOwner,
    });
    if (flags.isStudioOwner || !report.file) return report;
    return {
      ...report,
      file: {
        schemaVersion: report.file.schemaVersion,
        revision: report.file.revision,
      },
    };
  }

  // ── Multi-source marketplace registry (Approach 1) ──
  route.get("/plugins/marketplace/capabilities", (c) => {
    try {
      const flags = principalFlags(c);
      const svc = getMarketplaceService(engine);
      return c.json({
        ...svc.getCapabilityContract(),
        access: marketplaceAccessPayload(flags),
        registry: svc.getRegistryStatus({ forRemote: !flags.isLocalOwner }),
        configDiagnostics: marketplaceDiagnosticsPayload(svc, flags),
      });
    } catch (err: any) {
      return c.json({
        schemaVersion: 1,
        supported: false,
        version: "plugin-marketplace-capabilities.v1",
        code: "PLUGIN_MARKETPLACE_UNSUPPORTED_SERVER",
        message: err?.message || "Plugin marketplace service is unavailable on this server",
        upgradeGuidance: "Upgrade the connected Hana server to a build with plugin-marketplace-capabilities.v1.",
      }, 501);
    }
  });

  route.get("/plugins/marketplace/config", (c) => {
    const flags = principalFlags(c);
    const svc = getMarketplaceService(engine);
    return c.json({
      capabilities: svc.getCapabilityContract(),
      access: marketplaceAccessPayload(flags),
      registry: svc.getRegistryStatus({ forRemote: !flags.isLocalOwner }),
      configDiagnostics: marketplaceDiagnosticsPayload(svc, flags),
    });
  });

  route.get("/plugins/marketplace/sources", async (c) => {
    const flags = principalFlags(c);
    const forRemote = !flags.isLocalOwner;
    const svc = getMarketplaceService(engine);
    // Seed official snapshot before listing so local Settings is not empty/error on first open.
    await svc.ensureOfficialSnapshotSeededAsync();
    return c.json({
      capabilities: svc.getCapabilityContract(),
      access: marketplaceAccessPayload(flags),
      registry: svc.getRegistryStatus({ forRemote }),
      sources: svc.listSources({ forRemote }),
    });
  });

  route.post("/plugins/marketplace/sources", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      const svc = getMarketplaceService(engine);
      const descriptor = typeof body?.source === "string"
        ? descriptorFromMarketplaceSourceInput(body.source)
        : body;
      const result = await svc.addSource(descriptor, {
        isStudioOwner: flags.isStudioOwner,
        isLocalOwner: flags.isLocalOwner,
        ...expectedRegistryPreconditionsFromBody(body),
      });
      return c.json(result, 201);
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
      }, err.status || 400);
    }
  });

  route.delete("/plugins/marketplace/sources/:marketplaceId", (c) => {
    const flags = principalFlags(c);
    try {
      const svc = getMarketplaceService(engine);
      const result = svc.removeSource(c.req.param("marketplaceId"), {
        isStudioOwner: flags.isStudioOwner,
        ...expectedRegistryPreconditionsFromQuery(c),
      });
      return c.json(result);
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
      }, err.status || 400);
    }
  });

  route.put("/plugins/marketplace/sources/:marketplaceId/enabled", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      const svc = getMarketplaceService(engine);
      const result = svc.setSourceEnabled(c.req.param("marketplaceId"), body.enabled !== false, {
        isStudioOwner: flags.isStudioOwner,
        ...expectedRegistryPreconditionsFromBody(body),
      });
      return c.json(result);
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
      }, err.status || 400);
    }
  });

  route.put("/plugins/marketplace/config/activations", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      const svc = getMarketplaceService(engine);
      const result = svc.setControlPlaneActivations(body.activations, {
        isStudioOwner: flags.isStudioOwner,
        ...expectedRegistryPreconditionsFromBody(body),
      });
      // Package/skill activation toggles must re-wire the package gate and re-sync
      // agent skill injection without waiting for a skills-dir file watch.
      await refreshMarketplaceSkillRuntime(engine, {
        emitSkillsChanged: () => emitAppEvent(engine, "skills-changed", { agentId: null }),
      });
      return c.json({
        ...result,
        registry: svc.getRegistryStatus({ forRemote: !flags.isLocalOwner }),
        configDiagnostics: marketplaceDiagnosticsPayload(svc, flags),
      });
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_MARKETPLACE_CONTROL_PLANE_INVALID",
      }, err.status || 400);
    }
  });

  // Manage Plugins inventory: installed Claude/marketplace skill packages only.
  // Read visibility matches catalog (settings.read); mutations stay owner-gated elsewhere.
  route.get("/plugins/marketplace/installed-skill-packages", (c) => {
    const flags = principalFlags(c);
    try {
      const forRemote = !flags.isLocalOwner;
      const svc = getMarketplaceService(engine);
      const packages = svc.listInstalledSkillPackages({
        userSkillsDir: engine.userSkillsDir || undefined,
      });
      const payload: Record<string, unknown> = {
        packages,
        access: marketplaceAccessPayload(flags),
        registry: svc.getRegistryStatus({ forRemote }),
        capabilities: svc.getCapabilityContract(),
      };
      // Owners get the full activations snapshot so client PUT can clone maps
      // (setControlPlaneActivations replaces the whole activations object).
      if (flags.isStudioOwner) {
        payload.activations = svc.registry.getControlPlaneActivations();
      }
      return c.json(payload);
    } catch (err: any) {
      return c.json({
        packages: [],
        access: marketplaceAccessPayload(flags),
        schemaVersion: 1,
        supported: false,
        version: "plugin-marketplace-capabilities.v1",
        code: "PLUGIN_MARKETPLACE_UNSUPPORTED_SERVER",
        message: err?.message || "Plugin marketplace service is unavailable on this server",
        upgradeGuidance: "Upgrade the connected Hana server to a build with plugin-marketplace-capabilities.v1.",
      }, 501);
    }
  });

  route.get("/plugins/marketplace/compatibility/bindings", (c) => {
    const flags = principalFlags(c);
    const svc = getMarketplaceService(engine);
    return c.json({
      capabilities: svc.getCapabilityContract(),
      access: marketplaceAccessPayload(flags),
      registry: svc.getRegistryStatus({ forRemote: !flags.isLocalOwner }),
      bindings: svc.listClaudeCompatibilityBindings({ forRemote: !flags.isLocalOwner }),
    });
  });

  route.post("/plugins/marketplace/compatibility/plan", async (c) => {
    const flags = principalFlags(c);
    if (!flags.isStudioOwner) {
      return c.json({
        error: "studio.owner required to plan Claude compatibility mutations",
        code: "PLUGIN_MARKETPLACE_CLAUDE_COMPAT_FORBIDDEN",
      }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    try {
      const svc = getMarketplaceService(engine);
      return c.json({ plan: svc.planClaudeCompatibilityMutation(body) });
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_MARKETPLACE_CLAUDE_COMPAT_INVALID",
      }, err.status || 400);
    }
  });

  route.post("/plugins/marketplace/compatibility/execute", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      const svc = getMarketplaceService(engine);
      const result = svc.executeClaudeCompatibilityMutation({
        ...body,
        isStudioOwner: flags.isStudioOwner,
      });
      return c.json({
        result,
        registry: svc.getRegistryStatus({ forRemote: !flags.isLocalOwner }),
        bindings: svc.listClaudeCompatibilityBindings({ forRemote: !flags.isLocalOwner }),
      });
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_MARKETPLACE_CLAUDE_COMPAT_INVALID",
      }, err.status || 400);
    }
  });

  route.post("/plugins/marketplace/compatibility/bridge/validate", async (c) => {
    const flags = principalFlags(c);
    if (!flags.isStudioOwner) {
      return c.json({
        error: "studio.owner required to validate a Claude compatibility bridge",
        code: "PLUGIN_MARKETPLACE_CLAUDE_COMPAT_FORBIDDEN",
      }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    try {
      const svc = getMarketplaceService(engine);
      const envelope = svc.validateClaudeCompatibilityBridge(body.envelope, {
        serverId: body.serverId,
        serverBindingId: body.bindingId,
        deviceId: body.deviceId,
        sessionId: body.sessionId,
      });
      return c.json({ ok: true, envelope });
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_MARKETPLACE_CLAUDE_COMPAT_BRIDGE_INVALID",
      }, err.status || 400);
    }
  });

  route.post("/plugins/marketplace/sources/:marketplaceId/refresh", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      const svc = getMarketplaceService(engine);
      const status = await svc.refreshSource(c.req.param("marketplaceId"), {
        isStudioOwner: flags.isStudioOwner,
        ...expectedRegistryPreconditionsFromBody(body),
      });
      return c.json({ marketplaceId: c.req.param("marketplaceId"), status });
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
      }, err.status || 400);
    }
  });

  route.get("/plugins/marketplace/catalog", async (c) => {
    const flags = principalFlags(c);
    const forRemote = !flags.isLocalOwner;
    const svc = getMarketplaceService(engine);
    const agentId = c.req.query("agentId") || null;
    await svc.ensureOfficialSnapshotSeededAsync();
    return c.json({
      capabilities: svc.getCapabilityContract(),
      access: marketplaceAccessPayload(flags),
      registry: svc.getRegistryStatus({ forRemote }),
      configDiagnostics: marketplaceDiagnosticsPayload(svc, flags),
      ...svc.listCatalogRows({ forRemote, agentId }),
    });
  });

  route.post("/plugins/marketplace/:id/native/install/plan", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      const plan = getNativeMarketplaceLifecycle().planInstall({
        pluginId: c.req.param("id"),
        marketplaceId: body.marketplaceId,
        isStudioOwner: flags.isStudioOwner,
        ...expectedRegistryPreconditionsFromBody(body),
      });
      return c.json(plan);
    } catch (err: any) {
      return c.json({ error: err.message, code: err.code }, err.status || 400);
    }
  });

  route.post("/plugins/marketplace/:id/native/install/execute", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    try {
      const outcome = await getNativeMarketplaceLifecycle().executeInstall({
        planToken: body.planToken,
        confirmation: body.confirmation,
        isStudioOwner: flags.isStudioOwner,
      }, async (facts) => {
        const svc = getMarketplaceService(engine);
        const plugin = svc.getCatalogPlugin(facts.pluginId, facts.marketplaceId);
        if (!plugin) throw createPluginRouteError("Marketplace plugin not found", 404, "PLUGIN_MARKETPLACE_NOT_FOUND");
        let artifactPath = facts.retainedArtifactPath;
        if (!artifactPath) {
          const packagePath = await downloadMarketplaceRelease({ engine, plugin });
          const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-native-retain-"));
          try {
            await extractZip(packagePath, extractDir);
            artifactPath = svc.artifacts.retain({
              marketplaceId: facts.marketplaceId,
              pluginId: facts.pluginId,
              artifactDigest: facts.packageSha256,
              version: facts.version,
              sourceFingerprint: facts.sourceFingerprint,
              catalogSha256: facts.catalogSha256,
              packageSha256: facts.packageSha256,
              packageUrl: facts.packageUrl,
              resolvedRevision: facts.resolvedRevision || undefined,
              packageDir: extractDir,
            }).artifactPath;
          } finally {
            fs.rmSync(extractDir, { recursive: true, force: true });
          }
        }
        const entry = await installPluginFromPath({
          engine,
          pm,
          sourcePath: artifactPath,
          expectedPluginId: facts.pluginId,
          expectedVersion: facts.version,
          marketplaceInstall: {
            marketplaceId: facts.marketplaceId,
            pluginId: facts.pluginId,
            artifactDigest: facts.packageSha256,
          },
          installRecord: {
            source: "marketplace",
            marketplaceId: facts.marketplaceId,
            packageUrl: facts.packageUrl,
            sha256: facts.packageSha256,
            sourceFingerprint: facts.sourceFingerprint,
            catalogSha256: facts.catalogSha256,
            artifactPath,
          },
        });
        svc.records.retainAndActivate({
          pluginId: facts.pluginId,
          marketplaceId: facts.marketplaceId,
          artifactDigest: facts.packageSha256,
          version: facts.version,
          sourceFingerprint: facts.sourceFingerprint,
          catalogSha256: facts.catalogSha256,
          packageSha256: facts.packageSha256,
          packageUrl: facts.packageUrl,
          artifactPath,
          resolvedRevision: facts.resolvedRevision || undefined,
          action: facts.activeArtifactDigest ? "update" : "install",
          result: entry.status || "ok",
        });
        svc.artifacts.markActivated(facts.marketplaceId, facts.pluginId, facts.packageSha256);
        return { ...entry, artifactPath };
      });
      return c.json({ ok: true, ...outcome.result, identity: outcome.plan.identity, artifactDigest: outcome.plan.packageSha256 });
    } catch (err: any) {
      return c.json({ error: err.message, code: err.code }, err.status || 500);
    }
  });

  route.post("/plugins/marketplace/:id/native/uninstall/plan", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(getNativeMarketplaceLifecycle().planUninstall({
        pluginId: c.req.param("id"),
        marketplaceId: body.marketplaceId,
        isStudioOwner: flags.isStudioOwner,
        ...expectedRegistryPreconditionsFromBody(body),
      }));
    } catch (err: any) {
      return c.json({ error: err.message, code: err.code }, err.status || 400);
    }
  });

  route.post("/plugins/marketplace/:id/native/uninstall/execute", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    try {
      const outcome = await getNativeMarketplaceLifecycle().executeUninstall({
        planToken: body.planToken,
        confirmation: body.confirmation,
        isStudioOwner: flags.isStudioOwner,
      }, async (facts) => {
        const svc = getMarketplaceService(engine);
        const activeDir = path.join(pm.getUserPluginsDir(), facts.pluginId);
        const backup = createPluginInstallBackup({
          hanakoHome: engine.hanakoHome,
          pluginId: facts.pluginId,
          marketplaceId: facts.marketplaceId,
          pluginDir: activeDir,
          version: facts.version,
        });
        let pluginDir: string | null = null;
        try {
          pluginDir = await pm.removePlugin(facts.pluginId, { source: "community" });
          await engine.syncPluginExtensions();
          if (pluginDir && fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true, force: true });
          svc.records.deactivate({
            pluginId: facts.pluginId,
            marketplaceId: facts.marketplaceId,
            artifactDigest: facts.packageSha256,
          });
        } catch (err) {
          if (backup && restorePluginInstallBackup(backup, activeDir)) {
            await pm.installPlugin(activeDir, { source: "community" }).catch(() => {});
            await engine.syncPluginExtensions().catch(() => {});
          }
          throw err;
        }
        return { retained: true, installed: false };
      });
      return c.json({ ok: true, identity: outcome.plan.identity, ...outcome.result });
    } catch (err: any) {
      return c.json({ error: err.message, code: err.code }, err.status || 500);
    }
  });

  route.post("/plugins/:pluginId/source-switch/plan", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      const plan = getNativeMarketplaceLifecycle().planSourceSwitch({
        pluginId: c.req.param("pluginId"),
        marketplaceId: body.marketplaceId,
        ...(typeof body.artifactDigest === "string" ? { artifactDigest: body.artifactDigest } : {}),
        isStudioOwner: flags.isStudioOwner,
        ...expectedRegistryPreconditionsFromBody(body),
      });
      return c.json(plan);
    } catch (err: any) {
      return c.json({ error: err.message, code: err.code }, err.status || 500);
    }
  });

  route.post("/plugins/:pluginId/source-switch", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      const outcome = await getNativeMarketplaceLifecycle().executeSourceSwitch({
        planToken: body.planToken,
        confirmation: body.confirmation,
        isStudioOwner: flags.isStudioOwner,
      }, async (facts) => {
        const records = new PluginInstallRecords({ hanakoHome: engine.hanakoHome });
        const artifacts = new PluginArtifactStore({ hanakoHome: engine.hanakoHome });
        const pluginsDir = path.join(engine.hanakoHome, "plugins");
        const coordinator = new PluginSourceSwitchCoordinator({
          records,
          artifacts,
          pluginsDir,
          quiesce: createInProcessQuiesceHandle(),
          runtime: {
            async unloadActive(id) {
              await engine.pluginManager?.disablePlugin?.(id);
            },
            async activateCandidate(input) {
              const entry = await engine.pluginManager?.installPlugin?.(input.artifactPath, {
                source: "community",
                marketplaceInstall: {
                  marketplaceId: input.marketplaceId,
                  pluginId: input.pluginId,
                  artifactDigest: input.artifactDigest,
                },
              });
              if (!entry) {
                throw Object.assign(new Error("PluginManager did not load the switched source"), {
                  code: "PLUGIN_SOURCE_SWITCH_HEALTH_FAILED",
                });
              }
              await engine.pluginManager?.enablePlugin?.(input.pluginId);
              await engine.syncPluginExtensions?.();
            },
            async healthCheck(input) {
              const entry = engine.pluginManager?.findPluginEntry?.({ id: input.pluginId, source: "community" });
              if (!entry || entry.status !== "loaded") return false;
              if (entry.hasLifecycle && entry.activationState !== "activated") return false;
              const marker = readMarketplaceActiveMarker(entry.pluginDir, input.pluginId);
              if (!marker) return false;
              return marker.marketplaceId === input.marketplaceId && marker.artifactDigest === input.artifactDigest;
            },
            async restorePrevious(input) {
              const entry = await engine.pluginManager?.installPlugin?.(input.artifactPath, {
                source: "community",
                marketplaceInstall: {
                  marketplaceId: input.marketplaceId,
                  pluginId: input.pluginId,
                  artifactDigest: input.artifactDigest,
                },
              });
              if (!entry) {
                throw Object.assign(new Error("Rollback: PluginManager did not reload the previous source"), {
                  code: "PLUGIN_SOURCE_SWITCH_ROLLBACK_FAILED",
                });
              }
              await engine.syncPluginExtensions?.();
            },
          },
        });
        const result = await coordinator.switchSource({
          pluginId: facts.pluginId,
          marketplaceId: facts.marketplaceId,
          ...(facts.artifactDigest ? { artifactDigest: facts.artifactDigest } : {}),
        });
        if (!result.ok) {
          const err: any = new Error(result.error?.message || "source switch failed");
          err.code = result.error?.code || "PLUGIN_SOURCE_SWITCH_HEALTH_FAILED";
          err.status = 409;
          throw err;
        }
        return result;
      });
      return c.json({ ok: true, identity: outcome.plan.identity, ...outcome.result });
    } catch (err: any) {
      return c.json({ error: err.message, code: err.code }, err.status || 409);
    }
  });

  route.delete("/plugins/:pluginId/artifacts/:marketplaceId/:artifactDigest", (c) => {
    const flags = principalFlags(c);
    if (!flags.isStudioOwner) {
      return c.json({
        error: "studio.owner required to delete retained Marketplace artifacts",
        code: "PLUGIN_MARKETPLACE_ARTIFACT_DELETE_FORBIDDEN",
      }, 403);
    }

    try {
      const pluginId = assertPluginId(c.req.param("pluginId"));
      const marketplaceId = assertMarketplaceId(c.req.param("marketplaceId"));
      const artifactDigest = assertArtifactDigest(c.req.param("artifactDigest"));
      if (marketplaceId === LEGACY_UNQUALIFIED_MARKETPLACE_ID) {
        throw createPluginRouteError(
          "Legacy-unqualified artifacts cannot be removed through a Marketplace-qualified route",
          409,
          "PLUGIN_MARKETPLACE_LEGACY_STATE_PRESERVED",
        );
      }

      const svc = getMarketplaceService(engine);
      const record = svc.records.get(pluginId);
      const activeMarker = readActiveMarketplaceMarker(engine, engine.pluginManager, pluginId);
      const isActiveRecord = record?.activeMarketplaceId === marketplaceId
        && record?.activeArtifactDigest === artifactDigest;
      const isActiveMarker = activeMarker?.marketplaceId === marketplaceId
        && activeMarker?.artifactDigest === artifactDigest;
      if (isActiveRecord || isActiveMarker) {
        throw createPluginRouteError(
          "Cannot delete the active retained Marketplace artifact",
          409,
          "PLUGIN_MARKETPLACE_ARTIFACT_ACTIVE",
        );
      }

      const retained = record?.retained?.[marketplaceId]?.[artifactDigest] || null;
      const artifact = svc.artifacts.get(marketplaceId, pluginId, artifactDigest);
      if (!retained || !artifact) {
        throw createPluginRouteError(
          "Retained Marketplace artifact not found",
          404,
          "PLUGIN_MARKETPLACE_ARTIFACT_NOT_FOUND",
        );
      }
      const artifactRoot = path.join(engine.hanakoHome, "plugin-artifacts");
      const artifactPath = svc.artifacts.artifactPath(marketplaceId, pluginId, artifactDigest);
      if (
        artifact.marketplaceId !== marketplaceId
        || artifact.pluginId !== pluginId
        || artifact.artifactDigest !== artifactDigest
        || path.resolve(artifact.artifactPath) !== path.resolve(artifactPath)
      ) {
        throw createPluginRouteError(
          "Retained Marketplace artifact metadata does not match its exact identity",
          409,
          "PLUGIN_MARKETPLACE_ARTIFACT_IDENTITY_MISMATCH",
        );
      }
      validateExactManagedDeletionTarget(artifactRoot, artifactPath);

      const recordRemoved = svc.records.removeRetainedArtifact(pluginId, marketplaceId, artifactDigest);
      const artifactRemoved = svc.artifacts.remove({ marketplaceId, pluginId, artifactDigest });
      const trustStore = new PluginTrustStore({ hanakoHome: engine.hanakoHome });
      const trustRevoked = trustStore.revoke(marketplaceId, pluginId, artifactDigest);
      return c.json({
        ok: true,
        pluginId,
        marketplaceId,
        artifactDigest,
        recordRemoved,
        artifactRemoved,
        trustRevoked,
        statePreserved: true,
      });
    } catch (err: any) {
      return c.json({
        error: err?.message || String(err),
        code: err?.code || "PLUGIN_MARKETPLACE_ARTIFACT_DELETE_FAILED",
      }, err?.status || 400);
    }
  });

  route.delete("/plugins/:pluginId/state/:marketplaceId", async (c) => {
    const flags = principalFlags(c);
    if (!flags.isStudioOwner) {
      return c.json({
        error: "studio.owner required to purge Marketplace source state",
        code: "PLUGIN_MARKETPLACE_STATE_PURGE_FORBIDDEN",
      }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    try {
      const pluginId = assertPluginId(c.req.param("pluginId"));
      const marketplaceId = assertMarketplaceId(c.req.param("marketplaceId"));
      if (marketplaceId === LEGACY_UNQUALIFIED_MARKETPLACE_ID) {
        throw createPluginRouteError(
          "Legacy-unqualified plugin state is preserved",
          409,
          "PLUGIN_MARKETPLACE_LEGACY_STATE_PRESERVED",
        );
      }

      const expectedConfirmation = `${pluginId}@${marketplaceId} state purge`;
      if (body?.confirmation !== expectedConfirmation) {
        throw createPluginRouteError(
          `Confirmation must exactly match: ${expectedConfirmation}`,
          409,
          "PLUGIN_MARKETPLACE_CONFIRMATION_MISMATCH",
        );
      }

      const svc = getMarketplaceService(engine);
      const record = svc.records.get(pluginId);
      const activeMarker = readActiveMarketplaceMarker(engine, engine.pluginManager, pluginId);
      if (record?.activeMarketplaceId === marketplaceId || activeMarker?.marketplaceId === marketplaceId) {
        throw createPluginRouteError(
          "Cannot purge state for the active Marketplace source",
          409,
          "PLUGIN_MARKETPLACE_STATE_ACTIVE",
        );
      }

      const dataRoot = path.join(engine.hanakoHome, "plugin-data");
      const secretsRoot = path.join(engine.hanakoHome, "plugin-secrets");
      const backupsRoot = path.join(engine.hanakoHome, "plugin-backups");
      const stateTargets = {
        data: marketplacePluginDataDir(dataRoot, marketplaceId, pluginId),
        secrets: marketplacePluginSecretsDir(secretsRoot, marketplaceId, pluginId),
        backups: path.join(backupsRoot, marketplaceId, pluginId),
      };

      // Validate all targets before the first destructive write so an unsafe
      // symlink or containment failure cannot leave a partially purged source.
      validateExactManagedDeletionTarget(dataRoot, stateTargets.data);
      validateExactManagedDeletionTarget(secretsRoot, stateTargets.secrets);
      validateExactManagedDeletionTarget(backupsRoot, stateTargets.backups);

      const deleted = {
        data: removeValidatedRuntimeStateDirectory(stateTargets.data),
        secrets: removeValidatedRuntimeStateDirectory(stateTargets.secrets),
        backups: removeValidatedInstallBackupDirectory(stateTargets.backups),
      };
      const trustGrantsRevoked = new PluginTrustStore({ hanakoHome: engine.hanakoHome })
        .revokeMarketplacePlugin(marketplaceId, pluginId);

      return c.json({
        ok: true,
        pluginId,
        marketplaceId,
        confirmation: expectedConfirmation,
        deleted,
        trustGrantsRevoked,
        artifactsPreserved: true,
        installHistoryPreserved: true,
        legacyStatePreserved: true,
      });
    } catch (err: any) {
      return c.json({
        error: err?.message || String(err),
        code: err?.code || "PLUGIN_MARKETPLACE_STATE_PURGE_FAILED",
      }, err?.status || 400);
    }
  });

  route.get("/plugins/marketplace", async (c) => {
    const pm = engine.pluginManager;
    const marketplace = getMarketplace();
    const data = await marketplace.load();
    const appVersion = getEngineAppVersion(engine);
    reconcileMissingPluginDirectories(engine, pm);
    const installed = new Map<string, any>((pm?.listPlugins?.({ source: "community" }) || []).map((plugin: any) => [plugin.id, plugin]));
    return c.json({
      ...data,
      plugins: data.plugins.map((plugin) => {
        const installedPlugin = installed.get(plugin.id);
        const installRecord = readLiveOrReconciledInstallRecord(engine, pm, plugin.id, installedPlugin);
        const installedVersion = installedPlugin?.version || installRecord?.installedVersion || null;
        const versionState = getMarketplacePluginVersionState(plugin, {
          appVersion,
          installedVersion,
        });
        const installCandidate = marketplacePluginForVersion(plugin, versionState);
        return {
          ...sanitizeMarketplacePluginForClient(plugin),
          installed: !!installedPlugin,
          ...versionState,
          canInstall: versionState.canInstall && isMarketplacePluginInstallable(installCandidate, marketplace),
        };
      }),
    });
  });

  route.get("/plugins/marketplace/:id/readme", async (c) => {
    const pluginId = c.req.param("id");
    const marketplaceId = c.req.query("marketplaceId") || null;
    try {
      // Prefer multi-source snapshot README when HANA home + marketplaceId/resolvable row exist.
      if (engine.hanakoHome) {
        try {
          const svc = getMarketplaceService(engine);
          if (marketplaceId) {
            const removedPackage = svc.getRemovedMarketplaceSkillsPackage(pluginId, marketplaceId);
            if (removedPackage) {
              return c.json({
                pluginId,
                marketplaceId,
                markdown: removedPackage.description,
                sourceRemoved: true,
              });
            }
          }
          const resolved = svc.resolveInstall(pluginId, marketplaceId);
          if (resolved.ok === true) {
            const row = svc.getCatalogPlugin(pluginId, resolved.row.marketplaceId);
            if (row?.readme) {
              return c.json({
                pluginId,
                marketplaceId: resolved.row.marketplaceId,
                markdown: row.readme,
              });
            }
            if (row?.readmeUrl) {
              const { safeFetchText } = await import("../../lib/plugin-marketplace-network-policy.ts");
              const markdown = await safeFetchText(row.readmeUrl, {
                fetchImpl: engine.fetch || globalThis.fetch,
                allowQuery: true,
              });
              return c.json({
                pluginId,
                marketplaceId: resolved.row.marketplaceId,
                markdown,
              });
            }
            // Claude / multi-source rows often have description only — soft empty, not 404.
            if (row) {
              return c.json({
                pluginId,
                marketplaceId: resolved.row.marketplaceId,
                markdown: row.description || "",
              });
            }
          } else if (marketplaceId && resolved.ok === false) {
            return c.json({
              error: resolved.message || "not found",
              code: `PLUGIN_MARKETPLACE_${resolved.code}`,
            }, resolved.code === "AMBIGUOUS" || resolved.code === "INCOMPLETE" ? 409 : 404);
          }
        } catch {
          // Fall through to legacy single-source path.
        }
      }

      // Legacy single-source fallback
      const marketplace = getMarketplace();
      const readme = await marketplace.getReadme(pluginId);
      if (readme === null) return c.json({ error: "not found" }, 404);
      return c.json({ pluginId, markdown: readme });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/plugins/marketplace/:id/install", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const pluginId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const {
      sessionPath,
      version: targetVersion,
      allowDowngrade = false,
      marketplaceId: requestedMarketplaceId = null,
    } = body;

    try {
      const marketplace = getMarketplace();
      let plugin: any = null;
      let sourceMarketplaceId: string | null = null;
      let catalogSha256: string | null = null;
      let sourceFingerprint: string | null = null;
      let svc: PluginMarketplaceService | null = null;
      let resolution: ReturnType<PluginMarketplaceService["resolveInstall"]> | null = null;

      // Multi-source resolve first when durable home exists (official-wins / qualified / ambiguous).
      if (engine.hanakoHome) {
        svc = getMarketplaceService(engine);
        svc.assertRegistryWritePrecondition(expectedRegistryPreconditionsFromBody(body));
        svc.assertRegistryUsableForAcquisition();
        resolution = svc.resolveInstall(pluginId, requestedMarketplaceId);
        if (resolution.ok === true) {
          sourceMarketplaceId = resolution.row.marketplaceId;
          plugin = svc.getCatalogPlugin(pluginId, sourceMarketplaceId);
          const status = svc.snapshots.getStatus(sourceMarketplaceId);
          if (status.state === "ok" || status.state === "stale" || status.state === "refreshing") {
            catalogSha256 = status.current?.catalogSha256 || null;
            sourceFingerprint = status.current?.sourceFingerprint || null;
          }
        } else if (requestedMarketplaceId && resolution.ok === false) {
          throw createPluginRouteError(
            resolution.message || `Cannot resolve ${pluginId}@${requestedMarketplaceId}`,
            resolution.code === "AMBIGUOUS" || resolution.code === "INCOMPLETE" || resolution.code === "OFFICIAL_UNAVAILABLE"
              ? 409
              : 404,
            `PLUGIN_MARKETPLACE_${resolution.code}`,
          );
        }
      }

      // Legacy single-catalog fallback when multi-source has no snapshot yet.
      if (!plugin) {
        const marketplaceData = await marketplace.load();
        plugin = marketplaceData.plugins.find((item) => item.id === pluginId) || null;
        if (!plugin) {
          if (resolution && resolution.ok === false) {
            throw createPluginRouteError(
              resolution.message || "not found",
              resolution.code === "AMBIGUOUS" || resolution.code === "INCOMPLETE" || resolution.code === "OFFICIAL_UNAVAILABLE"
                ? 409
                : 404,
              `PLUGIN_MARKETPLACE_${resolution.code}`,
            );
          }
          return c.json({ error: "not found" }, 404);
        }
        sourceMarketplaceId = sourceMarketplaceId || "oh-plugins-official";
      }

      const installedPlugin = (pm.listPlugins?.({ source: "community" }) || []).find((item) => item.id === plugin.id);
      const installRecord = readLiveOrReconciledInstallRecord(engine, pm, plugin.id, installedPlugin);
      // Lifecycle ops must stay pinned to the active marketplace when already installed.
      if (installedPlugin && installRecord?.activeMarketplaceId && requestedMarketplaceId
        && installRecord.activeMarketplaceId !== requestedMarketplaceId
        && !allowDowngrade) {
        // Fresh install from another source while one is active is a source-switch concern.
        // Still allow install if the user explicitly targets a marketplace (retain both).
      }
      const installedVersion = installedPlugin?.version || installRecord?.installedVersion || null;
      const versionState = getMarketplacePluginVersionState(plugin, {
        appVersion: getEngineAppVersion(engine),
        installedVersion,
        targetVersion,
      });
      if (!versionState.compatible || !versionState.selectedVersion) {
        throw createPluginRouteError("Plugin is incompatible with this app version", 409, "PLUGIN_VERSION_INCOMPATIBLE");
      }
      if (versionState.downgrade && allowDowngrade !== true) {
        throw createPluginRouteError(
          `Installing v${versionState.selectedVersion} would downgrade installed v${installedVersion}`,
          409,
          "PLUGIN_VERSION_DOWNGRADE",
        );
      }
      // Claude catalog → skills-lane (not Hana deep plugin zip).
      const claudeInstall = plugin?.install && typeof plugin.install === "object"
        ? plugin.install as Record<string, unknown>
        : null;
      if (claudeInstall?.catalogFormat === "claude") {
        if (!svc || !sourceMarketplaceId) {
          return c.json({ error: "Claude marketplace install requires multi-source service" }, 400);
        }
        const userSkillsDir = engine.userSkillsDir;
        if (!userSkillsDir) {
          return c.json({ error: "User skills directory not available" }, 500);
        }
        try {
          const flags = principalFlags(c);
          const expectedSourceSnapshot = body.expectedSourceSnapshot
            && typeof body.expectedSourceSnapshot === "object"
            ? body.expectedSourceSnapshot
            : undefined;
          const result = await svc.installClaudePluginSkills(plugin.id, sourceMarketplaceId, {
            userSkillsDir,
            isStudioOwner: flags.isStudioOwner,
            expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
            expectedDigest: typeof body.expectedDigest === "string" ? body.expectedDigest : undefined,
            ...(expectedSourceSnapshot ? { expectedSourceSnapshot } : {}),
          });
          try {
            await engine.reloadSkills?.();
          } catch {
            // best-effort reload
          }
          return c.json({
            ok: true,
            installTarget: "hana-skills",
            catalogFormat: "claude",
            marketplaceId: result.marketplaceId,
            pluginId: result.pluginId,
            skills: result.skills,
            skipped: result.skipped,
            warnings: result.warnings,
            resolvedRevision: result.resolvedRevision,
          });
        } catch (err: any) {
          const status = err?.status || 400;
          return c.json({
            error: err?.message || String(err),
            code: err?.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
            ...(Array.isArray(err?.skipped) ? { skipped: err.skipped } : {}),
            ...(Array.isArray(err?.warnings) ? { warnings: err.warnings } : {}),
          }, status);
        }
      }

      const marketplaceInspection = inspectMarketplacePackage(plugin);
      if (marketplaceInspection.destination === "native-plugin") {
        throw createPluginRouteError(
          "Native Marketplace packages must use the Studio-owner Settings plan/execute lifecycle.",
          409,
          "PLUGIN_MARKETPLACE_NATIVE_INSTALL_PREVIEW_ONLY",
        );
      }

      const installCandidate = marketplacePluginForVersion(plugin, versionState);
      const sourcePath = marketplace.resolveSourceDistribution(installCandidate)
        || (installCandidate.distribution?.kind === "source" && installCandidate.distribution?.path
          ? installCandidate.distribution.path
          : null);
      const installPath = sourcePath || await downloadMarketplaceRelease({ engine, plugin: installCandidate });
      const packageSha256 = installCandidate.distribution?.sha256
        && /^[a-f0-9]{64}$/.test(installCandidate.distribution.sha256)
        ? installCandidate.distribution.sha256
        : null;

      // Retain immutable artifact before activating when we have a digest.
      let artifactPath = installPath;
      if (svc && packageSha256 && engine.hanakoHome && fs.existsSync(installPath)) {
        try {
          const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-retain-"));
          // installPath may be a zip or a directory
          let packageDir = installPath;
          if (fs.statSync(installPath).isFile()) {
            await extractZip(installPath, extractDir);
            packageDir = extractDir;
          }
          const retained = svc.artifacts.retain({
            marketplaceId: sourceMarketplaceId!,
            pluginId: plugin.id,
            artifactDigest: packageSha256,
            version: versionState.selectedVersion,
            sourceFingerprint: sourceFingerprint || "0".repeat(64),
            catalogSha256: catalogSha256 || "0".repeat(64),
            packageSha256,
            packageUrl: installCandidate.distribution?.packageUrl,
            packageDir,
          });
          artifactPath = retained.artifactPath;
        } catch (retainErr: any) {
          log.warn?.(`artifact retain failed (continuing install): ${retainErr?.message || retainErr}`);
        }
      }

      const entry = await installPluginFromPath({
        engine,
        pm,
        sourcePath: installPath,
        sessionPath,
        expectedPluginId: plugin.id,
        expectedVersion: versionState.selectedVersion,
        allowDowngrade: allowDowngrade === true,
        installRecord: {
          source: "marketplace",
          marketplaceId: sourceMarketplaceId,
          marketplaceSource: sourceMarketplaceId,
          distributionKind: installCandidate.distribution?.kind || null,
          packageUrl: installCandidate.distribution?.packageUrl || null,
          sha256: packageSha256,
          sourceFingerprint: sourceFingerprint || undefined,
          catalogSha256: catalogSha256 || undefined,
          artifactPath,
        },
      });

      // Ensure install-record v2 active pointer after legacy installPluginFromPath write.
      if (svc && packageSha256 && sourceMarketplaceId) {
        try {
          svc.records.retainAndActivate({
            pluginId: plugin.id,
            marketplaceId: sourceMarketplaceId,
            artifactDigest: packageSha256,
            version: versionState.selectedVersion,
            sourceFingerprint: sourceFingerprint || "0".repeat(64),
            catalogSha256: catalogSha256 || "0".repeat(64),
            packageSha256,
            packageUrl: installCandidate.distribution?.packageUrl,
            artifactPath,
            action: installedPlugin ? "update" : "install",
            result: "ok",
          });
        } catch (recErr: any) {
          log.warn?.(`install record v2 update failed: ${recErr?.message || recErr}`);
        }
      }

      return c.json({
        ...entry,
        marketplaceId: sourceMarketplaceId,
        artifactDigest: packageSha256,
      });
    } catch (err: any) {
      return c.json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      }, err.status || 500);
    }
  });

  route.delete("/plugins/marketplace/:id/skills", async (c) => {
    const pluginId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const marketplaceId = typeof body.marketplaceId === "string" ? body.marketplaceId : "";
    if (!marketplaceId) {
      return c.json({
        error: "marketplaceId required for exact marketplace skills uninstall",
        code: "PLUGIN_MARKETPLACE_SOURCE_INVALID",
      }, 400);
    }
    if (!engine.userSkillsDir) {
      return c.json({ error: "User skills directory not available" }, 500);
    }

    try {
      const flags = principalFlags(c);
      const svc = getMarketplaceService(engine);
      const result = await uninstallMarketplaceSkillPackage({
        engine,
        service: svc,
        pluginId,
        marketplaceId,
        userSkillsDir: engine.userSkillsDir,
        isStudioOwner: flags.isStudioOwner,
        ...expectedRegistryPreconditionsFromBody(body),
        emitSkillsChanged: () => emitAppEvent(engine, "skills-changed", { agentId: null }),
      });
      return c.json(result, result.ok ? 200 : 207);
    } catch (err: any) {
      return c.json({
        error: err?.message || String(err),
        code: err?.code || "PLUGIN_MARKETPLACE_SKILLS_UNINSTALL_FAILED",
      }, err?.status || 400);
    }
  });

  return route;
}
