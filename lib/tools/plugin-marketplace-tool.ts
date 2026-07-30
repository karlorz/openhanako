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
] as const;

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
  if (engine.pluginMarketplaceService) return engine.pluginMarketplaceService as PluginMarketplaceService;
  if (!engine.hanakoHome) throw new Error("HANA_HOME is required for marketplace management");
  return new PluginMarketplaceService({
    hanakoHome: engine.hanakoHome,
    fetchOptions: engine.fetch ? { fetchImpl: engine.fetch } : undefined,
  });
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
    description: "Inspect, plan, and install supported Hana marketplace packages. Use plan_install before install; install mutations require session approval.",
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
          return toolOk(safeJson({ sources }), { ok: true, sources });
        }

        if (action === "list_catalog") {
          const catalog = await catalogRows(svc);
          return toolOk(safeJson(catalog), { ok: true, ...catalog });
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
          if (!payload.installable || payload.installTarget === "unsupported") {
            return toolError("Marketplace package is not installable in Hana.", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_UNSUPPORTED",
              ...payload,
            });
          }
          if (payload.installTarget !== "hana-skills") {
            return toolError("Agent marketplace install currently supports Hana skill packages only. Use Settings for native plugin installs until the PluginManager contract audit is complete.", {
              ok: false,
              code: "PLUGIN_MARKETPLACE_NATIVE_INSTALL_NOT_AGENT_ENABLED",
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
