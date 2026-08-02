import { createHash } from "node:crypto";
import path from "node:path";
import { Type, StringEnum } from "../pi-sdk/index.ts";
import { toolError, toolOk } from "./tool-result.ts";
import { PluginMarketplaceService } from "../plugin-marketplace-service.ts";
import {
  createMarketplaceInstallPlan,
  inspectMarketplacePackage,
} from "../plugin-marketplace-inspector.ts";
import { descriptorFromMarketplaceSourceInput } from "../plugin-marketplace-sources.ts";
import { uninstallMarketplaceSkillPackage } from "../plugin-marketplace-skill-uninstall.ts";
import { emitAppEvent } from "../../server/app-events.ts";
import { buildPluginMarketplaceRef } from "../plugin-marketplace-identity.ts";
import { refreshMarketplaceSkillRuntime } from "../plugin-marketplace-skill-runtime.ts";

const ACTIONS = [
  "list_sources",
  "list_installed_packages",
  "list_catalog",
  "inspect_package",
  "plan_install",
  "install",
  "add_source",
  "refresh_source",
  "set_source_enabled",
  "remove_source",
  "set_package_enabled",
  "plan_uninstall",
  "uninstall",
  "diagnose_config",
  "set_activations",
  "list_compat_bindings",
  "plan_compat_mutation",
  "execute_compat_mutation",
  "validate_compat_bridge",
] as const;

const COMPAT_ACTIONS = ["link", "refresh", "disable", "remove", "snapshot-import", "promote"] as const;

