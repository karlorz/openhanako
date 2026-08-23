import { Type, StringEnum } from "../pi-sdk/index.ts";
import { toolError } from "./tool-result.ts";
import {
  ACTIONS,
  COMPAT_ACTIONS,
  asText,
  existingSourceReviewDetails,
  getEngine,
  getMarketplaceService,
  readHostOwner,
  resolveInvocation,
  resolveLocalAllowedRoot,
  resolveUserSkillsDir,
} from "./plugin-marketplace-shared.ts";
import { pluginMarketplaceActionHandlers } from "./plugin-marketplace-actions.ts";

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
    execute: async (_toolCallId: string, params: any = {}, ...rest: any[]) => {
      try {
        const engine = getEngine(deps);
        const svc = getMarketplaceService(engine);
        const hostOwner = readHostOwner(rest);
        const action = asText(params.action) || "list_catalog";
        const handler = pluginMarketplaceActionHandlers[action];
        if (!handler) {
          return toolError(`Unsupported marketplace action: ${action}`, {
            ok: false,
            code: "PLUGIN_MARKETPLACE_ACTION_UNSUPPORTED",
          });
        }
        return await handler({ engine, svc, params, hostOwner });
      } catch (err: any) {
        return toolError(err?.message || String(err), {
          ok: false,
          code: err?.code || "PLUGIN_MARKETPLACE_TOOL_ERROR",
        });
      }
    },
  };
}
