import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createPluginsRoute } from "../server/routes/plugins.ts";

const tempDirs: string[] = [];
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mkt-auth-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function createEngine(hanakoHome: string) {
  return {
    hanakoHome,
    pluginManager: {
      listPlugins: () => [],
      getRouteApp: () => null,
    },
    pluginMarketplace: null,
    pluginMarketplaceService: null,
    userSkillsDir: path.join(hanakoHome, "skills"),
    fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [] }), { status: 200 }),
  } as any;
}

function createAppWithPrincipal(engine: any, principal: any) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (principal) (c as any).set("authPrincipal", principal);
    await next();
  });
  app.route("/api", createPluginsRoute(engine));
  return app;
}

const localOwner = Object.freeze({
  kind: "local_user",
  connectionKind: "local",
  credentialKind: "loopback_token",
  scopes: ["settings.write", "studio.owner"],
});

describe("marketplace sources auth principal", () => {
  it("rejects source add when authPrincipal is missing (old requestPrincipal bug path)", async () => {
    const home = makeHome();
    const app = createAppWithPrincipal(createEngine(home), null);
    const res = await app.request("/api/plugins/marketplace/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "llm-wiki",
        name: "llm-wiki",
        kind: "url",
        url: "https://example.com/marketplace.json",
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN");
    expect(String(body.error)).toMatch(/studio\.owner/i);
  });

  it("allows source add when authPrincipal is local_user loopback (desktop local)", async () => {
    const home = makeHome();
    const catalog = {
      schemaVersion: 1,
      plugins: [{
        schemaVersion: 1,
        id: "demo",
        name: "Demo",
        publisher: "T",
        version: "1.0.0",
        description: "d",
        repository: "https://example.com/r",
        compatibility: {},
        trust: "restricted",
        permissions: [],
        contributions: [],
        distribution: {
          kind: "release",
          packageUrl: "https://example.com/d.zip",
          sha256: "a".repeat(64),
        },
      }],
    };
    const engine = createEngine(home);
    engine.fetch = async () => new Response(JSON.stringify(catalog), { status: 200 });
    // DNS pin for safeFetch
    const app = createAppWithPrincipal(engine, localOwner);

    // Inject fetchOptions via service by monkeypatching after route creates service —
    // set env so PluginMarketplaceService uses global fetch we control is hard;
    // instead pass pluginMarketplaceService prebuilt.
    const { PluginMarketplaceService } = await import("../lib/plugin-marketplace-service.ts");
    engine.pluginMarketplaceService = new PluginMarketplaceService({
      hanakoHome: home,
      env: {},
      fetchOptions: {
        fetchImpl: async () => new Response(JSON.stringify(catalog), { status: 200 }),
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    });

    const res = await app.request("/api/plugins/marketplace/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "team-plugins",
        name: "Team",
        kind: "url",
        url: "https://example.com/marketplace.json",
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.error).toBeUndefined();
  });
});
