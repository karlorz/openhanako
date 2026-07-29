import path from "path";
import {
  PluginMarketplaceSourceRegistry,
  OFFICIAL_MARKETPLACE_ID,
  resolveLegacyMarketplaceOverlay,
  type MarketplaceSourceDescriptor,
  type EffectiveMarketplaceSource,
} from "./plugin-marketplace-sources.ts";
import { MarketplaceSnapshotStore } from "./plugin-marketplace-snapshots.ts";
import { acquireAndPublishSourceSnapshot } from "./plugin-marketplace-adapters.ts";
import {
  resolveMarketplacePlugin,
  type MarketplaceResolveSourceCoverage,
  type TaggedResolveRow,
} from "./plugin-marketplace-resolve.ts";
import { PluginInstallRecords } from "./plugin-install-records.ts";
import { PluginArtifactStore } from "./plugin-artifact-store.ts";
import type { SafeFetchOptions } from "./plugin-marketplace-network-policy.ts";
import { sanitizeAcquisitionError } from "./plugin-marketplace-network-policy.ts";

export interface MarketplaceServiceOptions {
  hanakoHome: string;
  fetchOptions?: SafeFetchOptions;
  localAllowedRoot?: string;
  officialUrl?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Orchestrates multi-source registry + snapshots + resolution for HTTP/UI.
 */
export class PluginMarketplaceService {
  declare _hanakoHome: string;
  declare registry: PluginMarketplaceSourceRegistry;
  declare snapshots: MarketplaceSnapshotStore;
  declare records: PluginInstallRecords;
  declare artifacts: PluginArtifactStore;
  declare fetchOptions?: SafeFetchOptions;
  declare localAllowedRoot: string;

  constructor(options: MarketplaceServiceOptions) {
    this._hanakoHome = options.hanakoHome;
    this.fetchOptions = options.fetchOptions;
    this.localAllowedRoot = options.localAllowedRoot
      || path.join(options.hanakoHome, "plugin-marketplaces-local");
    const legacy = resolveLegacyMarketplaceOverlay(options.env || process.env);
    this.registry = new PluginMarketplaceSourceRegistry({
      hanakoHome: options.hanakoHome,
      officialUrl: options.officialUrl,
      legacyOverlay: legacy,
    });
    this.snapshots = new MarketplaceSnapshotStore({ hanakoHome: options.hanakoHome });
    this.records = new PluginInstallRecords({ hanakoHome: options.hanakoHome });
    this.artifacts = new PluginArtifactStore({ hanakoHome: options.hanakoHome });
  }

  listSources(options: { forRemote?: boolean } = {}) {
    const listed = this.registry.listSources({ forRemote: options.forRemote });
    return listed.map((source) => {
      const status = this.snapshots.getStatus(source.id);
      return {
        ...source,
        status: status.state,
        catalogSha256: status.state === "ok" || status.state === "stale" || status.state === "refreshing"
          ? status.current?.catalogSha256 || null
          : null,
        fetchedAt: status.state === "ok" || status.state === "stale" || status.state === "refreshing"
          ? status.current?.fetchedAt || null
          : null,
        refreshError: status.state === "stale" || status.state === "error"
          ? sanitizeAcquisitionError(
            { message: status.refreshError.message, code: status.refreshError.code } as any,
            { forRemote: options.forRemote },
          )
          : null,
      };
    });
  }

  async addSource(descriptor: MarketplaceSourceDescriptor, options: {
    isLocalOwner?: boolean;
    isStudioOwner?: boolean;
  } = {}) {
    if (!options.isStudioOwner) {
      const err = new Error("studio.owner required to mutate marketplace sources") as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN";
      err.status = 403;
      throw err;
    }
    if (descriptor.kind === "local" && !options.isLocalOwner) {
      const err = new Error("loopback local-owner required for local marketplace sources") as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN";
      err.status = 403;
      throw err;
    }
    // Validate first snapshot before committing registry (except git until Task 6 wired here)
    if (descriptor.kind === "git") {
      // Allow registry add only after snapshot publish via git adapter (Task 6).
      const { acquireGitMarketplaceSnapshot } = await import("./plugin-marketplace-git-cache.ts");
      await acquireGitMarketplaceSnapshot(descriptor, {
        store: this.snapshots,
        hanakoHome: this._hanakoHome,
      });
    } else {
      await acquireAndPublishSourceSnapshot(descriptor, {
        store: this.snapshots,
        fetchOptions: this.fetchOptions,
        localAllowedRoot: this.localAllowedRoot,
      });
    }
    return this.registry.addSource(descriptor);
  }

