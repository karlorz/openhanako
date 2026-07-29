import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PluginTrustStore,
  marketplacePluginDataDir,
  marketplacePluginKey,
} from "../lib/plugin-trust-store.ts";
import { createPluginConfigStore, normalizePluginConfigSchema } from "../core/plugin-config.ts";

const tempDirs: string[] = [];
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-trust-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

describe("PluginTrustStore", () => {
  it("does not inherit full-access across marketplaces or digests", () => {
    const home = makeHome();
    const store = new PluginTrustStore({ hanakoHome: home });
    store.grant({
      marketplaceId: "oh-plugins-official",
      pluginId: "demo",
      artifactDigest: DIGEST_A,
      privilegedDefinitionHashes: ["def1"],
      grantedCapabilities: ["full-access"],
    });

    expect(store.isFullAccessAllowed({
      marketplaceId: "oh-plugins-official",
      pluginId: "demo",
      artifactDigest: DIGEST_A,
      privilegedDefinitionHashes: ["def1"],
      globalFullAccessEnabled: true,
    })).toBe(true);

    // Same pluginId, other marketplace
    expect(store.isFullAccessAllowed({
      marketplaceId: "team-plugins",
      pluginId: "demo",
      artifactDigest: DIGEST_A,
      privilegedDefinitionHashes: ["def1"],
      globalFullAccessEnabled: true,
    })).toBe(false);

    // Same marketplace, changed digest
    expect(store.isFullAccessAllowed({
      marketplaceId: "oh-plugins-official",
      pluginId: "demo",
      artifactDigest: DIGEST_B,
      privilegedDefinitionHashes: ["def1"],
      globalFullAccessEnabled: true,
    })).toBe(false);

    // Changed definition hash
    expect(store.isFullAccessAllowed({
      marketplaceId: "oh-plugins-official",
      pluginId: "demo",
      artifactDigest: DIGEST_A,
      privilegedDefinitionHashes: ["def2"],
      globalFullAccessEnabled: true,
    })).toBe(false);

    // Global ceiling off
    expect(store.isFullAccessAllowed({
      marketplaceId: "oh-plugins-official",
      pluginId: "demo",
      artifactDigest: DIGEST_A,
      privilegedDefinitionHashes: ["def1"],
      globalFullAccessEnabled: false,
    })).toBe(false);
  });

  it("isolates source-qualified data and config paths", () => {
    const home = makeHome();
    const root = path.join(home, "plugin-data");
    const aDir = marketplacePluginDataDir(root, "oh-plugins-official", "demo");
    const bDir = marketplacePluginDataDir(root, "team-plugins", "demo");
    expect(aDir).not.toBe(bDir);
    expect(marketplacePluginKey("oh-plugins-official", "demo")).toBe("oh-plugins-official:demo");
    expect(marketplacePluginKey("team-plugins", "demo")).toBe("team-plugins:demo");

    const schema = normalizePluginConfigSchema("demo", {
      properties: {
        theme: { type: "string" },
      },
    });
    const storeA = createPluginConfigStore({ dataDir: aDir, schema });
    const storeB = createPluginConfigStore({ dataDir: bDir, schema });
    storeA.set("theme", "dark", { scope: "global" });
    storeB.set("theme", "light", { scope: "global" });

    expect(storeA.get("theme", { scope: "global" })).toBe("dark");
    expect(storeB.get("theme", { scope: "global" })).toBe("light");
    expect(fs.existsSync(path.join(aDir, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(bDir, "config.json"))).toBe(true);
  });
});