function sourceQualifiedId(pluginId: string, marketplaceId?: string | null) {
  return marketplaceId ? buildPluginMarketplaceRef({ pluginId, marketplaceId }) : pluginId;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function planTokenFor(value: unknown): string {
  return createHash("sha256")
    .update(stableJson(value))
    .digest("hex");
}

function asText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function getEngine(deps: { getEngine?: () => any }) {
  const engine = deps.getEngine?.();
  if (!engine) throw new Error("plugin marketplace tool unavailable: engine not ready");
  return engine;
}

function getMarketplaceService(engine: any) {
  let service = engine.pluginMarketplaceService as PluginMarketplaceService | undefined;
  if (!service) {
    if (!engine.hanakoHome) throw new Error("HANA_HOME is required for marketplace management");
    service = new PluginMarketplaceService({
      hanakoHome: engine.hanakoHome,
      fetchOptions: engine.fetch ? { fetchImpl: engine.fetch } : undefined,
    });
    engine.pluginMarketplaceService = service;
  }
  service.startClaudeCompatibilityPolling?.();
  return service;
}

function serviceCapabilityPayload(svc: PluginMarketplaceService) {
  return {
    capabilities: typeof (svc as any).getCapabilityContract === "function"
      ? (svc as any).getCapabilityContract()
      : null,
    registry: typeof (svc as any).getRegistryStatus === "function"
      ? (svc as any).getRegistryStatus()
      : null,
  };
}

async function catalogRows(svc: PluginMarketplaceService, options: { seedOfficial?: boolean } = {}) {
  if (options.seedOfficial !== false) {
    await svc.ensureOfficialSnapshotSeededAsync();
  }
  return svc.listCatalogRows();
}

async function resolveCatalogPlugin(
  svc: PluginMarketplaceService,
  pluginId: string,
  marketplaceId?: string | null,
) {
  const resolved = svc.resolveInstall(pluginId, marketplaceId || null);
  if (resolved.ok !== true) {
    const err = new Error(resolved.message || `Cannot resolve ${sourceQualifiedId(pluginId, marketplaceId)}`) as Error & {
      code?: string;
    };
    err.code = `PLUGIN_MARKETPLACE_${resolved.code}`;
    throw err;
  }
  const plugin = svc.getCatalogPlugin(pluginId, resolved.row.marketplaceId);
  if (!plugin) {
    const err = new Error(`Catalog plugin not found: ${sourceQualifiedId(pluginId, resolved.row.marketplaceId)}`) as Error & {
      code?: string;
    };
    err.code = "PLUGIN_MARKETPLACE_NOT_FOUND";
    throw err;
  }
  return {
    marketplaceId: resolved.row.marketplaceId,
    plugin,
  };
}

function inspectionPayload(svc: PluginMarketplaceService, plugin: any, marketplaceId: string) {
  const inspection = inspectMarketplacePackage(plugin);
  const installPlan = createMarketplaceInstallPlan(inspection);
  const planContext = svc.getInstallPlanContext(marketplaceId);
  const planFacts = {
    pluginId: plugin.id,
    marketplaceId,
    version: plugin.version,
    trust: plugin.trust,
    contributions: plugin.contributions || [],
    distribution: plugin.distribution || null,
    install: plugin.install || null,
    installTarget: inspection.destination,
    installAdapter: inspection.installAdapter,
    installable: inspection.installable,
    confirmationLevel: inspection.confirmationLevel,
    capabilityInventory: inspection.capabilityInventory,
    warnings: inspection.warnings,
    installPlan,
    ...planContext,
  };
  return {
    pluginId: plugin.id,
    marketplaceId,
    identity: sourceQualifiedId(plugin.id, marketplaceId),
    name: plugin.name,
    version: plugin.version,
    publisher: plugin.publisher,
    trust: plugin.trust,
    catalogFormat: plugin.install?.catalogFormat || null,
    installTarget: inspection.destination,
    installAdapter: inspection.installAdapter,
    installable: inspection.installable,
    confirmationLevel: inspection.confirmationLevel,
    capabilityInventory: inspection.capabilityInventory,
    warnings: inspection.warnings,
    installPlan,
    ...planContext,
    planToken: planTokenFor(planFacts),
  };
}

function hasRegistryPreconditions(input: any) {
  return typeof input.expectedRevision === "number" && asText(input.expectedDigest).length > 0;
}

function registryPreconditions(input: any) {
  return {
    expectedRevision: input.expectedRevision as number,
    expectedDigest: asText(input.expectedDigest),
  };
}

function packageIdentityRequired(pluginId: string, marketplaceId: string | null) {
  if (!pluginId) {
    return toolError("pluginId is required", { ok: false, code: "PLUGIN_MARKETPLACE_PLUGIN_ID_REQUIRED" });
  }
  if (!marketplaceId) {
    return toolError("marketplaceId is required for exact package identity", {
      ok: false,
      code: "PLUGIN_MARKETPLACE_MARKETPLACE_ID_REQUIRED",
    });
  }
  return null;
}

function preconditionsRequired() {
  return toolError("expectedRevision and expectedDigest are required for marketplace mutations", {
    ok: false,
    code: "PLUGIN_MARKETPLACE_PRECONDITION_REQUIRED",
  });
}

async function reloadSkillsBestEffort(engine: any) {
  await refreshMarketplaceSkillRuntime(engine, {
    emitSkillsChanged: () => emitAppEvent(engine, "skills-changed", { agentId: null }),
  });
}

function resolveLocalAllowedRoot(deps: { getEngine?: () => any }) {
  try {
    const engine = deps.getEngine?.();
    const configured = engine?.pluginMarketplaceService?.localAllowedRoot;
    if (typeof configured === "string" && configured.trim()) return path.resolve(configured);
    if (typeof engine?.hanakoHome === "string" && engine.hanakoHome.trim()) {
      return path.resolve(engine.hanakoHome, "plugin-marketplaces-local");
    }
  } catch {
    // Permission resolution remains fail-closed when the engine is not ready.
  }
  return null;
}

function resolveUserSkillsDir(deps: { getEngine?: () => any }) {
  try {
    const engine = deps.getEngine?.();
    if (typeof engine?.userSkillsDir === "string" && engine.userSkillsDir.trim()) {
      return path.resolve(engine.userSkillsDir);
    }
    if (typeof engine?.hanakoHome === "string" && engine.hanakoHome.trim()) {
      return path.resolve(engine.hanakoHome, "skills");
    }
  } catch {
    // Permission resolution remains fail-closed when the engine is not ready.
  }
  return null;
}

function sourceReviewDetails(source: string, localAllowedRoot: string | null) {
  try {
    const descriptor = descriptorFromMarketplaceSourceInput(source);
    if (descriptor.kind !== "local") return { sourceKind: descriptor.kind };
    if (!localAllowedRoot) return { sourceKind: descriptor.kind };
    return {
      sourceKind: descriptor.kind,
      localSourcePath: path.resolve(localAllowedRoot, descriptor.path),
      localAllowedRoot,
    };
  } catch {
    return {};
  }
}

function existingSourceReviewDetails(deps: { getEngine?: () => any }, marketplaceId: string) {
  try {
    const engine = deps.getEngine?.();
    const service = engine?.pluginMarketplaceService;
    const source = service?.listSources?.().find((candidate: any) => candidate?.id === marketplaceId);
    if (!source) return {};
    const authority = typeof source.authority === "string" ? source.authority : null;
    if (source.kind !== "local" || typeof source.path !== "string") {
      return {
        sourceKind: typeof source.kind === "string" ? source.kind : null,
        ...(authority ? { sourceAuthority: authority } : {}),
      };
    }
    return {
      ...sourceReviewDetails(source.path, resolveLocalAllowedRoot(deps)),
      ...(authority ? { sourceAuthority: authority } : {}),
    };
  } catch {
    return {};
  }
}

function resolveInvocation(input: any = {}, options: {
  localAllowedRoot?: string | null;
  userSkillsDir?: string | null;
  existingSource?: Record<string, unknown>;
} = {}) {
  const action = asText(input.action) || "list_catalog";
  const pluginId = asText(input.pluginId);
  const marketplaceId = asText(input.marketplaceId);
  const planToken = asText(input.planToken);
  const targetId = pluginId ? sourceQualifiedId(pluginId, marketplaceId) : "marketplace";
  if (action === "install") {
    if (!pluginId || !marketplaceId || !planToken) return null;
    return {
      action: "install",
      kind: "review",
      capability: "plugin_marketplace.install",
      target: {
        type: "setting",
        id: `plugin-marketplace:${targetId}`,
        label: `Marketplace install: ${targetId}`,
      },
      sideEffect: {
        summary: `Installs exact source-qualified package ${targetId} on the connected Hana server after validating the current plan token. Server owner access and the normal install permission are required.`,
        pluginId,
        marketplaceId,
        planToken,
        ...(options.userSkillsDir ? { skillInstallRoot: options.userSkillsDir } : {}),
        ownerRequired: true,
      },
    };
  }
  if (action === "uninstall") {
    if (!pluginId || !marketplaceId || !planToken || !hasRegistryPreconditions(input)) return null;
    return {
      action: "uninstall",
      kind: "review",
      capability: "plugin_marketplace.uninstall",
      target: {
        type: "setting",
        id: `plugin-marketplace:${targetId}`,
        label: `Marketplace uninstall: ${targetId}`,
      },
      sideEffect: {
        summary: `Uninstalls the exact Hana skill package ${targetId}, cleans its handled Agent and bundle references, reloads skills, and preserves any partial record. Native PluginManager plugins are not touched.`,
        pluginId,
        marketplaceId,
        planToken,
        ...(options.userSkillsDir ? { skillInstallRoot: options.userSkillsDir } : {}),
        ...registryPreconditions(input),
        ownerRequired: true,
      },
    };
  }
  if (action === "add_source") {
    const source = asText(input.source);
    if (!source || !hasRegistryPreconditions(input)) return null;
    return {
      action: "configure",
      kind: "review",
      capability: "plugin_marketplace.configure",
      target: {
        type: "setting",
        id: "plugin-marketplace:sources",
        label: "Add Marketplace source",
      },
      sideEffect: {
        summary: "Adds one validated public HTTPS or contained server-local Marketplace source after registry revision/digest validation.",
        source,
        ...sourceReviewDetails(source, options.localAllowedRoot || null),
        ...registryPreconditions(input),
        ownerRequired: true,
      },
    };
  }
  if (action === "refresh_source" || action === "set_source_enabled" || action === "remove_source") {
    if (!marketplaceId || !hasRegistryPreconditions(input)) return null;
    if (action === "set_source_enabled" && typeof input.enabled !== "boolean") return null;
    return {
      action: "configure",
      kind: "review",
      capability: "plugin_marketplace.configure",
      target: {
        type: "setting",
        id: `plugin-marketplace:source:${marketplaceId}`,
        label: `Marketplace source: ${marketplaceId}`,
      },
      sideEffect: {
        summary: action === "refresh_source"
          ? `Refreshes Marketplace source ${marketplaceId} after stale-state validation.`
          : action === "set_source_enabled"
            ? `${input.enabled ? "Enables" : "Disables"} Marketplace source ${marketplaceId} without uninstalling packages.`
            : `Removes Marketplace source ${marketplaceId} only when no installed package or activation reference still uses it.`,
        marketplaceId,
        ...(options.existingSource || {}),
        ...(action === "set_source_enabled" ? { enabled: input.enabled } : {}),
        ...registryPreconditions(input),
        ownerRequired: true,
      },
    };
  }
  if (action === "set_package_enabled") {
    if (!pluginId || !marketplaceId || typeof input.enabled !== "boolean" || !hasRegistryPreconditions(input)) return null;
    return {
      action: "configure",
      kind: "review",
      capability: "plugin_marketplace.configure",
      target: {
        type: "setting",
        id: `plugin-marketplace:${targetId}`,
        label: `Marketplace skill package: ${targetId}`,
      },
      sideEffect: {
        summary: `${input.enabled ? "Enables" : "Disables"} every skill in exact package ${targetId} while preserving per-Agent skill preferences and all unrelated activation maps.`,
        pluginId,
        marketplaceId,
        enabled: input.enabled,
        ...registryPreconditions(input),
        ownerRequired: true,
      },
    };
  }
  if (action === "set_activations") {
    if (!hasRegistryPreconditions(input)) return null;
    return {
      action: "configure",
      kind: "review",
      capability: "plugin_marketplace.configure",
      target: {
        type: "setting",
        id: "plugin-marketplace:control-plane",
        label: "Marketplace control-plane activations",
      },
      sideEffect: {
        summary: "Updates exact source-qualified marketplace activation/access records in server-owned plugin-marketplaces.json after revision/digest validation.",
        ...registryPreconditions(input),
        ownerRequired: true,
      },
    };
  }
  if (action === "execute_compat_mutation") {
    if (!planToken || !asText(input.compatAction)) return null;
    return {
      action: "configure",
      kind: "review",
      capability: "plugin_marketplace.configure",
      target: {
        type: "setting",
        id: `plugin-marketplace:claude-compat:${asText(input.bindingId) || "new"}`,
        label: `Claude compatibility ${asText(input.compatAction)}`,
      },
      sideEffect: {
        summary: "Updates a server-owned Claude compatibility binding after stale-protected preview. Unsupported components and secrets remain excluded; promotion/install/activation still use their normal owner-confirmed mutations.",
        compatAction: asText(input.compatAction),
        bindingId: asText(input.bindingId) || null,
        virtualSourceId: asText(input.virtualSourceId) || null,
        planToken,
        ownerRequired: true,
      },
    };
  }
  if (ACTIONS.includes(action as any)) {
    if ((action === "inspect_package" || action === "plan_install" || action === "plan_uninstall")
      && (!pluginId || !marketplaceId)) return null;
    return {
      action: "read",
      kind: "read",
      capability: "plugin_marketplace.read",
      target: {
        type: "setting",
        id: `plugin-marketplace:${targetId}`,
        label: `Marketplace: ${targetId}`,
      },
    };
  }
  return null;
}

export function createPluginMarketplaceTool(deps: {
  getEngine?: () => any;
} = {}) {
  return {
    name: "plugin_marketplace",
    label: "Plugin Marketplace",
    description: "Inspect and manage Claude-compatible Marketplace sources and Hana skill packages. Use plan_install/plan_uninstall before mutations. Agent-driven native Marketplace installation remains unsupported; Studio owners use the Settings signed plan/execute lifecycle.",
    sessionPermission: {
      resolveInvocation: (input: any) => {
        const marketplaceId = asText(input?.marketplaceId);
        return resolveInvocation(input, {
          localAllowedRoot: resolveLocalAllowedRoot(deps),
          userSkillsDir: resolveUserSkillsDir(deps),
          existingSource: marketplaceId ? existingSourceReviewDetails(deps, marketplaceId) : {},
        });
      },
    },
    parameters: Type.Object({
      action: StringEnum(ACTIONS as unknown as string[], {
        description: "Marketplace action. Use list_catalog or inspect_package before plan_install/install.",
      }),
      pluginId: Type.Optional(Type.String({
        description: "Marketplace package id. Required for inspect_package, plan_install, and install.",
      })),
      marketplaceId: Type.Optional(Type.String({
        description: "Exact source id such as oh-plugins-official or llm-wiki. Required for source lifecycle actions and every package mutation.",
      })),
      source: Type.Optional(Type.String({
        description: "One public HTTPS catalog/repository URL or authorized contained server-local path for add_source.",
      })),
      enabled: Type.Optional(Type.Boolean({
        description: "Enabled state for set_source_enabled or set_package_enabled.",
      })),
      planToken: Type.Optional(Type.String({
        description: "Exact plan token returned by plan_install or plan_uninstall. Required for install and uninstall to prevent stale package mutations.",
      })),
      activations: Type.Optional(Type.Any({
        description: "Full marketplace control-plane activations object for set_activations.",
      })),
      expectedRevision: Type.Optional(Type.Number({
        description: "Latest plugin-marketplaces.json revision returned by the preceding tool result. Required for source writes, package enable/disable, uninstall, and set_activations.",
      })),
      expectedDigest: Type.Optional(Type.String({
        description: "Latest plugin-marketplaces.json digest returned by the preceding tool result. Required with expectedRevision for source writes, package enable/disable, uninstall, and set_activations.",
      })),
      compatAction: Type.Optional(StringEnum(COMPAT_ACTIONS as unknown as string[], {
        description: "Claude compatibility lifecycle action for plan_compat_mutation or execute_compat_mutation.",
      })),
      binding: Type.Optional(Type.Any({
        description: "Strict Claude compatibility binding descriptor for a link action.",
      })),
      bindingId: Type.Optional(Type.String({
        description: "Claude compatibility binding id.",
      })),
      virtualSourceId: Type.Optional(Type.String({
        description: "Exact virtual source id for an owner-confirmed promote action.",
      })),
      bridgeEnvelope: Type.Optional(Type.Any({
        description: "Sanitized, versioned desktop bridge envelope to validate without mutation.",
      })),
      serverId: Type.Optional(Type.String({ description: "Expected server id for bridge validation." })),
      deviceId: Type.Optional(Type.String({ description: "Expected bridge device id." })),
      sessionId: Type.Optional(Type.String({ description: "Expected bridge session id." })),
    }),
    execute: async (_toolCallId: string, params: any = {}) => {
      try {
        const engine = getEngine(deps);
        const svc = getMarketplaceService(engine);
        const action = asText(params.action) || "list_catalog";
        const pluginId = asText(params.pluginId);
        const marketplaceId = asText(params.marketplaceId) || null;

        if (action === "list_sources") {
          await svc.ensureOfficialSnapshotSeededAsync();
          const sources = svc.listSources({ forRemote: true });
          const details = {
            ok: true,
            ...serviceCapabilityPayload(svc),
            sources,
          };
          return toolOk(safeJson(details), details);
        }

        if (action === "list_installed_packages") {
          const details = {
            ok: true,
            ...serviceCapabilityPayload(svc),
            packages: svc.listInstalledSkillPackages({ userSkillsDir: engine.userSkillsDir || undefined }),
          };
          return toolOk(safeJson(details), details);
        }

        if (action === "add_source") {
          if (!hasRegistryPreconditions(params)) return preconditionsRequired();
          const sourceInput = asText(params.source);
          if (!sourceInput) {
            return toolError("source is required for add_source", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_SOURCE_REQUIRED",
            });
          }
          const descriptor = descriptorFromMarketplaceSourceInput(sourceInput);
          const result = await svc.addSource(descriptor, {
            isStudioOwner: true,
            isLocalOwner: descriptor.kind === "local",
            ...registryPreconditions(params),
          });
          const details = { ok: true, result, ...serviceCapabilityPayload(svc) };
          return toolOk(safeJson(details), details);
        }

        if (action === "refresh_source" || action === "set_source_enabled" || action === "remove_source") {
          if (!hasRegistryPreconditions(params)) return preconditionsRequired();
          if (!marketplaceId) {
            return toolError("marketplaceId is required", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_MARKETPLACE_ID_REQUIRED",
            });
          }
          let result: unknown;
          if (action === "refresh_source") {
            result = await svc.refreshSource(marketplaceId, {
              isStudioOwner: true,
              ...registryPreconditions(params),
            });
          } else if (action === "set_source_enabled") {
            if (typeof params.enabled !== "boolean") {
              return toolError("enabled is required", { ok: false, code: "PLUGIN_MARKETPLACE_ENABLED_REQUIRED" });
            }
            result = svc.setSourceEnabled(marketplaceId, params.enabled, {
              isStudioOwner: true,
              ...registryPreconditions(params),
            });
          } else {
            result = svc.removeSource(marketplaceId, {
              isStudioOwner: true,
              ...registryPreconditions(params),
            });
          }
          const details = { ok: true, result, ...serviceCapabilityPayload(svc) };
          return toolOk(safeJson(details), details);
        }

        if (action === "set_package_enabled") {
          const identityError = packageIdentityRequired(pluginId, marketplaceId);
          if (identityError) return identityError;
          if (!hasRegistryPreconditions(params)) return preconditionsRequired();
          if (typeof params.enabled !== "boolean") {
            return toolError("enabled is required", { ok: false, code: "PLUGIN_MARKETPLACE_ENABLED_REQUIRED" });
          }
          const result = svc.setMarketplaceSkillPackageEnabled(pluginId, marketplaceId!, params.enabled, {
            isStudioOwner: true,
            ...registryPreconditions(params),
          });
          if (result.changed !== false) await reloadSkillsBestEffort(engine);
          const details = { ok: true, ...result, ...serviceCapabilityPayload(svc) };
          return toolOk(safeJson(details), details);
        }

        if (action === "diagnose_config") {
          const details = {
            ok: true,
            ...serviceCapabilityPayload(svc),
            configDiagnostics: typeof (svc as any).getControlPlaneDiagnostics === "function"
              ? (svc as any).getControlPlaneDiagnostics()
              : null,
          };
          return toolOk(safeJson(details), details);
        }

        if (action === "list_catalog") {
          const catalog = await catalogRows(svc);
          const details = {
            ok: true,
            ...serviceCapabilityPayload(svc),
            ...catalog,
          };
          return toolOk(safeJson(details), details);
        }

        if (action === "inspect_package" || action === "plan_install") {
          const identityError = packageIdentityRequired(pluginId, marketplaceId);
          if (identityError) return identityError;
          const resolved = await resolveCatalogPlugin(svc, pluginId, marketplaceId);
          const payload = inspectionPayload(svc, resolved.plugin, resolved.marketplaceId);
          return toolOk(safeJson(payload), { ok: true, ...payload });
        }

        if (action === "install") {
          const identityError = packageIdentityRequired(pluginId, marketplaceId);
          if (identityError) return identityError;
          const planToken = asText(params.planToken);
          if (!planToken) {
            return toolError("planToken is required; call plan_install before install.", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_PLAN_TOKEN_REQUIRED",
            });
          }
          const resolved = await resolveCatalogPlugin(svc, pluginId, marketplaceId);
          const payload = inspectionPayload(svc, resolved.plugin, resolved.marketplaceId);
          if (planToken !== payload.planToken) {
            return toolError("Marketplace install plan changed; call plan_install again before install.", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_PLAN_STALE",
              pluginId: payload.pluginId,
              marketplaceId: payload.marketplaceId,
              identity: payload.identity,
              expectedPlanToken: payload.planToken,
              receivedPlanToken: planToken,
            });
          }
          if (payload.installTarget === "native-plugin") {
            return toolError("Agent-driven native Marketplace installation remains unsupported. Studio owners can use the Settings signed plan/execute lifecycle for native plugin installs.", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_NATIVE_INSTALL_NOT_AGENT_ENABLED",
              ...payload,
            });
          }
          if (!payload.installable || payload.installTarget === "unsupported") {
            return toolError("Marketplace package is not installable in Hana.", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_UNSUPPORTED",
              ...payload,
            });
          }
          const userSkillsDir = engine.userSkillsDir;
          if (!userSkillsDir) {
            return toolError("User skills directory not available", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_USER_SKILLS_DIR_UNAVAILABLE",
            });
          }
          const result = await svc.installClaudePluginSkills(pluginId, resolved.marketplaceId, {
            userSkillsDir,
            isStudioOwner: true,
            expectedRevision: payload.registry.revision,
            expectedDigest: payload.registry.digest || undefined,
            expectedSourceSnapshot: payload.sourceSnapshot,
          });
          await reloadSkillsBestEffort(engine);
          const details = {
            ok: true,
            installTarget: "hana-skills",
            catalogFormat: "claude",
            marketplaceId: result.marketplaceId,
            pluginId: result.pluginId,
            skills: result.skills,
            skipped: result.skipped,
            warnings: result.warnings,
            resolvedRevision: result.resolvedRevision,
          };
          return toolOk(safeJson(details), details);
        }

        if (action === "plan_uninstall" || action === "uninstall") {
          const identityError = packageIdentityRequired(pluginId, marketplaceId);
          if (identityError) return identityError;
          const userSkillsDir = engine.userSkillsDir;
          if (!userSkillsDir) {
            return toolError("User skills directory not available", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_USER_SKILLS_DIR_UNAVAILABLE",
            });
          }
          if (action === "uninstall") {
            if (!hasRegistryPreconditions(params)) return preconditionsRequired();
            if (!asText(params.planToken)) {
              return toolError("planToken is required; call plan_uninstall before uninstall.", {
                ok: false,
                code: "PLUGIN_MARKETPLACE_PLAN_TOKEN_REQUIRED",
              });
            }
          }
          const facts = svc.getMarketplaceSkillPackageUninstallFacts(pluginId, marketplaceId!, { userSkillsDir });
          const expectedPlanToken = planTokenFor(facts);
          if (action === "plan_uninstall") {
            const details = { ok: true, ...facts, planToken: expectedPlanToken };
            return toolOk(safeJson(details), details);
          }
          const planToken = asText(params.planToken);
          if (planToken !== expectedPlanToken) {
            return toolError("Marketplace uninstall plan changed; call plan_uninstall again before uninstall.", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_PLAN_STALE",
              pluginId,
              marketplaceId,
              identity: sourceQualifiedId(pluginId, marketplaceId),
              expectedPlanToken,
              receivedPlanToken: planToken,
            });
          }
          const result = await uninstallMarketplaceSkillPackage({
            engine,
            service: svc,
            pluginId,
            marketplaceId: marketplaceId!,
            userSkillsDir,
            isStudioOwner: true,
            ...registryPreconditions(params),
            emitSkillsChanged: () => emitAppEvent(engine, "skills-changed", { agentId: null }),
          });
          const details = {
            ...result,
            pluginId,
            marketplaceId,
            identity: sourceQualifiedId(pluginId, marketplaceId),
            ...serviceCapabilityPayload(svc),
          };
          return result.ok
            ? toolOk(safeJson(details), details)
            : toolError("Marketplace skill package uninstall was partial.", {
                ...details,
                code: "PLUGIN_MARKETPLACE_SKILLS_UNINSTALL_PARTIAL",
              });
        }

        if (action === "set_activations") {
          if (!hasRegistryPreconditions(params)) return preconditionsRequired();
          if (!params || !Object.prototype.hasOwnProperty.call(params, "activations")) {
            return toolError("activations is required for set_activations", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_ACTIVATIONS_REQUIRED",
            });
          }
          const result = svc.setControlPlaneActivations(params.activations, {
            isStudioOwner: true,
            ...registryPreconditions(params),
          });
          const details = {
            ok: true,
            ...result,
            ...serviceCapabilityPayload(svc),
            configDiagnostics: svc.getControlPlaneDiagnostics(),
          };
          return toolOk(safeJson(details), details);
        }

        if (action === "list_compat_bindings") {
          const details = {
            ok: true,
            ...serviceCapabilityPayload(svc),
            bindings: svc.listClaudeCompatibilityBindings(),
          };
          return toolOk(safeJson(details), details);
        }

        if (action === "plan_compat_mutation") {
          const compatAction = asText(params.compatAction);
          if (!COMPAT_ACTIONS.includes(compatAction as any)) {
            return toolError("compatAction is required", { ok: false, code: "PLUGIN_MARKETPLACE_CLAUDE_COMPAT_ACTION_REQUIRED" });
          }
          const plan = svc.planClaudeCompatibilityMutation({
            action: compatAction as any,
            binding: params.binding,
            bindingId: asText(params.bindingId) || undefined,
            virtualSourceId: asText(params.virtualSourceId) || undefined,
          });
          const details = { ok: true, plan };
          return toolOk(safeJson(details), details);
        }

        if (action === "execute_compat_mutation") {
          const compatAction = asText(params.compatAction);
          const planToken = asText(params.planToken);
          if (!COMPAT_ACTIONS.includes(compatAction as any) || !planToken) {
            return toolError("compatAction and planToken are required", { ok: false, code: "PLUGIN_MARKETPLACE_CLAUDE_COMPAT_PLAN_REQUIRED" });
          }
          const result = svc.executeClaudeCompatibilityMutation({
            action: compatAction as any,
            planToken,
            isStudioOwner: true,
            binding: params.binding,
            bindingId: asText(params.bindingId) || undefined,
            virtualSourceId: asText(params.virtualSourceId) || undefined,
          });
          const details = { ok: true, result, ...serviceCapabilityPayload(svc) };
          return toolOk(safeJson(details), details);
        }

        if (action === "validate_compat_bridge") {
          const serverId = asText(params.serverId);
          const bindingId = asText(params.bindingId);
          if (!serverId || !bindingId || !params.bridgeEnvelope) {
            return toolError("serverId, bindingId, and bridgeEnvelope are required", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_CLAUDE_COMPAT_BRIDGE_REQUIRED",
            });
          }
          const envelope = svc.validateClaudeCompatibilityBridge(params.bridgeEnvelope, {
            serverId,
            serverBindingId: bindingId,
            deviceId: asText(params.deviceId) || undefined,
            sessionId: asText(params.sessionId) || undefined,
          });
          const details = { ok: true, envelope };
          return toolOk(safeJson(details), details);
        }

        return toolError(`Unsupported marketplace action: ${action}`, {
          ok: false,
          code: "PLUGIN_MARKETPLACE_ACTION_UNSUPPORTED",
        });
      } catch (err: any) {
        return toolError(err?.message || String(err), {
          ok: false,
          code: err?.code || "PLUGIN_MARKETPLACE_TOOL_ERROR",
        });
      }
    },
  };
}
