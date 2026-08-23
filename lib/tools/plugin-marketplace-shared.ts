import { createHash } from "node:crypto";
import path from "node:path";
import { toolError } from "./tool-result.ts";
import { PluginMarketplaceService } from "../plugin-marketplace-service.ts";
import {
  createMarketplaceInstallPlan,
  inspectMarketplacePackage,
} from "../plugin-marketplace-inspector.ts";
import { descriptorFromMarketplaceSourceInput } from "../plugin-marketplace-sources.ts";
import { emitAppEvent } from "../../server/app-events.ts";
import { buildPluginMarketplaceRef } from "../plugin-marketplace-identity.ts";
import { refreshMarketplaceSkillRuntime } from "../plugin-marketplace-skill-runtime.ts";

export const ACTIONS = [
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

export const COMPAT_ACTIONS = ["link", "refresh", "disable", "remove", "snapshot-import", "promote"] as const;

export function sourceQualifiedId(pluginId: string, marketplaceId?: string | null) {
  return marketplaceId ? buildPluginMarketplaceRef({ pluginId, marketplaceId }) : pluginId;
}

export function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function planTokenFor(value: unknown): string {
  return createHash("sha256")
    .update(stableJson(value))
    .digest("hex");
}

export function asText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function readHostOwner(args: any[]) {
  const last = args.length > 0 ? args[args.length - 1] : null;
  return last && typeof last === "object" && !Array.isArray(last) && Object.prototype.hasOwnProperty.call(last, "hostOwner")
    ? (last as any).hostOwner
    : null;
}

export function getEngine(deps: { getEngine?: () => any }) {
  const engine = deps.getEngine?.();
  if (!engine) throw new Error("plugin marketplace tool unavailable: engine not ready");
  return engine;
}

export function getMarketplaceService(engine: any) {
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

export function serviceCapabilityPayload(svc: PluginMarketplaceService) {
  return {
    capabilities: typeof (svc as any).getCapabilityContract === "function"
      ? (svc as any).getCapabilityContract()
      : null,
    registry: typeof (svc as any).getRegistryStatus === "function"
      ? (svc as any).getRegistryStatus()
      : null,
  };
}

export async function catalogRows(svc: PluginMarketplaceService, options: { seedOfficial?: boolean } = {}) {
  if (options.seedOfficial !== false) {
    await svc.ensureOfficialSnapshotSeededAsync();
  }
  return svc.listCatalogRows();
}

export async function resolveCatalogPlugin(
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

export function inspectionPayload(svc: PluginMarketplaceService, plugin: any, marketplaceId: string) {
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

export function hasRegistryPreconditions(input: any) {
  return typeof input.expectedRevision === "number" && asText(input.expectedDigest).length > 0;
}

export function registryPreconditions(input: any) {
  return {
    expectedRevision: input.expectedRevision as number,
    expectedDigest: asText(input.expectedDigest),
  };
}

export function packageIdentityRequired(pluginId: string, marketplaceId: string | null) {
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

export function preconditionsRequired() {
  return toolError("expectedRevision and expectedDigest are required for marketplace mutations", {
    ok: false,
    code: "PLUGIN_MARKETPLACE_PRECONDITION_REQUIRED",
  });
}

export async function reloadSkillsBestEffort(engine: any) {
  await refreshMarketplaceSkillRuntime(engine, {
    emitSkillsChanged: () => emitAppEvent(engine, "skills-changed", { agentId: null }),
  });
}

export function resolveLocalAllowedRoot(deps: { getEngine?: () => any }) {
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

export function resolveUserSkillsDir(deps: { getEngine?: () => any }) {
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

export function sourceReviewDetails(source: string, localAllowedRoot: string | null) {
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

export function existingSourceReviewDetails(deps: { getEngine?: () => any }, marketplaceId: string) {
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

export function resolveInvocation(input: any = {}, options: {
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
