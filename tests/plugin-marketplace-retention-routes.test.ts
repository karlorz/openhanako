import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createPluginsRoute } from "../server/routes/plugins.ts";
import { PluginMarketplaceService } from "../lib/plugin-marketplace-service.ts";
import { PluginTrustStore } from "../lib/plugin-trust-store.ts";
import { writeMarketplaceActiveMarker } from "../lib/plugin-marketplace-active-marker.ts";

const tempDirs: string[] = [];

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-marketplace-retention-"));
  tempDirs.push(home);
  return home;
}

function writeFile(filePath: string, content = "state") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createEngine(home: string) {
  const pluginsDir = path.join(home, "plugins");
  const service = new PluginMarketplaceService({ hanakoHome: home, env: {} });
  return {
    hanakoHome: home,
    pluginMarketplaceService: service,
    pluginManager: {
      listPlugins: () => [],
      getRouteApp: () => null,
      getUserPluginsDir: () => pluginsDir,
      findPluginEntry({ id }: { id: string }) {
        const pluginDir = path.join(pluginsDir, id);
        return fs.existsSync(pluginDir) ? { id, pluginDir, source: "community" } : null;
      },
    },
  } as any;
}

function appFor(engine: any, owner = true) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (owner) {
      c.set("authPrincipal" as never, {
        kind: "local_user",
        connectionKind: "local",
        credentialKind: "loopback_token",
        scopes: ["studio.owner"],
      });
    }
    await next();
  });
  app.route("/api", createPluginsRoute(engine));
  return app;
}

