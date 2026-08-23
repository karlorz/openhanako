import type { PluginMarketplaceService } from "../plugin-marketplace-service.ts";
import { toolError, toolOk } from "./tool-result.ts";
import {
  COMPAT_ACTIONS,
  asText,
  catalogRows,
  hasRegistryPreconditions,
  inspectionPayload,
  packageIdentityRequired,
  planTokenFor,
  preconditionsRequired,
  registryPreconditions,
  reloadSkillsBestEffort,
  resolveCatalogPlugin,
  safeJson,
  serviceCapabilityPayload,
  sourceQualifiedId,
} from "./plugin-marketplace-shared.ts";
import { descriptorFromMarketplaceSourceInput } from "../plugin-marketplace-sources.ts";
import { uninstallMarketplaceSkillPackage } from "../plugin-marketplace-skill-uninstall.ts";
import { emitAppEvent } from "../../server/app-events.ts";

export type PluginMarketplaceActionInput = {
  engine: any;
  svc: PluginMarketplaceService;
  params: any;
  hostOwner: { isStudioOwner: boolean; isLocalOwner: boolean } | null;
};

export type PluginMarketplaceActionResult = ReturnType<typeof toolOk<any>> | ReturnType<typeof toolError<any>>;

function ownerDenied() {
  return toolError("studio.owner required for marketplace mutations", {
    ok: false,
    code: "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN",
  });
}

async function handleSourceLifecycle(input: PluginMarketplaceActionInput) {
  const { svc, params, hostOwner } = input;
  const action = asText(params.action);
  const marketplaceId = asText(params.marketplaceId) || null;
  if (hostOwner?.isStudioOwner !== true) return ownerDenied();
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
      isStudioOwner: hostOwner?.isStudioOwner === true,
      ...registryPreconditions(params),
    });
  } else if (action === "set_source_enabled") {
    if (typeof params.enabled !== "boolean") {
      return toolError("enabled is required", { ok: false, code: "PLUGIN_MARKETPLACE_ENABLED_REQUIRED" });
    }
    result = svc.setSourceEnabled(marketplaceId, params.enabled, {
      isStudioOwner: hostOwner?.isStudioOwner === true,
      ...registryPreconditions(params),
    });
  } else {
    result = svc.removeSource(marketplaceId, {
      isStudioOwner: hostOwner?.isStudioOwner === true,
      ...registryPreconditions(params),
    });
  }
  const details = { ok: true, result, ...serviceCapabilityPayload(svc) };
  return toolOk(safeJson(details), details);
}

async function handleInspectOrPlanInstall(input: PluginMarketplaceActionInput) {
  const { svc, params } = input;
  const pluginId = asText(params.pluginId);
  const marketplaceId = asText(params.marketplaceId) || null;
  const identityError = packageIdentityRequired(pluginId, marketplaceId);
  if (identityError) return identityError;
  const resolved = await resolveCatalogPlugin(svc, pluginId, marketplaceId);
  const payload = inspectionPayload(svc, resolved.plugin, resolved.marketplaceId);
  return toolOk(safeJson(payload), { ok: true, ...payload });
}