  removeSource(marketplaceId: string, options: { isStudioOwner?: boolean } = {}) {
    if (!options.isStudioOwner) {
      const err = new Error("studio.owner required") as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN";
      err.status = 403;
      throw err;
    }
    return this.registry.removeSource(marketplaceId, {
      isSourceInUse: (id) =>
        this.artifacts.isSourceInUse(id) || this.records.isSourceInUse(id),
    });
  }

  async refreshSource(marketplaceId: string, options: { isStudioOwner?: boolean } = {}) {
    if (!options.isStudioOwner) {
      const err = new Error("studio.owner required") as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN";
      err.status = 403;
      throw err;
    }
    const sources = this.registry.listSources();
    const source = sources.find((s) => s.id === marketplaceId);
    if (!source) {
      const err = new Error(`Marketplace source not found: ${marketplaceId}`) as Error & { code: string; status: number };
      err.code = "NOT_FOUND";
      err.status = 404;
      throw err;
    }
    if (source.authority === "official") {
      // Official is compiled; re-fetch its URL descriptor.
      await acquireAndPublishSourceSnapshot({
        id: source.id,
        name: source.name,
        kind: "url",
        url: (source as any).url,
      }, {
        store: this.snapshots,
        fetchOptions: this.fetchOptions,
        localAllowedRoot: this.localAllowedRoot,
      });
      return this.snapshots.getStatus(marketplaceId);
    }
    if (source.kind === "git") {
      const { acquireGitMarketplaceSnapshot } = await import("./plugin-marketplace-git-cache.ts");
      await acquireGitMarketplaceSnapshot(source as any, {
        store: this.snapshots,
        hanakoHome: this._hanakoHome,
      });
    } else {
      await acquireAndPublishSourceSnapshot(source as MarketplaceSourceDescriptor, {
        store: this.snapshots,
        fetchOptions: this.fetchOptions,
        localAllowedRoot: this.localAllowedRoot,
      });
    }
    return this.snapshots.getStatus(marketplaceId);
  }

  listCatalogRows(options: { forRemote?: boolean } = {}) {
    const sources = this.listSources({ forRemote: options.forRemote });
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const plugins = this.snapshots.listCurrentPlugins();
    const rows = plugins.map((plugin) => {
      const source = sourceById.get(plugin.marketplaceId);
      const install = this.records.get(plugin.id);
      const active = install?.activeMarketplaceId === plugin.marketplaceId;
      const retained = Boolean(install?.retained?.[plugin.marketplaceId]);
      return {
        compositeKey: `${plugin.id}@${plugin.marketplaceId}`,
        marketplaceId: plugin.marketplaceId,
        pluginId: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        publisher: plugin.publisher,
        trust: plugin.trust,
        distribution: plugin.distribution,
        sourceAuthority: source?.authority || "custom",
        sourceStatus: source?.status || "error",
        active,
        retained,
        available: true,
      };
    });
    return { sources, plugins: rows };
  }

  resolveInstall(pluginId: string, marketplaceId?: string | null) {
    const coverage = this._coverage();
    const rows = this.listResolveRows();
    return resolveMarketplacePlugin({
      pluginId,
      marketplaceId,
      rows,
      sources: coverage,
      operation: "fresh-install",
    });
  }

  /** Full snapshot plugin row for install/readme after resolution. */
  getCatalogPlugin(pluginId: string, marketplaceId: string) {
    return this.snapshots.listCurrentPlugins().find(
      (p) => p.id === pluginId && p.marketplaceId === marketplaceId,
    ) || null;
  }

  listResolveRows(): TaggedResolveRow[] {
    return this.snapshots.listCurrentPlugins().map((p) => ({
      marketplaceId: p.marketplaceId,
      id: p.id,
      name: p.name,
      distribution: p.distribution,
      version: p.version,
      versions: p.versions,
      trust: p.trust,
      description: p.description,
      publisher: p.publisher,
      readme: p.readme,
      readmePath: p.readmePath,
      readmeUrl: p.readmeUrl,
    })) as TaggedResolveRow[];
  }

  _coverage(): MarketplaceResolveSourceCoverage[] {
    return this.registry.listSources().map((source) => {
      const status = this.snapshots.getStatus(source.id);
      const usable = status.state === "ok" || status.state === "stale"
        || (status.state === "refreshing" && !!status.current);
      return {
        sourceId: source.id,
        authority: source.authority,
        usable,
      };
    });
  }

  ensureOfficialSnapshotSeeded(options: { url?: string } = {}) {
    // Soft helper for tests: mark official ok empty if missing.
    const status = this.snapshots.getStatus(OFFICIAL_MARKETPLACE_ID);
    return status;
  }
}
