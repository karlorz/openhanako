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
      const installMeta = plugin.install && typeof plugin.install === "object"
        ? plugin.install as Record<string, unknown>
        : {};
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
        install: installMeta,
        catalogFormat: typeof installMeta.catalogFormat === "string" ? installMeta.catalogFormat : null,
        installTarget: typeof installMeta.installTarget === "string" ? installMeta.installTarget : null,
        canInstall: installMeta.canInstall === true
          || (plugin.distribution?.kind === "release" && !!(plugin.distribution as any).packageUrl),
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

  private _officialSeedPromise: Promise<void> | null = null;

  /**
   * Soft-seed the compiled official URL snapshot when missing/error so Settings is not empty.
   * Does not throw; failures leave status as error with a readable message.
   */
  ensureOfficialSnapshotSeeded(options: { url?: string } = {}) {
    const status = this.snapshots.getStatus(OFFICIAL_MARKETPLACE_ID);
    if (status.state === "ok" || status.state === "stale" || status.state === "refreshing") {
      return status;
    }
    if (!this._officialSeedPromise) {
      this._officialSeedPromise = (async () => {
        try {
          const sources = this.registry.listSources();
          const official = sources.find((s) => s.id === OFFICIAL_MARKETPLACE_ID) as any;
          const url = options.url || official?.url;
          if (!url) return;
          await acquireAndPublishSourceSnapshot({
            id: OFFICIAL_MARKETPLACE_ID,
            name: official?.name || "OH Plugins Official",
            kind: "url",
            url,
          }, {
            store: this.snapshots,
            fetchOptions: this.fetchOptions,
            localAllowedRoot: this.localAllowedRoot,
          });
        } catch {
          // markError already applied by acquire; leave status for UI
        } finally {
          this._officialSeedPromise = null;
        }
      })();
    }
    return this.snapshots.getStatus(OFFICIAL_MARKETPLACE_ID);
  }

  /** Awaitable seed used by routes that need plugins before responding. */
  async ensureOfficialSnapshotSeededAsync(options: { url?: string } = {}) {
    this.ensureOfficialSnapshotSeeded(options);
    if (this._officialSeedPromise) {
      await this._officialSeedPromise;
    }
    return this.snapshots.getStatus(OFFICIAL_MARKETPLACE_ID);
  }

  /**
   * Install a Claude-catalog plugin as Hana user skills (skills-lane).
   * Requires relative package source and studio.owner for mutation consistency with addSource.
   */
  async installClaudePluginSkills(
    pluginId: string,
    marketplaceId: string,
    options: {
      userSkillsDir: string;
      isStudioOwner?: boolean;
      execGit?: any;
    },
  ): Promise<{
    marketplaceId: string;
    pluginId: string;
    skills: string[];
    skipped: Array<{ path: string; reason: string }>;
    resolvedRevision: string | null;
  }> {
    if (!options.isStudioOwner) {
      const err = new Error("studio.owner required to install marketplace skills") as Error & {
        code: string;
        status: number;
      };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN";
      err.status = 403;
      throw err;
    }

    const plugin = this.getCatalogPlugin(pluginId, marketplaceId);
    if (!plugin) {
      const err = new Error(`Catalog plugin not found: ${pluginId}@${marketplaceId}`) as Error & {
        code: string;
        status: number;
      };
      err.code = "NOT_FOUND";
      err.status = 404;
      throw err;
    }
    const installMeta = (plugin.install || {}) as Record<string, unknown>;
    if (installMeta.catalogFormat !== "claude") {
      const err = new Error("Not a Claude catalog plugin") as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_INVALID";
      err.status = 400;
      throw err;
    }
    if (installMeta.canInstall !== true || installMeta.sourceKind !== "relative") {
      const err = new Error(
        "Claude plugin source is not installable in v1 (relative package path required)",
      ) as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_INVALID";
      err.status = 400;
      throw err;
    }
    const packagePath = typeof installMeta.source === "string" ? installMeta.source : "";
    if (!packagePath) {
      const err = new Error("Claude plugin missing relative source path") as Error & {
        code: string;
        status: number;
      };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_INVALID";
      err.status = 400;
      throw err;
    }

    const sources = this.registry.listSources();
    const source = sources.find((s) => s.id === marketplaceId);
    if (!source || source.kind !== "git") {
      const err = new Error(
        "Claude skills install currently requires a git marketplace source",
      ) as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_INVALID";
      err.status = 400;
      throw err;
    }

    const { materializeGitMarketplacePackage } = await import("./plugin-marketplace-git-cache.ts");
    const {
      installClaudeSkillsFromPackage,
      writeClaudeSkillsInstallRecord,
    } = await import("./plugin-marketplace-claude-skills.ts");

    const materialized = await materializeGitMarketplacePackage(
      {
        id: source.id,
        kind: "git",
        gitUrl: (source as any).gitUrl,
        gitRef: (source as any).gitRef,
        indexPath: (source as any).indexPath,
      },
      {
        hanakoHome: this._hanakoHome,
        packagePath,
        execGit: options.execGit,
      },
    );

    const result = installClaudeSkillsFromPackage({
      packageRoot: materialized.packageRoot,
      installDir: options.userSkillsDir,
      owner: "user",
    });

    writeClaudeSkillsInstallRecord(this._hanakoHome, {
      kind: "claude-skills",
      marketplaceId,
      pluginId,
      packagePath,
      resolvedRevision: materialized.resolvedRevision,
      skills: result.installed.map((s) => s.name),
      installedAt: new Date().toISOString(),
    });

    return {
      marketplaceId,
      pluginId,
      skills: result.installed.map((s) => s.name),
      skipped: result.skipped,
      resolvedRevision: materialized.resolvedRevision,
    };
  }
}
