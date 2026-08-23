import fs from "fs";
import path from "path";
import {
  assertArtifactDigest,
  assertMarketplaceId,
  assertPluginId,
} from "./plugin-marketplace-identity.ts";
import { createModuleLogger } from "./debug-log.ts";

export const PLUGIN_ARTIFACTS_DIR = "plugin-artifacts";

const artifactLog = createModuleLogger("plugin-artifact-store");

export interface RetainArtifactInput {
  marketplaceId: string;
  pluginId: string;
  artifactDigest: string;
  version: string;
  sourceFingerprint: string;
  catalogSha256: string;
  packageSha256: string;
  packageDir: string;
  packageUrl?: string;
  requestedRef?: string;
  resolvedRevision?: string;
}

export interface RetainedArtifactInfo {
  marketplaceId: string;
  pluginId: string;
  artifactDigest: string;
  version: string;
  sourceFingerprint: string;
  catalogSha256: string;
  packageSha256: string;
  packageUrl?: string;
  requestedRef?: string;
  resolvedRevision?: string;
  artifactPath: string;
  retainedAt: string;
  lastActivatedAt?: string;
}

export class PluginArtifactStore {
  declare _root: string;

  constructor({ hanakoHome }: { hanakoHome: string }) {
    if (!hanakoHome) throw new Error("PluginArtifactStore requires hanakoHome");
    this._root = path.join(hanakoHome, PLUGIN_ARTIFACTS_DIR);
  }

  artifactPath(marketplaceId: string, pluginId: string, artifactDigest: string): string {
    return path.join(
      this._root,
      assertMarketplaceId(marketplaceId),
      assertPluginId(pluginId),
      assertArtifactDigest(artifactDigest),
    );
  }

  retain(input: RetainArtifactInput): RetainedArtifactInfo {
    const marketplaceId = assertMarketplaceId(input.marketplaceId);
    const pluginId = assertPluginId(input.pluginId);
    const artifactDigest = assertArtifactDigest(input.artifactDigest);
    if (!input.packageDir || !fs.existsSync(input.packageDir)) {
      throw new Error("retain requires an existing packageDir");
    }
    if (input.packageSha256 !== artifactDigest) {
      // In v1 digest is the package sha256 for release artifacts.
      if (!/^[a-f0-9]{64}$/.test(input.packageSha256 || "")) {
        throw new Error("packageSha256 must be 64-hex");
      }
    }

    const dest = this.artifactPath(marketplaceId, pluginId, artifactDigest);
    const metaPath = path.join(dest, ".hana-artifact.json");
    if (fs.existsSync(dest) && fs.existsSync(metaPath)) {
      const existing = JSON.parse(fs.readFileSync(metaPath, "utf8")) as RetainedArtifactInfo;
      return existing;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(input.packageDir, tmp, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);

    const now = new Date().toISOString();
    const info: RetainedArtifactInfo = {
      marketplaceId,
      pluginId,
      artifactDigest,
      version: input.version || "0.0.0",
      sourceFingerprint: input.sourceFingerprint,
      catalogSha256: input.catalogSha256,
      packageSha256: input.packageSha256,
      packageUrl: input.packageUrl,
      requestedRef: input.requestedRef,
      resolvedRevision: input.resolvedRevision,
      artifactPath: dest,
      retainedAt: now,
    };
    fs.writeFileSync(metaPath, `${JSON.stringify(info, null, 2)}\n`, "utf8");
    return structuredClone(info);
  }

  get(marketplaceId: string, pluginId: string, artifactDigest: string): RetainedArtifactInfo | null {
    const dest = this.artifactPath(marketplaceId, pluginId, artifactDigest);
    const metaPath = path.join(dest, ".hana-artifact.json");
    if (!fs.existsSync(metaPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      return null;
    }
  }

  markActivated(marketplaceId: string, pluginId: string, artifactDigest: string): void {
    const info = this.get(marketplaceId, pluginId, artifactDigest);
    if (!info) return;
    info.lastActivatedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(info.artifactPath, ".hana-artifact.json"),
      `${JSON.stringify(info, null, 2)}\n`,
      "utf8",
    );
  }

  listRetained(pluginId?: string, marketplaceId?: string): RetainedArtifactInfo[] {
    if (!fs.existsSync(this._root)) return [];
    const out: RetainedArtifactInfo[] = [];
    const markets = marketplaceId
      ? [marketplaceId]
      : fs.readdirSync(this._root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

    for (const market of markets) {
      let marketId: string;
      try {
        marketId = assertMarketplaceId(market);
      } catch {
        artifactLog.warn(`skipping malformed artifact marketplace directory: ${market}`);
        continue;
      }
      const marketDir = path.join(this._root, marketId);
      if (!fs.existsSync(marketDir)) continue;
      const plugins = pluginId
        ? [pluginId]
        : fs.readdirSync(marketDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      for (const plugin of plugins) {
        let pluginIdValue: string;
        try {
          pluginIdValue = assertPluginId(plugin);
        } catch {
          artifactLog.warn(`skipping malformed artifact plugin directory: ${marketId}/${plugin}`);
          continue;
        }
        const pluginDir = path.join(marketDir, pluginIdValue);
        if (!fs.existsSync(pluginDir)) continue;
        for (const dig of fs.readdirSync(pluginDir, { withFileTypes: true })) {
          if (!dig.isDirectory()) continue;
          try {
            assertArtifactDigest(dig.name);
          } catch {
            artifactLog.warn(`skipping malformed artifact digest directory: ${marketId}/${pluginIdValue}/${dig.name}`);
            continue;
          }
          const info = this.get(marketId, pluginIdValue, dig.name);
          if (info) out.push(info);
        }
      }
    }
    return out;
  }

  isSourceInUse(marketplaceId: string): boolean {
    return this.listRetained(undefined, marketplaceId).length > 0;
  }

  remove({
    marketplaceId,
    pluginId,
    artifactDigest,
  }: {
    marketplaceId: string;
    pluginId: string;
    artifactDigest: string;
  }): boolean {
    const dest = this.artifactPath(marketplaceId, pluginId, artifactDigest);
    if (!fs.existsSync(dest)) return false;
    fs.rmSync(dest, { recursive: true, force: true });
    return true;
  }
}