async function handleInstall(input: PluginMarketplaceActionInput) {
  const { engine, svc, params, hostOwner } = input;
  const pluginId = asText(params.pluginId);
  const marketplaceId = asText(params.marketplaceId) || null;
  if (hostOwner?.isStudioOwner !== true) return ownerDenied();
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
    isStudioOwner: hostOwner?.isStudioOwner === true,
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

async function handlePlanUninstallOrUninstall(input: PluginMarketplaceActionInput) {
  const { engine, svc, params, hostOwner } = input;
  const action = asText(params.action);
  const pluginId = asText(params.pluginId);
  const marketplaceId = asText(params.marketplaceId) || null;
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
    if (hostOwner?.isStudioOwner !== true) return ownerDenied();
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
    isStudioOwner: hostOwner?.isStudioOwner === true,
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

export const pluginMarketplaceActionHandlers: Record<string, (input: PluginMarketplaceActionInput) => Promise<PluginMarketplaceActionResult>> = {
  list_sources: async (input) => {
    const { svc } = input;
    await svc.ensureOfficialSnapshotSeededAsync();
    const sources = svc.listSources({ forRemote: true });
    const details = {
      ok: true,
      ...serviceCapabilityPayload(svc),
      sources,
    };
    return toolOk(safeJson(details), details);
  },

  list_installed_packages: async (input) => {
    const { engine, svc } = input;
    const details = {
      ok: true,
      ...serviceCapabilityPayload(svc),
      packages: svc.listInstalledSkillPackages({ userSkillsDir: engine.userSkillsDir || undefined }),
    };
    return toolOk(safeJson(details), details);
  },

  add_source: async (input) => {
    const { svc, params, hostOwner } = input;
    if (hostOwner?.isStudioOwner !== true) return ownerDenied();
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
      isStudioOwner: hostOwner?.isStudioOwner === true,
      isLocalOwner: hostOwner?.isLocalOwner === true,
      ...registryPreconditions(params),
    });
    const details = { ok: true, result, ...serviceCapabilityPayload(svc) };
    return toolOk(safeJson(details), details);
  },

  refresh_source: handleSourceLifecycle,
  set_source_enabled: handleSourceLifecycle,
  remove_source: handleSourceLifecycle,

  set_package_enabled: async (input) => {
    const { engine, svc, params, hostOwner } = input;
    const pluginId = asText(params.pluginId);
    const marketplaceId = asText(params.marketplaceId) || null;
    if (hostOwner?.isStudioOwner !== true) return ownerDenied();
    const identityError = packageIdentityRequired(pluginId, marketplaceId);
    if (identityError) return identityError;
    if (!hasRegistryPreconditions(params)) return preconditionsRequired();
    if (typeof params.enabled !== "boolean") {
      return toolError("enabled is required", { ok: false, code: "PLUGIN_MARKETPLACE_ENABLED_REQUIRED" });
    }
    const result = svc.setMarketplaceSkillPackageEnabled(pluginId, marketplaceId!, params.enabled, {
      isStudioOwner: hostOwner?.isStudioOwner === true,
      ...registryPreconditions(params),
    });
    if (result.changed !== false) await reloadSkillsBestEffort(engine);
    const details = { ok: true, ...result, ...serviceCapabilityPayload(svc) };
    return toolOk(safeJson(details), details);
  },

  diagnose_config: async (input) => {
    const { svc } = input;
    const details = {
      ok: true,
      ...serviceCapabilityPayload(svc),
      configDiagnostics: typeof (svc as any).getControlPlaneDiagnostics === "function"
        ? (svc as any).getControlPlaneDiagnostics()
        : null,
    };
    return toolOk(safeJson(details), details);
  },

  list_catalog: async (input) => {
    const { svc } = input;
    const catalog = await catalogRows(svc);
    const details = {
      ok: true,
      ...serviceCapabilityPayload(svc),
      ...catalog,
    };
    return toolOk(safeJson(details), details);
  },

  inspect_package: handleInspectOrPlanInstall,
  plan_install: handleInspectOrPlanInstall,

  install: handleInstall,

  plan_uninstall: handlePlanUninstallOrUninstall,
  uninstall: handlePlanUninstallOrUninstall,

  set_activations: async (input) => {
    const { svc, params, hostOwner } = input;
    if (hostOwner?.isStudioOwner !== true) return ownerDenied();
    if (!hasRegistryPreconditions(params)) return preconditionsRequired();
    if (!params || !Object.prototype.hasOwnProperty.call(params, "activations")) {
      return toolError("activations is required for set_activations", {
        ok: false,
        code: "PLUGIN_MARKETPLACE_ACTIVATIONS_REQUIRED",
      });
    }
    const result = svc.setControlPlaneActivations(params.activations, {
      isStudioOwner: hostOwner?.isStudioOwner === true,
      ...registryPreconditions(params),
    });
    const details = {
      ok: true,
      ...result,
      ...serviceCapabilityPayload(svc),
      configDiagnostics: svc.getControlPlaneDiagnostics(),
    };
    return toolOk(safeJson(details), details);
  },

  list_compat_bindings: async (input) => {
    const { svc } = input;
    const details = {
      ok: true,
      ...serviceCapabilityPayload(svc),
      bindings: svc.listClaudeCompatibilityBindings(),
    };
    return toolOk(safeJson(details), details);
  },

  plan_compat_mutation: async (input) => {
    const { svc, params } = input;
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
  },

  execute_compat_mutation: async (input) => {
    const { svc, params, hostOwner } = input;
    if (hostOwner?.isStudioOwner !== true) return ownerDenied();
    const compatAction = asText(params.compatAction);
    const planToken = asText(params.planToken);
    if (!COMPAT_ACTIONS.includes(compatAction as any) || !planToken) {
      return toolError("compatAction and planToken are required", { ok: false, code: "PLUGIN_MARKETPLACE_CLAUDE_COMPAT_PLAN_REQUIRED" });
    }
    const result = svc.executeClaudeCompatibilityMutation({
      action: compatAction as any,
      planToken,
      isStudioOwner: hostOwner?.isStudioOwner === true,
      binding: params.binding,
      bindingId: asText(params.bindingId) || undefined,
      virtualSourceId: asText(params.virtualSourceId) || undefined,
    });
    const details = { ok: true, result, ...serviceCapabilityPayload(svc) };
    return toolOk(safeJson(details), details);
  },

  validate_compat_bridge: async (input) => {
    const { svc, params } = input;
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
  },
};
