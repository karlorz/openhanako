import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import {
  assertArtifactDigest,
  assertMarketplaceId,
  assertPluginId,
  buildPluginArtifactKey,
} from "./plugin-marketplace-identity.ts";

export const PLUGIN_TRUST_FILENAME = "plugin-trust.json";

export interface PluginTrustGrant {
  marketplaceId: string;
  pluginId: string;
  artifactDigest: string;
  privilegedDefinitionHashes: string[];
  grantedCapabilities: string[];
  grantedAt: string;
}

interface TrustFile {
  schemaVersion: 1;
  grants: Record<string, PluginTrustGrant>;
}

function emptyFile(): TrustFile {
  return { schemaVersion: 1, grants: {} };
}

export class PluginTrustStore {
  declare _path: string;

  constructor({ hanakoHome }: { hanakoHome: string }) {
    if (!hanakoHome) throw new Error("PluginTrustStore requires hanakoHome");
    this._path = path.join(hanakoHome, PLUGIN_TRUST_FILENAME);
  }

  _read(): TrustFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this._path, "utf8"));
      if (!raw || typeof raw !== "object") return emptyFile();
      return {
        schemaVersion: 1,
        grants: raw.grants && typeof raw.grants === "object" ? raw.grants : {},
      };
    } catch (err: any) {
      if (err?.code === "ENOENT") return emptyFile();
      return emptyFile();
    }
  }

  _write(file: TrustFile) {
    fs.mkdirSync(path.dirname(this._path), { recursive: true });
    atomicWriteSync(this._path, `${JSON.stringify(file, null, 2)}\n`);
  }

  grant(input: {
    marketplaceId: string;
    pluginId: string;
    artifactDigest: string;
    privilegedDefinitionHashes?: string[];
    grantedCapabilities?: string[];
  }): PluginTrustGrant {
    const grant: PluginTrustGrant = {
      marketplaceId: assertMarketplaceId(input.marketplaceId),
      pluginId: assertPluginId(input.pluginId),
      artifactDigest: assertArtifactDigest(input.artifactDigest),
      privilegedDefinitionHashes: [...(input.privilegedDefinitionHashes || [])].sort(),
      grantedCapabilities: [...(input.grantedCapabilities || ["full-access"])],
      grantedAt: new Date().toISOString(),
    };
    const file = this._read();
    const key = buildPluginArtifactKey(grant);
    file.grants[key] = grant;
    this._write(file);
    return structuredClone(grant);
  }

  revoke(marketplaceId: string, pluginId: string, artifactDigest: string): boolean {
    const key = buildPluginArtifactKey({
      marketplaceId: assertMarketplaceId(marketplaceId),
      pluginId: assertPluginId(pluginId),
      artifactDigest: assertArtifactDigest(artifactDigest),
    });
    const file = this._read();
    if (!file.grants[key]) return false;
    delete file.grants[key];
    this._write(file);
    return true;
  }

  getGrant(marketplaceId: string, pluginId: string, artifactDigest: string): PluginTrustGrant | null {
    const key = buildPluginArtifactKey({
      marketplaceId: assertMarketplaceId(marketplaceId),
      pluginId: assertPluginId(pluginId),
      artifactDigest: assertArtifactDigest(artifactDigest),
    });
    const grant = this._read().grants[key];
    return grant ? structuredClone(grant) : null;
  }

  /**
   * Full-access requires both the global policy ceiling and a matching artifact grant.
   * A changed artifact digest or definition hash does not inherit trust.
   */
  isFullAccessAllowed(input: {
    marketplaceId: string;
    pluginId: string;
    artifactDigest: string;
    privilegedDefinitionHashes?: string[];
    globalFullAccessEnabled: boolean;
  }): boolean {
    if (!input.globalFullAccessEnabled) return false;
    const grant = this.getGrant(input.marketplaceId, input.pluginId, input.artifactDigest);
    if (!grant) return false;
    if (!grant.grantedCapabilities.includes("full-access")) return false;
    const required = [...(input.privilegedDefinitionHashes || [])].sort();
    if (required.length === 0) return true;
    if (grant.privilegedDefinitionHashes.length === 0) return true;
    // Every currently privileged definition hash must have been granted.
    return required.every((h) => grant.privilegedDefinitionHashes.includes(h));
  }

  listGrantsForPlugin(pluginId: string): PluginTrustGrant[] {
    const id = assertPluginId(pluginId);
    return Object.values(this._read().grants).filter((g) => g.pluginId === id);
  }
}

/** Build source-qualified plugin data directory segments. */
export function marketplacePluginDataDir(rootDataDir: string, marketplaceId: string, pluginId: string): string {
  return path.join(
    rootDataDir,
    assertMarketplaceId(marketplaceId),
    assertPluginId(pluginId),
  );
}

export function marketplacePluginKey(marketplaceId: string, pluginId: string): string {
  return `${assertMarketplaceId(marketplaceId)}:${assertPluginId(pluginId)}`;
}
