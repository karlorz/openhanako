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
    getCatalogPlugin: vi.fn(() => plugin),
    getRegistryStatus: vi.fn(() => ({ ...registry, degraded: false })),
    snapshots: { getStatus: vi.fn(() => ({ state: "ok", current: {
      catalogSha256: "c".repeat(64),
      sourceFingerprint: "d".repeat(64),
      resolvedRevision: "rev-1",
    } })) },
    records: { get: vi.fn(() => ({ activeMarketplaceId: active.marketplaceId, activeArtifactDigest: active.digest })) },
    artifacts: { get: vi.fn(() => null) },
  };
  const trustStore = new PluginTrustStore({ hanakoHome: home });
  const lifecycle = new PluginMarketplaceNativeLifecycle({ service, trustStore, secret: "test-secret" });
  return { lifecycle, trustStore, registry, active, digest };
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
});

