import { describe, expect, it, vi } from "vitest";
import { createPluginMarketplaceTool } from "../lib/tools/plugin-marketplace-tool.ts";

const MARKETPLACE_ID = "llm-wiki";

function sourceQualifiedId(pluginId: string, marketplaceId = MARKETPLACE_ID) {
  return `${pluginId}@${marketplaceId}`;
}

function claudeSkillPlugin(overrides: Record<string, unknown> = {}) {
  return {
    id: "skillwiki",
    name: "SkillWiki",
    version: "0.10.22",
    publisher: "LLM Wiki",
    trust: "restricted",
    install: {
      catalogFormat: "claude",
      sourceKind: "relative",
      source: "packages/skills",
      canInstall: true,
    },
    ...overrides,
  };
}

function nativePlugin() {
  return {
    id: "native-page",
    name: "Native Page",
    version: "1.0.0",
    publisher: "Hana",
    trust: "full-access",
    contributions: ["tools", "routes"],
    distribution: {
      kind: "release",
      packageUrl: "https://example.com/native-page.zip",
      sha256: "a".repeat(64),
    },
  };
}

function unsupportedClaudePlugin() {
  return claudeSkillPlugin({
    id: "remote-claude",
    install: {
      catalogFormat: "claude",
      sourceKind: "git-subdir",
      canInstall: false,
    },
  });
}

function makeMarketplaceService(plugin: any = claudeSkillPlugin()) {
  return {
    ensureOfficialSnapshotSeededAsync: vi.fn().mockResolvedValue({ state: "ok" }),
    listSources: vi.fn().mockReturnValue([
      { id: MARKETPLACE_ID, name: "LLM Wiki", kind: "git", authority: "custom", status: "ok" },
    ]),
    listCatalogRows: vi.fn().mockReturnValue({
      sources: [{ id: MARKETPLACE_ID, name: "LLM Wiki", kind: "git", authority: "custom", status: "ok" }],
      plugins: [{
        pluginId: (plugin as any).id,
        marketplaceId: MARKETPLACE_ID,
        compositeKey: sourceQualifiedId((plugin as any).id),
        installTarget: "hana-skills",
      }],
    }),
    resolveInstall: vi.fn().mockImplementation((pluginId: string, marketplaceId?: string | null) => ({
      ok: true,
      mode: marketplaceId ? "qualified" : "unique",
      row: { marketplaceId: marketplaceId || MARKETPLACE_ID, pluginId },
    })),
    getCatalogPlugin: vi.fn().mockReturnValue(plugin),
    installClaudePluginSkills: vi.fn().mockResolvedValue({
      marketplaceId: MARKETPLACE_ID,
      pluginId: (plugin as any).id,
      skills: ["skillwiki"],
      skipped: [],
      warnings: [],
      resolvedRevision: "abc123",
    }),
    getRegistryStatus: vi.fn().mockReturnValue({
      revision: 1,
      digest: "a".repeat(64),
      degraded: false,
    }),
    getControlPlaneDiagnostics: vi.fn().mockReturnValue({
      ok: true,
      degraded: false,
      diagnostics: [],
      summary: {
        schemaVersion: 2,
        revision: 1,
      },
    }),
    setControlPlaneActivations: vi.fn().mockReturnValue({
      revision: 2,
      activations: {
        runtimePlugins: { [`skillwiki@${MARKETPLACE_ID}`]: { enabled: true } },
      },
    }),
    listClaudeCompatibilityBindings: vi.fn().mockReturnValue([]),
    planClaudeCompatibilityMutation: vi.fn().mockImplementation((input) => ({
      ...input,
      revision: 1,
      digest: "a".repeat(64),
      planToken: "compat-plan-token",
    })),
    executeClaudeCompatibilityMutation: vi.fn().mockReturnValue({
      binding: { id: "claude-live", mode: "live", enabled: true },
      state: { digest: "b".repeat(64) },
    }),
    validateClaudeCompatibilityBridge: vi.fn().mockReturnValue({
      version: "claude-compatibility-bridge.v1",
      serverId: "server-1",
      serverBindingId: "claude-live",
    }),
  };
}

