import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginMarketplaceNativeLifecycle } from "../lib/plugin-marketplace-native-lifecycle.ts";
import { PluginTrustStore } from "../lib/plugin-trust-store.ts";

const homes: string[] = [];

function makeHarness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-native-lifecycle-"));
  homes.push(home);
  const digest = "a".repeat(64);
  const active = { marketplaceId: null as string | null, digest: null as string | null };
  const registry = { revision: 7, digest: "b".repeat(64) };
  const plugin = {
    id: "native-page",
    marketplaceId: "official",
    name: "Native Page",
    version: "1.2.3",
    trust: "full-access",
    contributions: ["tools", "routes"],
    distribution: { kind: "release", packageUrl: "https://example.com/native.zip", sha256: digest },
  };
  const service: any = {
    assertRegistryWritePrecondition: vi.fn(({ expectedRevision, expectedDigest }) => {
      if (expectedRevision !== registry.revision || expectedDigest !== registry.digest) {
        const err: any = new Error("stale registry"); err.status = 409; throw err;
      }
    }),
    assertRegistryUsableForAcquisition: vi.fn(),
    getCatalogPlugin: vi.fn((pluginId: string, marketplaceId: string) => ({ ...plugin, id: pluginId, marketplaceId })),
    getRegistryStatus: vi.fn(() => ({ ...registry, degraded: false })),
    snapshots: { getStatus: vi.fn(() => ({ state: "ok", current: {
      catalogSha256: "c".repeat(64),
      sourceFingerprint: "d".repeat(64),
      resolvedRevision: "rev-1",
    } })) },
    records: { get: vi.fn(() => ({ activeMarketplaceId: active.marketplaceId, activeArtifactDigest: active.digest, retained: retainedByMarket })) },
    artifacts: { get: vi.fn((_marketplaceId: string, _pluginId: string, artifactDigest: string) => artifactsByDigest[artifactDigest] || null) },
  };
  const retainedByMarket: Record<string, Record<string, any>> = {};
  const artifactsByDigest: Record<string, { artifactPath: string }> = {};
  const trustStore = new PluginTrustStore({ hanakoHome: home });
  const lifecycle = new PluginMarketplaceNativeLifecycle({ service, trustStore, secret: "test-secret" });
  const seedRetained = (marketplaceId: string, artifactDigest: string, overrides: Record<string, unknown> = {}) => {
    const dir = path.join(home, "artifacts", artifactDigest);
    fs.mkdirSync(dir, { recursive: true });
    artifactsByDigest[artifactDigest] = { artifactPath: dir };
    retainedByMarket[marketplaceId] = retainedByMarket[marketplaceId] || {};
    retainedByMarket[marketplaceId][artifactDigest] = {
      marketplaceId,
      artifactDigest,
      version: "1.2.3",
      packageSha256: artifactDigest,
      retainedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  };
  return { lifecycle, trustStore, registry, active, digest, seedRetained, artifactsByDigest };
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("PluginMarketplaceNativeLifecycle", () => {
  it("requires studio.owner and binds execute to exact registry/catalog facts and typed identity", async () => {
    const { lifecycle, trustStore, registry, digest } = makeHarness();
    expect(() => lifecycle.planInstall({
      pluginId: "native-page",
      marketplaceId: "official",
      isStudioOwner: false,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    })).toThrow(/studio.owner/i);

    const plan = lifecycle.planInstall({
      pluginId: "native-page",
      marketplaceId: "official",
      isStudioOwner: true,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    });
    expect(plan.confirmationText).toBe("native-page@official");
    await expect(lifecycle.executeInstall({
      planToken: plan.planToken,
      confirmation: "wrong@official",
      isStudioOwner: true,
    }, async () => ({ ok: true }))).rejects.toThrow(/confirmation/i);

    const fresh = lifecycle.planInstall({
      pluginId: "native-page",
      marketplaceId: "official",
      isStudioOwner: true,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    });
    const outcome = await lifecycle.executeInstall({
      planToken: fresh.planToken,
      confirmation: fresh.confirmationText,
      isStudioOwner: true,
    }, async () => ({ status: "restricted" }));
    expect(outcome.result).toEqual({ status: "restricted" });
    expect(trustStore.getGrant("official", "native-page", digest)).not.toBeNull();
    await expect(lifecycle.executeInstall({
      planToken: fresh.planToken,
      confirmation: fresh.confirmationText,
      isStudioOwner: true,
    }, async () => ({ ok: true }))).rejects.toThrow(/already used/i);
  });

  it("requires an exact active pointer for uninstall and revokes only the active artifact grant", async () => {
    const { lifecycle, trustStore, registry, active, digest } = makeHarness();
    expect(() => lifecycle.planUninstall({
      pluginId: "native-page",
      marketplaceId: "official",
      isStudioOwner: true,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    })).toThrow(/not actively installed/i);

    active.marketplaceId = "official";
    active.digest = digest;
    trustStore.grant({ marketplaceId: "official", pluginId: "native-page", artifactDigest: digest });
    const plan = lifecycle.planUninstall({
      pluginId: "native-page",
      marketplaceId: "official",
      isStudioOwner: true,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    });
    await lifecycle.executeUninstall({
      planToken: plan.planToken,
      confirmation: plan.confirmationText,
      isStudioOwner: true,
    }, async () => ({ installed: false, retained: true }));
    expect(trustStore.getGrant("official", "native-page", digest)).toBeNull();
  });

  it("plans and executes a source switch against a retained artifact (finding 4)", async () => {
    const { lifecycle, registry, seedRetained } = makeHarness();
    const retainedDigest = "e".repeat(64);
    seedRetained("marketplace-b", retainedDigest, { lastActivatedAt: "2026-02-01T00:00:00.000Z" });

    const plan = lifecycle.planSourceSwitch({
      pluginId: "my-plugin",
      marketplaceId: "marketplace-b",
      isStudioOwner: true,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    });
    expect(plan.action).toBe("source-switch");
    expect(plan.confirmationText).toContain("source switch");
    expect(plan.facts.artifactDigest).toBe(retainedDigest);

    const executed = await lifecycle.executeSourceSwitch(
      { planToken: plan.planToken, confirmation: plan.confirmationText, isStudioOwner: true },
      async (facts) => ({ facts }),
    );
    expect(executed.plan.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(executed.result).toEqual({ facts: executed.plan });
  });

  it("rejects a source-switch plan for a missing retained artifact", () => {
    const { lifecycle, registry } = makeHarness();
    expect(() => lifecycle.planSourceSwitch({
      pluginId: "my-plugin",
      marketplaceId: "marketplace-b",
      isStudioOwner: true,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    })).toThrow(/not retained|No retained artifact/i);

    const second = makeHarness();
    const digest2 = "e".repeat(64);
    second.seedRetained("marketplace-b", digest2);
    fs.rmSync(second.artifactsByDigest[digest2].artifactPath, { recursive: true, force: true });
    expect(() => second.lifecycle.planSourceSwitch({
      pluginId: "my-plugin",
      marketplaceId: "marketplace-b",
      isStudioOwner: true,
      expectedRevision: second.registry.revision,
      expectedDigest: second.registry.digest,
    })).toThrow(/missing on disk/i);
  });

  it("rejects source-switch execute without owner or with a consumed plan token", async () => {
    const { lifecycle, registry, seedRetained } = makeHarness();
    seedRetained("marketplace-b", "e".repeat(64));
    expect(() => lifecycle.planSourceSwitch({
      pluginId: "my-plugin",
      marketplaceId: "marketplace-b",
      isStudioOwner: false,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    })).toThrow(/studio.owner/i);

    const plan = lifecycle.planSourceSwitch({
      pluginId: "my-plugin",
      marketplaceId: "marketplace-b",
      isStudioOwner: true,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    });
    await lifecycle.executeSourceSwitch({
      planToken: plan.planToken,
      confirmation: plan.confirmationText,
      isStudioOwner: true,
    }, async () => ({ ok: true }));
    await expect(lifecycle.executeSourceSwitch({
      planToken: plan.planToken,
      confirmation: plan.confirmationText,
      isStudioOwner: true,
    }, async () => ({ ok: true }))).rejects.toThrow(/already used/i);

    const second = lifecycle.planSourceSwitch({
      pluginId: "my-plugin",
      marketplaceId: "marketplace-b",
      isStudioOwner: true,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    });
    await expect(lifecycle.executeSourceSwitch({
      planToken: second.planToken,
      confirmation: second.confirmationText,
      isStudioOwner: false,
    }, async () => ({ ok: true }))).rejects.toThrow(/studio.owner/i);
  });

  it("executes a source-switch plan naming an explicit retained digest and defaults to the latest otherwise", async () => {
    const { lifecycle, registry, seedRetained } = makeHarness();
    const older = "d".repeat(64);
    const latest = "e".repeat(64);
    seedRetained("marketplace-b", older, { lastActivatedAt: "2026-01-01T00:00:00.000Z" });
    seedRetained("marketplace-b", latest, { lastActivatedAt: "2026-03-01T00:00:00.000Z" });

    expect(() => lifecycle.planSourceSwitch({
      pluginId: "my-plugin",
      marketplaceId: "marketplace-b",
      artifactDigest: "f".repeat(64),
      isStudioOwner: true,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    })).toThrow(/not retained/i);

    const latestPlan = lifecycle.planSourceSwitch({
      pluginId: "my-plugin",
      marketplaceId: "marketplace-b",
      isStudioOwner: true,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    });
    expect(latestPlan.facts.artifactDigest).toBe(latest);

    const explicitPlan = lifecycle.planSourceSwitch({
      pluginId: "my-plugin",
      marketplaceId: "marketplace-b",
      artifactDigest: older,
      isStudioOwner: true,
      expectedRevision: registry.revision,
      expectedDigest: registry.digest,
    });
    expect(explicitPlan.facts.artifactDigest).toBe(older);
    const executed = await lifecycle.executeSourceSwitch({
      planToken: explicitPlan.planToken,
      confirmation: explicitPlan.confirmationText,
      isStudioOwner: true,
    }, async (facts) => ({ switched: facts.artifactDigest }));
    expect(executed.result).toEqual({ switched: older });
  });
});