function retainAndActivate(
  service: PluginMarketplaceService,
  home: string,
  marketplaceId: string,
  pluginId: string,
  artifactDigest: string,
) {
  const packageDir = path.join(home, "packages", marketplaceId, artifactDigest);
  writeFile(path.join(packageDir, "manifest.json"), JSON.stringify({ id: pluginId, version: "1.0.0" }));
  const artifact = service.artifacts.retain({
    marketplaceId,
    pluginId,
    artifactDigest,
    version: "1.0.0",
    sourceFingerprint: "c".repeat(64),
    catalogSha256: "d".repeat(64),
    packageSha256: artifactDigest,
    packageDir,
  });
  service.records.retainAndActivate({
    pluginId,
    marketplaceId,
    artifactDigest,
    version: "1.0.0",
    sourceFingerprint: "c".repeat(64),
    catalogSha256: "d".repeat(64),
    packageSha256: artifactDigest,
    artifactPath: artifact.artifactPath,
    action: "install",
    result: "ok",
  });
  return artifact;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Marketplace retained artifact and source-state deletion", () => {
  it("deletes one exact inactive artifact while preserving source state and other identities", async () => {
    const home = makeHome();
    const engine = createEngine(home);
    const service = engine.pluginMarketplaceService as PluginMarketplaceService;
    const pluginId = "demo-plugin";
    const inactiveDigest = "a".repeat(64);
    const activeDigest = "b".repeat(64);
    retainAndActivate(service, home, "team-b", pluginId, inactiveDigest);
    retainAndActivate(service, home, "team-a", pluginId, activeDigest);
    const trust = new PluginTrustStore({ hanakoHome: home });
    trust.grant({ marketplaceId: "team-b", pluginId, artifactDigest: inactiveDigest });
    trust.grant({ marketplaceId: "team-a", pluginId, artifactDigest: activeDigest });
    const inactiveState = path.join(home, "plugin-data", "team-b", pluginId, "config.json");
    writeFile(inactiveState, "retained state");

    const response = await appFor(engine).request(
      `/api/plugins/${pluginId}/artifacts/team-b/${inactiveDigest}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      pluginId,
      marketplaceId: "team-b",
      artifactDigest: inactiveDigest,
      recordRemoved: true,
      artifactRemoved: true,
      trustRevoked: true,
      statePreserved: true,
    });
    expect(service.records.get(pluginId)?.retained["team-b"]).toBeUndefined();
    expect(service.records.get(pluginId)?.retained["team-a"]?.[activeDigest]).toBeTruthy();
    expect(service.artifacts.get("team-b", pluginId, inactiveDigest)).toBeNull();
    expect(service.artifacts.get("team-a", pluginId, activeDigest)).toBeTruthy();
    expect(trust.getGrant("team-b", pluginId, inactiveDigest)).toBeNull();
    expect(trust.getGrant("team-a", pluginId, activeDigest)).toBeTruthy();
    expect(fs.readFileSync(inactiveState, "utf8")).toBe("retained state");

    const activeResponse = await appFor(engine).request(
      `/api/plugins/${pluginId}/artifacts/team-a/${activeDigest}`,
      { method: "DELETE" },
    );
    expect(activeResponse.status).toBe(409);
    expect(await activeResponse.json()).toMatchObject({ code: "PLUGIN_MARKETPLACE_ARTIFACT_ACTIVE" });
    expect(service.artifacts.get("team-a", pluginId, activeDigest)).toBeTruthy();
  });

  it("purges only confirmed inactive source state and matching trust grants", async () => {
    const home = makeHome();
    const engine = createEngine(home);
    const service = engine.pluginMarketplaceService as PluginMarketplaceService;
    const pluginId = "demo-plugin";
    const inactiveDigest = "a".repeat(64);
    const secondInactiveDigest = "e".repeat(64);
    const activeDigest = "b".repeat(64);
    retainAndActivate(service, home, "team-b", pluginId, inactiveDigest);
    retainAndActivate(service, home, "team-a", pluginId, activeDigest);
    const recordBefore = service.records.get(pluginId);
    const trust = new PluginTrustStore({ hanakoHome: home });
    trust.grant({ marketplaceId: "team-b", pluginId, artifactDigest: inactiveDigest });
    trust.grant({ marketplaceId: "team-b", pluginId, artifactDigest: secondInactiveDigest });
    trust.grant({ marketplaceId: "team-a", pluginId, artifactDigest: activeDigest });

    for (const root of ["plugin-data", "plugin-secrets", "plugin-backups"]) {
      writeFile(path.join(home, root, "team-b", pluginId, "state.txt"), "inactive");
      writeFile(path.join(home, root, "team-a", pluginId, "state.txt"), "active");
    }
    const legacyData = path.join(home, "plugin-data", pluginId, "legacy.txt");
    const legacyBackup = path.join(home, "plugin-backups", pluginId, "legacy.txt");
    writeFile(legacyData, "legacy");
    writeFile(legacyBackup, "legacy");

    const mismatch = await appFor(engine).request(`/api/plugins/${pluginId}/state/team-b`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: `${pluginId}@team-b` }),
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ code: "PLUGIN_MARKETPLACE_CONFIRMATION_MISMATCH" });

    const response = await appFor(engine).request(`/api/plugins/${pluginId}/state/team-b`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: `${pluginId}@team-b state purge` }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      pluginId,
      marketplaceId: "team-b",
      deleted: { data: true, secrets: true, backups: true },
      trustGrantsRevoked: 2,
      artifactsPreserved: true,
      installHistoryPreserved: true,
      legacyStatePreserved: true,
    });
    for (const root of ["plugin-data", "plugin-secrets", "plugin-backups"]) {
      expect(fs.existsSync(path.join(home, root, "team-b", pluginId))).toBe(false);
      expect(fs.existsSync(path.join(home, root, "team-a", pluginId, "state.txt"))).toBe(true);
    }
    expect(fs.readFileSync(legacyData, "utf8")).toBe("legacy");
    expect(fs.readFileSync(legacyBackup, "utf8")).toBe("legacy");
    expect(service.artifacts.get("team-b", pluginId, inactiveDigest)).toBeTruthy();
    expect(service.records.get(pluginId)).toEqual(recordBefore);
    expect(trust.getGrant("team-b", pluginId, inactiveDigest)).toBeNull();
    expect(trust.getGrant("team-b", pluginId, secondInactiveDigest)).toBeNull();
    expect(trust.getGrant("team-a", pluginId, activeDigest)).toBeTruthy();

    const repeated = await appFor(engine).request(`/api/plugins/${pluginId}/state/team-b`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: `${pluginId}@team-b state purge` }),
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({
      deleted: { data: false, secrets: false, backups: false },
      trustGrantsRevoked: 0,
    });
  });

  it("rejects active marker state, unsafe symlink paths, malformed identities, and non-owners", async () => {
    const home = makeHome();
    const engine = createEngine(home);
    const pluginId = "demo-plugin";
    const markerDir = path.join(home, "plugins", pluginId);
    writeMarketplaceActiveMarker(markerDir, {
      marketplaceId: "team-b",
      pluginId,
      artifactDigest: "a".repeat(64),
    });

    const active = await appFor(engine).request(`/api/plugins/${pluginId}/state/team-b`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: `${pluginId}@team-b state purge` }),
    });
    expect(active.status).toBe(409);
    expect(await active.json()).toMatchObject({ code: "PLUGIN_MARKETPLACE_STATE_ACTIVE" });

    fs.rmSync(markerDir, { recursive: true, force: true });
    if (process.platform !== "win32") {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hana-marketplace-state-outside-"));
      tempDirs.push(outside);
      writeFile(path.join(outside, pluginId, "state.txt"), "outside");
      fs.mkdirSync(path.join(home, "plugin-data"), { recursive: true });
      fs.symlinkSync(outside, path.join(home, "plugin-data", "team-b"), "dir");
      const unsafe = await appFor(engine).request(`/api/plugins/${pluginId}/state/team-b`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: `${pluginId}@team-b state purge` }),
      });
      expect(unsafe.status).toBe(409);
      expect(await unsafe.json()).toMatchObject({ code: "PLUGIN_MARKETPLACE_STATE_PATH_UNSAFE" });
      expect(fs.readFileSync(path.join(outside, pluginId, "state.txt"), "utf8")).toBe("outside");
    }

    const malformed = await appFor(engine).request(`/api/plugins/${pluginId}/state/bad:source`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: `${pluginId}@bad:source state purge` }),
    });
    expect(malformed.status).toBe(400);

    const forbiddenState = await appFor(engine, false).request(`/api/plugins/${pluginId}/state/team-b`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: `${pluginId}@team-b state purge` }),
    });
    expect(forbiddenState.status).toBe(403);
    const forbiddenArtifact = await appFor(engine, false).request(
      `/api/plugins/${pluginId}/artifacts/team-b/${"a".repeat(64)}`,
      { method: "DELETE" },
    );
    expect(forbiddenArtifact.status).toBe(403);
  });
});