function makeTool(options: {
  plugin?: Record<string, unknown>;
  userSkillsDir?: string | null;
  reloadSkills?: () => Promise<void>;
} = {}) {
  const marketplaceService = makeMarketplaceService(options.plugin);
  const reloadSkills = options.reloadSkills || vi.fn().mockResolvedValue(undefined);
  const tool = createPluginMarketplaceTool({
    getEngine: () => ({
      pluginMarketplaceService: marketplaceService,
      userSkillsDir: options.userSkillsDir === null ? null : "/tmp/hana-user-skills",
      reloadSkills,
    }),
  });
  return { tool, marketplaceService, reloadSkills };
}

async function getPlanToken(tool: ReturnType<typeof createPluginMarketplaceTool>, pluginId: string) {
  const plan = await tool.execute("plan-call", {
    action: "plan_install",
    pluginId,
    marketplaceId: MARKETPLACE_ID,
  });
  expect(plan.isError).toBeUndefined();
  expect((plan.details as any).planToken).toEqual(expect.any(String));
  return (plan.details as any).planToken as string;
}

describe("plugin_marketplace Agent tool", () => {
  it("declares read permissions for inspection and review permissions for installs", () => {
    const { tool } = makeTool();

    expect(tool.sessionPermission.resolveInvocation({ action: "list_catalog" })).toMatchObject({
      action: "read",
      kind: "read",
      capability: "plugin_marketplace.read",
      target: { type: "setting", id: "plugin-marketplace:marketplace" },
    });
    expect(tool.sessionPermission.resolveInvocation({
      action: "plan_install",
      pluginId: "skillwiki",
      marketplaceId: MARKETPLACE_ID,
    })).toMatchObject({
      action: "read",
      kind: "read",
      capability: "plugin_marketplace.read",
      target: {
        type: "setting",
        id: `plugin-marketplace:${sourceQualifiedId("skillwiki")}`,
      },
    });
    expect(tool.sessionPermission.resolveInvocation({
      action: "install",
      pluginId: "skillwiki",
      marketplaceId: MARKETPLACE_ID,
      planToken: "plan-token",
    })).toMatchObject({
      action: "install",
      kind: "review",
      capability: "plugin_marketplace.install",
      target: {
        type: "setting",
        id: `plugin-marketplace:${sourceQualifiedId("skillwiki")}`,
      },
      sideEffect: {
        summary: expect.stringContaining(`exact source-qualified package skillwiki@${MARKETPLACE_ID}`),
        pluginId: "skillwiki",
        marketplaceId: MARKETPLACE_ID,
        planToken: "plan-token",
        ownerRequired: true,
      },
    });
    expect(tool.sessionPermission.resolveInvocation({
      action: "install",
      pluginId: "skillwiki",
      marketplaceId: MARKETPLACE_ID,
    })).toBeNull();
    expect(tool.sessionPermission.resolveInvocation({
      action: "set_activations",
      expectedRevision: 1,
    })).toMatchObject({
      action: "update",
      kind: "review",
      capability: "plugin_marketplace.configure",
      target: {
        type: "setting",
        id: "plugin-marketplace:control-plane",
      },
    });
    expect(tool.sessionPermission.resolveInvocation({ action: "remove_source" })).toBeNull();
    expect(tool.sessionPermission.resolveInvocation({
      action: "execute_compat_mutation",
      compatAction: "refresh",
      bindingId: "claude-live",
      planToken: "compat-plan-token",
    })).toMatchObject({
      action: "update",
      kind: "review",
      capability: "plugin_marketplace.configure",
      target: { id: "plugin-marketplace:claude-compat:claude-live" },
    });
  });

  it("lists catalog rows through the marketplace service", async () => {
    const { tool, marketplaceService } = makeTool();

    const result = await tool.execute("call-1", { action: "list_catalog" });

    expect(result.isError).toBeUndefined();
    expect(marketplaceService.ensureOfficialSnapshotSeededAsync).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      ok: true,
      plugins: [{ pluginId: "skillwiki", marketplaceId: MARKETPLACE_ID }],
    });
  });

  it("diagnoses config without seeding catalog snapshots", async () => {
    const { tool, marketplaceService } = makeTool();

    const result = await tool.execute("call-1", { action: "diagnose_config" });

    expect(result.isError).toBeUndefined();
    expect(marketplaceService.ensureOfficialSnapshotSeededAsync).not.toHaveBeenCalled();
    expect(marketplaceService.getControlPlaneDiagnostics).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      ok: true,
      configDiagnostics: {
        ok: true,
        summary: {
          schemaVersion: 2,
          revision: 1,
        },
      },
    });
  });

  it("updates activation control-plane records with optimistic preconditions", async () => {
    const { tool, marketplaceService } = makeTool();

    const result = await tool.execute("call-1", {
      action: "set_activations",
      activations: {
        runtimePlugins: { [`skillwiki@${MARKETPLACE_ID}`]: { enabled: true } },
      },
      expectedRevision: 1,
      expectedDigest: "a".repeat(64),
    });

    expect(result.isError).toBeUndefined();
    expect(marketplaceService.setControlPlaneActivations).toHaveBeenCalledWith(
      {
        runtimePlugins: { [`skillwiki@${MARKETPLACE_ID}`]: { enabled: true } },
      },
      {
        isStudioOwner: true,
        expectedRevision: 1,
        expectedDigest: "a".repeat(64),
      },
    );
    expect(result.details).toMatchObject({
      ok: true,
      revision: 2,
      activations: {
        runtimePlugins: { [`skillwiki@${MARKETPLACE_ID}`]: { enabled: true } },
      },
    });
  });

  it("plans and executes stale-protected Claude compatibility lifecycle mutations", async () => {
    const { tool, marketplaceService } = makeTool();
    const binding = {
      id: "claude-live",
      mode: "live",
      enabled: true,
      inputs: [{ role: "user-settings", path: "/tmp/claude/settings.json" }],
    };

    const planned = await tool.execute("compat-plan", {
      action: "plan_compat_mutation",
      compatAction: "link",
      binding,
    });
    expect(planned.isError).toBeUndefined();
    expect(marketplaceService.planClaudeCompatibilityMutation).toHaveBeenCalledWith({
      action: "link",
      binding,
      bindingId: undefined,
      virtualSourceId: undefined,
    });

    const executed = await tool.execute("compat-execute", {
      action: "execute_compat_mutation",
      compatAction: "link",
      binding,
      planToken: "compat-plan-token",
    });
    expect(executed.isError).toBeUndefined();
    expect(marketplaceService.executeClaudeCompatibilityMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: "link",
      binding,
      planToken: "compat-plan-token",
      isStudioOwner: true,
    }));
  });

  it("validates bridge envelopes without promoting, installing, or changing activation", async () => {
    const { tool, marketplaceService } = makeTool();
    const result = await tool.execute("bridge", {
      action: "validate_compat_bridge",
      serverId: "server-1",
      bindingId: "claude-live",
      deviceId: "device-1",
      sessionId: "session-1",
      bridgeEnvelope: { version: "claude-compatibility-bridge.v1" },
    });
    expect(result.isError).toBeUndefined();
    expect(marketplaceService.validateClaudeCompatibilityBridge).toHaveBeenCalledTimes(1);
    expect(marketplaceService.installClaudePluginSkills).not.toHaveBeenCalled();
    expect(marketplaceService.setControlPlaneActivations).not.toHaveBeenCalled();
  });

  it("returns inspector and install-plan fields for a package", async () => {
    const { tool } = makeTool();

    const result = await tool.execute("call-1", {
      action: "plan_install",
      pluginId: "skillwiki",
      marketplaceId: MARKETPLACE_ID,
    });

    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      ok: true,
      pluginId: "skillwiki",
      marketplaceId: MARKETPLACE_ID,
      identity: sourceQualifiedId("skillwiki"),
      installTarget: "hana-skills",
      installAdapter: "skill-manager",
      installable: true,
      confirmationLevel: "inline",
      capabilityInventory: {
        agentFacing: ["skills"],
      },
      installPlan: {
        action: "install",
        destination: "hana-skills",
        installAdapter: "skill-manager",
        installable: true,
      },
      planToken: expect.any(String),
    });
  });

  it("rejects unsupported Claude packages without mutating", async () => {
    const { tool, marketplaceService } = makeTool({ plugin: unsupportedClaudePlugin() });
    const planToken = await getPlanToken(tool, "remote-claude");

    const result = await tool.execute("call-1", {
      action: "install",
      pluginId: "remote-claude",
      marketplaceId: MARKETPLACE_ID,
      planToken,
    });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      ok: false,
      code: "PLUGIN_MARKETPLACE_UNSUPPORTED",
      pluginId: "remote-claude",
      installTarget: "unsupported",
      installable: false,
    });
    expect(marketplaceService.installClaudePluginSkills).not.toHaveBeenCalled();
  });

  it("keeps native plugin installs out of the Agent until PluginManager contract audit is complete", async () => {
    const { tool, marketplaceService } = makeTool({ plugin: nativePlugin() });
    const planToken = await getPlanToken(tool, "native-page");

    const result = await tool.execute("call-1", {
      action: "install",
      pluginId: "native-page",
      marketplaceId: MARKETPLACE_ID,
      planToken,
    });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      ok: false,
      code: "PLUGIN_MARKETPLACE_NATIVE_INSTALL_NOT_AGENT_ENABLED",
      pluginId: "native-page",
      installTarget: "native-plugin",
      confirmationLevel: "typed-exact",
    });
    expect((result.details as any).warnings).toEqual(expect.arrayContaining([
      "native plugin requests full-access review",
      "native plugin has server-impacting contributions: routes",
    ]));
    expect(marketplaceService.installClaudePluginSkills).not.toHaveBeenCalled();
  });

  it("requires a fresh install plan token before mutating", async () => {
    const { tool, marketplaceService } = makeTool();

    const missing = await tool.execute("call-1", {
      action: "install",
      pluginId: "skillwiki",
      marketplaceId: MARKETPLACE_ID,
    });
    expect(missing.isError).toBe(true);
    expect(missing.details).toMatchObject({
      ok: false,
      code: "PLUGIN_MARKETPLACE_PLAN_TOKEN_REQUIRED",
    });

    const stale = await tool.execute("call-2", {
      action: "install",
      pluginId: "skillwiki",
      marketplaceId: MARKETPLACE_ID,
      planToken: "stale-token",
    });
    expect(stale.isError).toBe(true);
    expect(stale.details).toMatchObject({
      ok: false,
      code: "PLUGIN_MARKETPLACE_PLAN_STALE",
      pluginId: "skillwiki",
      marketplaceId: MARKETPLACE_ID,
      receivedPlanToken: "stale-token",
      expectedPlanToken: expect.any(String),
    });
    expect(marketplaceService.installClaudePluginSkills).not.toHaveBeenCalled();
  });

  it("installs Hana skill packages and reloads skills after approval has passed", async () => {
    const { tool, marketplaceService, reloadSkills } = makeTool();
    const planToken = await getPlanToken(tool, "skillwiki");

    const result = await tool.execute("call-1", {
      action: "install",
      pluginId: "skillwiki",
      marketplaceId: MARKETPLACE_ID,
      planToken,
    });

    expect(result.isError).toBeUndefined();
    expect(marketplaceService.installClaudePluginSkills).toHaveBeenCalledWith(
      "skillwiki",
      MARKETPLACE_ID,
      {
        userSkillsDir: "/tmp/hana-user-skills",
        isStudioOwner: true,
      },
    );
    expect(reloadSkills).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      ok: true,
      installTarget: "hana-skills",
      catalogFormat: "claude",
      marketplaceId: MARKETPLACE_ID,
      pluginId: "skillwiki",
      skills: ["skillwiki"],
      resolvedRevision: "abc123",
    });
  });
});
