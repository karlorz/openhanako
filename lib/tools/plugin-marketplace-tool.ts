import { createHash } from "node:crypto";
import { Type, StringEnum } from "../pi-sdk/index.ts";
import { toolError, toolOk } from "./tool-result.ts";
import { PluginMarketplaceService } from "../plugin-marketplace-service.ts";
import {
  createMarketplaceInstallPlan,
  inspectMarketplacePackage,
} from "../plugin-marketplace-inspector.ts";

const ACTIONS = [
  "list_sources",
  "list_catalog",
  "inspect_package",
  "plan_install",
  "install",
  "diagnose_config",
  "set_activations",
  "list_compat_bindings",
  "plan_compat_mutation",
  "execute_compat_mutation",
  "validate_compat_bridge",
] as const;

const COMPAT_ACTIONS = ["link", "refresh", "disable", "remove", "snapshot-import", "promote"] as const;

function sourceQualifiedId(pluginId: string, marketplaceId?: string | null) {
  return marketplaceId ? `${pluginId}@${marketplaceId}` : pluginId;
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

function inspectionPayload(plugin: any, marketplaceId: string) {
  const inspection = inspectMarketplacePackage(plugin);
  const installPlan = createMarketplaceInstallPlan(inspection);
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
    planToken: planTokenFor(planFacts),
  };
}

function resolveInvocation(input: any = {}) {
  const action = asText(input.action) || "list_catalog";
  const pluginId = asText(input.pluginId);
  const marketplaceId = asText(input.marketplaceId);
  const planToken = asText(input.planToken);
  const targetId = pluginId ? sourceQualifiedId(pluginId, marketplaceId) : "marketplace";
  if (action === "install") {
    if (!pluginId || !planToken) return null;
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
        summary: "Installs a marketplace package into Hana.",
        pluginId,
        marketplaceId: marketplaceId || null,
        planToken,
      },
    };
  }
  if (action === "set_activations") {
    return {
      action: "update",
      kind: "review",
      capability: "plugin_marketplace.configure",
      target: {
        type: "setting",
        id: "plugin-marketplace:control-plane",
        label: "Marketplace control-plane activations",
      },
      sideEffect: {
        summary: "Updates marketplace activation/access records in plugin-marketplaces.json.",
        expectedRevision: typeof input.expectedRevision === "number" ? input.expectedRevision : null,
        expectedDigest: typeof input.expectedDigest === "string" ? input.expectedDigest : null,
      },
    };
  }
  if (action === "execute_compat_mutation") {
    if (!planToken || !asText(input.compatAction)) return null;
    return {
      action: "update",
      kind: "review",
      capability: "plugin_marketplace.configure",
      target: {
        type: "setting",
        id: `plugin-marketplace:claude-compat:${asText(input.bindingId) || "new"}`,
        label: `Claude compatibility ${asText(input.compatAction)}`,
      },
      sideEffect: {
        summary: "Updates a server-owned Claude compatibility binding after stale-protected preview.",
        compatAction: asText(input.compatAction),
        bindingId: asText(input.bindingId) || null,
        virtualSourceId: asText(input.virtualSourceId) || null,
        planToken,
      },
    };
  }
  if (ACTIONS.includes(action as any)) {
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
    description: "Inspect, plan, diagnose, and configure supported Hana marketplace packages. Use plan_install before install; install and activation mutations require session approval.",
    sessionPermission: { resolveInvocation },
    parameters: Type.Object({
      action: StringEnum(ACTIONS as unknown as string[], {
        description: "Marketplace action. Use list_catalog or inspect_package before plan_install/install.",
      }),
      pluginId: Type.Optional(Type.String({
        description: "Marketplace package id. Required for inspect_package, plan_install, and install.",
      })),
      marketplaceId: Type.Optional(Type.String({
        description: "Source id such as oh-plugins-official or llm-wiki. Required when pluginId is ambiguous.",
      })),
      planToken: Type.Optional(Type.String({
        description: "Exact plan token returned by plan_install. Required for install to prevent stale package installs.",
      })),
      activations: Type.Optional(Type.Any({
        description: "Full marketplace control-plane activations object for set_activations.",
      })),
      expectedRevision: Type.Optional(Type.Number({
        description: "Expected plugin-marketplaces.json revision. Used by set_activations to reject stale writes.",
      })),
      expectedDigest: Type.Optional(Type.String({
        description: "Expected plugin-marketplaces.json digest. Used by set_activations to reject stale writes.",
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
          const sources = svc.listSources();
          const details = {
            ok: true,
            ...serviceCapabilityPayload(svc),
            sources,
          };
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
          if (!pluginId) return toolError("pluginId is required", { ok: false, code: "PLUGIN_MARKETPLACE_PLUGIN_ID_REQUIRED" });
          const resolved = await resolveCatalogPlugin(svc, pluginId, marketplaceId);
          const payload = inspectionPayload(resolved.plugin, resolved.marketplaceId);
          return toolOk(safeJson(payload), { ok: true, ...payload });
        }

        if (action === "install") {
          if (!pluginId) return toolError("pluginId is required", { ok: false, code: "PLUGIN_MARKETPLACE_PLUGIN_ID_REQUIRED" });
          const planToken = asText(params.planToken);
          if (!planToken) {
            return toolError("planToken is required; call plan_install before install.", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_PLAN_TOKEN_REQUIRED",
            });
          }
          const resolved = await resolveCatalogPlugin(svc, pluginId, marketplaceId);
          const payload = inspectionPayload(resolved.plugin, resolved.marketplaceId);
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
            return toolError("Agent marketplace install currently supports Hana skill packages only. Use Settings for native plugin installs until the PluginManager contract audit is complete.", {
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
          });
          try {
            await engine.reloadSkills?.();
          } catch {
            // Best-effort: install result remains valid if reload is unavailable.
          }
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

        if (action === "set_activations") {
          if (!params || !Object.prototype.hasOwnProperty.call(params, "activations")) {
            return toolError("activations is required for set_activations", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_ACTIVATIONS_REQUIRED",
            });
          }
          const result = svc.setControlPlaneActivations(params.activations, {
            isStudioOwner: true,
            expectedRevision: typeof params.expectedRevision === "number" ? params.expectedRevision : undefined,
            expectedDigest: typeof params.expectedDigest === "string" ? params.expectedDigest : undefined,
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
