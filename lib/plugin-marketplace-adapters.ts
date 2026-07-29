import fs from "fs";
import { buildSourceFingerprint } from "./plugin-marketplace-identity.ts";
import { parseMarketplaceCatalogStrict } from "./plugin-marketplace-schema.ts";
import {
  MarketplaceSnapshotStore,
  type MarketplaceSnapshot,
} from "./plugin-marketplace-snapshots.ts";
import { safeFetchText, type SafeFetchOptions } from "./plugin-marketplace-network-policy.ts";
import {
  assertContainedRegularFile,
  resolveContainedPath,
} from "./plugin-marketplace-path-policy.ts";
import type { MarketplaceSourceDescriptor } from "./plugin-marketplace-sources.ts";

export interface AcquireSnapshotOptions {
  store: MarketplaceSnapshotStore;
  fetchOptions?: SafeFetchOptions;
  /** Required for local sources: allowed root directory on the server. */
  localAllowedRoot?: string;
}

/**
 * Acquire, strictly validate, and publish a snapshot for a URL or local source.
 * Git acquisition is Task 6 (P1b).
 */
export async function acquireAndPublishSourceSnapshot(
  source: MarketplaceSourceDescriptor,
  options: AcquireSnapshotOptions,
): Promise<MarketplaceSnapshot> {
  options.store.markRefreshing(source.id);
  try {
    let rawText: string;
    let sourceKind: "url" | "local";
    let fingerprintInput: Parameters<typeof buildSourceFingerprint>[0];

    if (source.kind === "url") {
      sourceKind = "url";
      rawText = await safeFetchText(source.url, options.fetchOptions);
      fingerprintInput = { kind: "url", id: source.id, url: source.url };
    } else if (source.kind === "local") {
      sourceKind = "local";
      if (!options.localAllowedRoot) {
        throw new Error("Local marketplace acquisition requires localAllowedRoot");
      }
      const sourceDir = resolveContainedPath({
        rootDir: options.localAllowedRoot,
        candidatePath: source.path,
        allowAbsolute: true,
      });
      const indexPath = source.indexPath || "marketplace.json";
      const filePath = assertContainedRegularFile({
        rootDir: sourceDir,
        candidatePath: indexPath,
      });
      rawText = fs.readFileSync(filePath, "utf8");
      fingerprintInput = {
        kind: "local",
        id: source.id,
        path: source.path,
        indexPath: source.indexPath,
      };
    } else {
      throw new Error(`Unsupported source kind for P1a adapters: ${(source as any).kind}`);
    }

    const parsed = parseMarketplaceCatalogStrict(rawText, {
      marketplaceId: source.id,
      sourceKind,
    });
    const snapshot: MarketplaceSnapshot = {
      sourceId: source.id,
      sourceFingerprint: buildSourceFingerprint(fingerprintInput),
      catalogSha256: parsed.catalogSha256,
      fetchedAt: new Date().toISOString(),
      plugins: parsed.plugins,
    };
    return options.store.publish(source.id, snapshot);
  } catch (err) {
    options.store.markError(source.id, {
      code: (err as any)?.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
