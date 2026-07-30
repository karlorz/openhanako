import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createPluginsRoute } from "../server/routes/plugins.ts";
import { PluginMarketplaceService } from "../lib/plugin-marketplace-service.ts";

const tempDirs: string[] = [];

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compat-route-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

function createEngine(home: string) {
  return {
    hanakoHome: home,
    pluginManager: { listPlugins: () => [], getRouteApp: () => null },
    pluginMarketplaceService: new PluginMarketplaceService({ hanakoHome: home, env: {} }),
    userSkillsDir: path.join(home, "skills"),
  } as any;
}

function appFor(engine: any, principal: any) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (principal) c.set("authPrincipal" as never, principal);
    await next();
  });
  app.route("/api", createPluginsRoute(engine));
  return app;
}

const localOwner = {
  kind: "local_user",
  connectionKind: "local",
  credentialKind: "loopback_token",
  scopes: ["studio.owner", "settings.write"],
};

const remoteOwner = {
  kind: "remote_user",
  connectionKind: "remote",
  role: "owner",
  scopes: ["studio.owner", "settings.write"],
};

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Claude compatibility marketplace routes", () => {
  it("requires owner planning/execution, keeps reads confirmation-free, and redacts remote paths", async () => {
    const home = makeHome();
    const settingsPath = path.join(home, "fixtures", "settings.json");
    writeJson(settingsPath, {
      enabledPlugins: { "demo@team-market": true },
      extraKnownMarketplaces: {
        "team-market": { source: { repo: "org/team-market" } },
      },
    });
    const engine = createEngine(home);
    const anonymousApp = appFor(engine, null);
    const forbidden = await anonymousApp.request("/api/plugins/marketplace/compatibility/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh", bindingId: "claude-live" }),
    });
    expect(forbidden.status).toBe(403);

    const ownerApp = appFor(engine, localOwner);
    const binding = {
      id: "claude-live",
      mode: "live",
      enabled: true,
      inputs: [{ role: "user-settings", path: settingsPath }],
    };
    const planned = await ownerApp.request("/api/plugins/marketplace/compatibility/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "link", binding }),
    });
    expect(planned.status).toBe(200);
    const planBody = await planned.json() as any;

    const executed = await ownerApp.request("/api/plugins/marketplace/compatibility/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "link", binding, planToken: planBody.plan.planToken }),
    });
    expect(executed.status).toBe(200);
    expect(await executed.json()).toMatchObject({
      result: { binding: { id: "claude-live", mode: "live" } },
    });

    const read = await anonymousApp.request("/api/plugins/marketplace/compatibility/bindings");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ bindings: [{ binding: { id: "claude-live" } }] });

    const remoteRead = await appFor(engine, remoteOwner).request("/api/plugins/marketplace/compatibility/bindings");
    const remoteBody = await remoteRead.json() as any;
    expect(remoteBody.bindings[0].binding.inputs[0].path).toBe("[server-local path redacted]");
    expect(remoteBody.bindings[0].state.provenance[0].path).toBe("[server-local path redacted]");

    const remoteConfig = await appFor(engine, remoteOwner).request("/api/plugins/marketplace/config");
    const remoteConfigBody = await remoteConfig.json() as any;
    expect(remoteConfigBody.configDiagnostics.file.claudeCompatibility.bindings[0].inputs[0].path)
      .toBe("[server-local path redacted]");

    const localConfig = await ownerApp.request("/api/plugins/marketplace/config");
    const localConfigBody = await localConfig.json() as any;
    expect(localConfigBody.configDiagnostics.file.claudeCompatibility.bindings[0].inputs[0].path)
      .toBe(settingsPath);
  });

  it("validates a bridge foundation without source promotion, fetch, install, or activation", async () => {
    const home = makeHome();
    const settingsPath = path.join(home, "fixtures", "settings.json");
    writeJson(settingsPath, { enabledPlugins: { "demo@team-market": true } });
    const engine = createEngine(home);
    const svc = engine.pluginMarketplaceService as PluginMarketplaceService;
    svc.registry.setClaudeCompatibilityBindings([{
      id: "claude-live",
      mode: "live",
      enabled: true,
      inputs: [{ role: "user-settings", path: settingsPath }],
    }]);
    const state = svc.refreshClaudeCompatibilityBinding("claude-live").state;
    const installSpy = vi.spyOn(svc, "installClaudePluginSkills");
    const activationSpy = vi.spyOn(svc, "setControlPlaneActivations");
    const addSourceSpy = vi.spyOn(svc.registry, "addSource");

    const response = await appFor(engine, localOwner).request("/api/plugins/marketplace/compatibility/bridge/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId: "server-1",
        bindingId: "claude-live",
        deviceId: "device-1",
        sessionId: "session-1",
        envelope: {
          version: "claude-compatibility-bridge.v1",
          serverBindingId: "claude-live",
          serverId: "server-1",
          deviceId: "device-1",
          sessionId: "session-1",
          createdAt: "2026-07-30T00:00:00.000Z",
          state,
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(installSpy).not.toHaveBeenCalled();
    expect(activationSpy).not.toHaveBeenCalled();
    expect(addSourceSpy).not.toHaveBeenCalled();
  });
});
