import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_COMPATIBILITY_BRIDGE_VERSION,
  ClaudeCompatibilityBindingService,
  parseClaudeCompatibilityBinding,
  validateClaudeCompatibilityBridgeEnvelope,
  type ClaudeCompatibilityBinding,
} from "../lib/claude-compatibility.ts";
import {
  PluginMarketplaceSourceRegistry,
  diagnoseMarketplaceSourcesText,
} from "../lib/plugin-marketplace-sources.ts";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-claude-compat-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixtureBinding(root: string, mode: ClaudeCompatibilityBinding["mode"] = "live"): ClaudeCompatibilityBinding {
  return {
    id: `${mode}-binding`,
    mode,
    enabled: true,
    inputs: [
      { role: "user-settings", path: path.join(root, "user-settings.json") },
      { role: "project-settings", path: path.join(root, "project-settings.json") },
      { role: "project-local-settings", path: path.join(root, "project-local-settings.json") },
      { role: "known-marketplaces", path: path.join(root, "known-marketplaces.json") },
      { role: "installed-plugins", path: path.join(root, "installed-plugins.json") },
      { role: "plugin-manifest", path: path.join(root, "plugin.json") },
    ],
  };
}

function writeFixture(root: string) {
  writeJson(path.join(root, "user-settings.json"), {
    enabledPlugins: {
      "same@market-a": true,
      "same@market-b": false,
      bare: true,
    },
    extraKnownMarketplaces: {
      "market-a": { source: { source: "github", repo: "org/market-a" } },
      "market-b": { source: { url: "https://example.com/market-b.git", ref: "v1" } },
    },
    env: { ANTHROPIC_API_KEY: "sk-live-secret-value" },
    hooks: { SessionStart: [{ command: "curl secret.invalid" }] },
    mcpServers: { private: { command: "secret-mcp" } },
  });
  writeJson(path.join(root, "project-settings.json"), {
    enabledPlugins: {
      "same@market-a": false,
      "same@market-b": true,
    },
    lsp: { command: "secret-lsp" },
  });
  writeJson(path.join(root, "project-local-settings.json"), {
    enabledPlugins: { "same@market-a": true },
    monitor: { command: "secret-monitor" },
  });
  writeJson(path.join(root, "known-marketplaces.json"), {
    marketplaces: {
      "market-a": { source: { repo: "org/market-a" } },
      "market-b": { source: { url: "https://example.com/market-b.git" } },
    },
  });
  writeJson(path.join(root, "installed-plugins.json"), {
    version: 2,
    plugins: {
      "same@market-a": [{ version: "1.0.0", installPath: "/not/authorized/or/read" }],
    },
  });
  writeJson(path.join(root, "plugin.json"), {
    name: "same",
    version: "1.0.0",
    binaries: ["secret-binary"],
    scripts: { postinstall: "secret-script" },
    SessionStart: { command: "secret-session-start" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Claude compatibility parser", () => {
  it("preserves exact duplicate identities, applies exact precedence, and emits desired-not-installed", () => {
    const root = makeTempDir();
    writeFixture(root);

    const normalized = parseClaudeCompatibilityBinding(fixtureBinding(root), {
      hanaAgentOverrides: { "same@market-a": false },
      hanaConfigOverrides: { "same@market-a": true },
    });

    expect(normalized.precedence).toEqual([
      "hana-safety-policy",
      "hana-config-override",
      "hana-agent-override",
      "claude-project-local",
      "claude-project",
      "claude-user",
      "existing-default",
    ]);
    expect(normalized.desiredPlugins).toEqual({
      "same@market-a": true,
      "same@market-b": true,
    });
    expect(normalized.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        identity: "same@market-a",
        installed: true,
        desiredEnabled: true,
        state: "enabled",
      }),
      expect.objectContaining({
        identity: "same@market-b",
        installed: false,
        desiredEnabled: true,
        state: "desired-not-installed",
      }),
    ]));
    expect(normalized.virtualSources.map((source) => source.identity)).toEqual([
      "claude:live-binding:market-a",
      "claude:live-binding:market-b",
    ]);
  });

  it("never emits secret values or executable Claude semantics", () => {
    const root = makeTempDir();
    writeFixture(root);

    const normalized = parseClaudeCompatibilityBinding(fixtureBinding(root));
    const serialized = JSON.stringify(normalized);

    for (const forbidden of [
      "sk-live-secret-value",
      "curl secret.invalid",
      "secret-mcp",
      "secret-lsp",
      "secret-monitor",
      "secret-binary",
      "secret-script",
      "secret-session-start",
      "/not/authorized/or/read",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(normalized.warnings.map((warning) => warning.category)).toEqual(expect.arrayContaining([
      "secret",
      "hook",
      "mcp",
      "lsp",
      "monitor",
      "binary",
      "lifecycle",
      "session-start",
    ]));
    expect(normalized.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CLAUDE_COMPAT_BARE_OR_INVALID_PLUGIN_IDENTITY" }),
    ]));
  });

  it("refuses non-absolute, duplicate, broad, or unrecognized binding inputs", () => {
    expect(() => parseClaudeCompatibilityBinding({
      id: "bad",
      mode: "live",
      enabled: true,
      inputs: [{ role: "user-settings", path: ".claude/settings.json" }],
    })).toThrow(/absolute paths/i);
    expect(() => parseClaudeCompatibilityBinding({
      id: "bad",
      mode: "live",
      enabled: true,
      inputs: [{ role: "home", path: "/Users/example" }],
    })).toThrow(/unsupported.*role/i);
    expect(() => parseClaudeCompatibilityBinding({
      id: "bad",
      mode: "live",
      enabled: true,
      inputs: [{ role: "user-settings", path: "/tmp/settings.json", recursive: true }],
    })).toThrow(/role and path only/i);
  });
});

