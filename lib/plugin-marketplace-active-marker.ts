import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import {
  assertArtifactDigest,
  assertMarketplaceId,
  assertPluginId,
} from "./plugin-marketplace-identity.ts";

export const MARKETPLACE_ACTIVE_MARKER = ".hana-marketplace.json";

export interface MarketplaceActiveMarker {
  schemaVersion: 1;
  marketplaceId: string;
  pluginId: string;
  artifactDigest: string;
}

export function writeMarketplaceActiveMarker(
  pluginDir: string,
  input: Omit<MarketplaceActiveMarker, "schemaVersion">,
): MarketplaceActiveMarker {
  const marker: MarketplaceActiveMarker = {
    schemaVersion: 1,
    marketplaceId: assertMarketplaceId(input.marketplaceId),
    pluginId: assertPluginId(input.pluginId),
    artifactDigest: assertArtifactDigest(input.artifactDigest),
  };
  fs.mkdirSync(pluginDir, { recursive: true });
  atomicWriteSync(path.join(pluginDir, MARKETPLACE_ACTIVE_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

export function readMarketplaceActiveMarker(pluginDir: string, expectedPluginId?: string): MarketplaceActiveMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(pluginDir, MARKETPLACE_ACTIVE_MARKER), "utf8"));
    if (raw?.schemaVersion !== 1) return null;
    const marker: MarketplaceActiveMarker = {
      schemaVersion: 1,
      marketplaceId: assertMarketplaceId(raw.marketplaceId),
      pluginId: assertPluginId(raw.pluginId),
      artifactDigest: assertArtifactDigest(raw.artifactDigest),
    };
    if (expectedPluginId && marker.pluginId !== expectedPluginId) return null;
    return marker;
  } catch {
    return null;
  }
}