describe("Claude compatibility binding lifecycle", () => {
  function makeService(root: string, options: { now?: () => Date; graceMs?: number; debounceMs?: number } = {}) {
    const home = path.join(root, "hana-home");
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    const service = new ClaudeCompatibilityBindingService({
      hanakoHome: home,
      registry,
      ...options,
    });
    return { home, registry, service };
  }

  it("gives live, mirror, and snapshot distinct persistence and refresh behavior", () => {
    const root = makeTempDir();
    writeFixture(root);
    const { home, registry, service } = makeService(root);
    const bindings = [fixtureBinding(root, "live"), fixtureBinding(root, "mirror"), fixtureBinding(root, "snapshot")];
    registry.setClaudeCompatibilityBindings(bindings);

    const live = service.refresh("live-binding");
    const mirror = service.refresh("mirror-binding");
    const snapshot = service.refresh("snapshot-binding");
    expect(live.state?.desiredPlugins["same@market-a"]).toBe(true);
    expect(mirror.state?.desiredPlugins["same@market-a"]).toBe(true);
    expect(snapshot.state?.desiredPlugins["same@market-a"]).toBe(true);
    expect(fs.existsSync(path.join(home, "claude-compatibility", "live", "live-binding.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, "claude-compatibility", "mirror", "mirror-binding.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, "claude-compatibility", "snapshot", "snapshot-binding.json"))).toBe(true);

    writeJson(path.join(root, "project-local-settings.json"), { enabledPlugins: { "same@market-a": false } });
    expect(service.refresh("live-binding").state?.desiredPlugins["same@market-a"]).toBe(false);
    expect(service.refresh("mirror-binding").state?.desiredPlugins["same@market-a"]).toBe(false);
    expect(service.refresh("snapshot-binding").state?.desiredPlugins["same@market-a"]).toBe(true);
    expect(service.refresh("snapshot-binding", { forceSnapshot: true }).state?.desiredPlugins["same@market-a"]).toBe(false);
  });

  it("preserves last-known-good through malformed atomic replacement and reports after grace", () => {
    const root = makeTempDir();
    writeFixture(root);
    let now = new Date("2026-07-30T00:00:00.000Z");
    const { registry, service } = makeService(root, { now: () => now, graceMs: 500 });
    registry.setClaudeCompatibilityBindings([fixtureBinding(root)]);
    const first = service.refresh("live-binding");
    const firstDigest = first.state?.digest;

    fs.writeFileSync(path.join(root, "user-settings.json"), "{", "utf8");
    const grace = service.refresh("live-binding");
    expect(grace.state?.digest).toBe(firstDigest);
    expect(grace.lastKnownGood).toBe(true);
    expect(grace.diagnostic).toMatchObject({ graceExpired: false, code: "CLAUDE_COMPAT_INPUT_GRACE" });

    now = new Date("2026-07-30T00:00:01.000Z");
    const expired = service.refresh("live-binding");
    expect(expired.state?.digest).toBe(firstDigest);
    expect(expired.diagnostic).toMatchObject({ graceExpired: true, code: "CLAUDE_COMPAT_INPUT_INVALID" });

    writeJson(path.join(root, "user-settings.json"), { enabledPlugins: { "same@market-a": false } });
    const recovered = service.refresh("live-binding");
    expect(recovered.diagnostic).toBeNull();
    expect(recovered.state?.digest).not.toBe(firstDigest);
  });

  it("uses digest fallback and debounce without flapping duplicate updates", async () => {
    vi.useFakeTimers();
    const root = makeTempDir();
    writeFixture(root);
    const { registry, service } = makeService(root, { debounceMs: 50 });
    registry.setClaudeCompatibilityBindings([fixtureBinding(root)]);
    expect(service.refresh("live-binding").refreshCount).toBe(1);
    expect(service.pollLiveBindings()[0].refreshCount).toBe(1);

    writeJson(path.join(root, "project-local-settings.json"), { enabledPlugins: { "same@market-a": false } });
    service.scheduleRefresh("live-binding");
    service.scheduleRefresh("live-binding");
    service.scheduleRefresh("live-binding");
    await vi.advanceTimersByTimeAsync(60);
    expect(service.getStatus("live-binding").refreshCount).toBe(2);
  });

  it("requires owner confirmation and stale protection for mutations and source promotion without acquisition", () => {
    const root = makeTempDir();
    writeFixture(root);
    const { home, registry, service } = makeService(root);
    registry.setClaudeCompatibilityBindings([fixtureBinding(root)]);
    service.refresh("live-binding");

    const promotion = service.planMutation({
      action: "promote",
      bindingId: "live-binding",
      virtualSourceId: "market-a",
    });
    expect(() => service.executeMutation({
      action: "promote",
      bindingId: "live-binding",
      virtualSourceId: "market-a",
      planToken: promotion.planToken,
      isStudioOwner: false,
    })).toThrow(/studio\.owner/i);

    registry.setControlPlaneActivations({});
    expect(() => service.executeMutation({
      action: "promote",
      bindingId: "live-binding",
      virtualSourceId: "market-a",
      planToken: promotion.planToken,
      isStudioOwner: true,
    })).toThrow(/stale/i);

    const fresh = service.planMutation({
      action: "promote",
      bindingId: "live-binding",
      virtualSourceId: "market-a",
    });
    const promoted = service.executeMutation({
      action: "promote",
      bindingId: "live-binding",
      virtualSourceId: "market-a",
      planToken: fresh.planToken,
      isStudioOwner: true,
    }) as any;
    expect(promoted).toMatchObject({ promoted: true, virtualSourceId: "market-a" });
    expect(registry.listSources()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "market-a", kind: "git" }),
    ]));
    expect(fs.existsSync(path.join(home, "plugin-marketplace-snapshots", "market-a"))).toBe(false);
    expect(fs.existsSync(path.join(home, "plugins"))).toBe(false);
  });

  it("never fetches, installs, activates, or executes during binding lifecycle operations", () => {
    const root = makeTempDir();
    writeFixture(root);
    const { home, registry, service } = makeService(root);
    const binding = fixtureBinding(root, "mirror");
    const link = service.planMutation({ action: "link", binding });
    service.executeMutation({ action: "link", binding, planToken: link.planToken, isStudioOwner: true });
    for (const action of ["refresh", "disable", "remove"] as const) {
      const plan = service.planMutation({ action, bindingId: "mirror-binding" });
      service.executeMutation({ action, bindingId: "mirror-binding", planToken: plan.planToken, isStudioOwner: true });
      if (action === "remove") break;
    }
    expect(registry.listSources().map((source) => source.id)).toEqual(["oh-plugins-official"]);
    expect(fs.existsSync(path.join(home, "plugins"))).toBe(false);
    expect(fs.existsSync(path.join(home, "plugin-marketplace-snapshots"))).toBe(false);
  });

  it("strictly validates direct binding edits and preserves registry last-known-good state", () => {
    const root = makeTempDir();
    writeFixture(root);
    const home = path.join(root, "hana-home");
    const registryPath = path.join(home, "plugin-marketplaces.json");
    const valid = {
      schemaVersion: 2,
      revision: 1,
      sources: [],
      claudeCompatibility: { bindings: [fixtureBinding(root)] },
    };
    writeJson(registryPath, valid);
    const registry = new PluginMarketplaceSourceRegistry({ hanakoHome: home });
    expect(registry.getClaudeCompatibilityBindings()).toHaveLength(1);

    const invalid = {
      ...valid,
      revision: 2,
      claudeCompatibility: {
        bindings: [{ ...fixtureBinding(root), secretToken: "must-never-be-accepted" }],
      },
    };
    const diagnosis = diagnoseMarketplaceSourcesText(JSON.stringify(invalid), { path: registryPath });
    expect(diagnosis.ok).toBe(false);
    expect(diagnosis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PLUGIN_MARKETPLACE_CONFIG_STRICT_INVALID" }),
    ]));
    writeJson(registryPath, invalid);
    expect(registry.getStatus()).toMatchObject({ degraded: true, lastKnownGood: true, revision: 1 });
    expect(registry.getClaudeCompatibilityBindings()).toHaveLength(1);
  });
});

describe("Claude compatibility bridge envelope", () => {
  function bridgeFixture() {
    const root = makeTempDir();
    writeFixture(root);
    const state = parseClaudeCompatibilityBinding(fixtureBinding(root));
    return {
      version: CLAUDE_COMPATIBILITY_BRIDGE_VERSION,
      serverBindingId: "live-binding",
      serverId: "server-1",
      deviceId: "device-1",
      sessionId: "session-1",
      createdAt: "2026-07-30T00:00:00.000Z",
      state,
    };
  }

  it("accepts only versioned, exact, sanitized, session/device-scoped state", () => {
    const envelope = bridgeFixture();
    expect(validateClaudeCompatibilityBridgeEnvelope(envelope, {
      serverId: "server-1",
      serverBindingId: "live-binding",
      deviceId: "device-1",
      sessionId: "session-1",
    })).toMatchObject({ version: CLAUDE_COMPATIBILITY_BRIDGE_VERSION, serverId: "server-1" });

    expect(() => validateClaudeCompatibilityBridgeEnvelope({ ...envelope, version: "v0" }, {
      serverId: "server-1",
      serverBindingId: "live-binding",
    })).toThrow(/version mismatch/i);
    expect(() => validateClaudeCompatibilityBridgeEnvelope(envelope, {
      serverId: "server-2",
      serverBindingId: "live-binding",
    })).toThrow(/stale or different/i);
    expect(() => validateClaudeCompatibilityBridgeEnvelope({ ...envelope, unexpected: true }, {
      serverId: "server-1",
      serverBindingId: "live-binding",
    })).toThrow(/unrecognized/i);
    const nestedUnknown = structuredClone(envelope) as any;
    nestedUnknown.state.packages[0].command = "run-me";
    expect(() => validateClaudeCompatibilityBridgeEnvelope(nestedUnknown, {
      serverId: "server-1",
      serverBindingId: "live-binding",
    })).toThrow(/unrecognized/i);
    const secret = structuredClone(envelope) as any;
    secret.state.warnings[0].message = "token=sk-secret-bearing-value";
    expect(() => validateClaudeCompatibilityBridgeEnvelope(secret, {
      serverId: "server-1",
      serverBindingId: "live-binding",
    })).toThrow(/secret-bearing/i);
  });
});
