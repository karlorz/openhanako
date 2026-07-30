import path from "path";
import {
  PluginMarketplaceSourceRegistry,
  OFFICIAL_MARKETPLACE_ID,
  resolveLegacyMarketplaceOverlay,
  type MarketplaceSourceDescriptor,
  type EffectiveMarketplaceSource,
  type MarketplaceSourceRegistryStatus,
  type MarketplaceControlPlaneActivations,
  type MarketplaceControlPlaneDiagnosticReport,
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
import {
  createMarketplaceInstallPlan,
  inspectMarketplacePackage,
} from "./plugin-marketplace-inspector.ts";
import {
  buildMarketplaceSkillRef,
  buildPluginMarketplaceRef,
} from "./plugin-marketplace-identity.ts";
import {
  computeMarketplaceSkillActivation,
  computeNativeAgentPluginAccess,
  computeRuntimePluginActivation,
} from "./plugin-marketplace-activation.ts";
import { listClaudeSkillsInstallRecords } from "./plugin-marketplace-claude-skills.ts";
import {
  ClaudeCompatibilityBindingService,
  type ClaudeCompatibilityBinding,
} from "./claude-compatibility.ts";
import type { TaggedMarketplacePlugin } from "./plugin-marketplace-schema.ts";

export interface MarketplaceServiceOptions {
  hanakoHome: string;
  fetchOptions?: SafeFetchOptions;
  localAllowedRoot?: string;
  officialUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MarketplaceCapabilityContract {
  schemaVersion: 1;
  supported: boolean;
  version: "plugin-marketplace-capabilities.v1";
  sourceKinds: Array<"url" | "local" | "git">;
  installTargets: Array<"native-plugin" | "hana-skills" | "unsupported">;
  features: {
    multiSourceBrowse: boolean;
    ownerSourceLifecycle: boolean;
    sourceConfigRevision: boolean;
    sourceConfigDigest: boolean;
    lastKnownGoodRegistry: boolean;
    claudeCatalogClassification: boolean;
    marketplaceSkillInstall: boolean;
    agentMarketplaceManagement: boolean;
    claudeCompatibilityBindings: boolean;
    nativeMarketplaceInstall: boolean;
    exactSourceQualifiedActivation: boolean;
    nativeAgentPluginAccess: boolean;
    controlPlaneDiagnostics: boolean;
    controlPlaneActivationWrites: boolean;
    claudeCompatibilityBridgeValidation: boolean;
    desktopClaudeCompatibilityBridgeTransport: boolean;
  };
  unsupported: Array<{ code: string; message: string }>;
  upgradeGuidance: string | null;
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
  declare claudeCompatibility: ClaudeCompatibilityBindingService;
  declare _claudeCompatibilityPollTimer: ReturnType<typeof setInterval> | null;

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
    this.claudeCompatibility = new ClaudeCompatibilityBindingService({
      hanakoHome: options.hanakoHome,
      registry: this.registry,
    });
    this._claudeCompatibilityPollTimer = null;
  }

  getCapabilityContract(): MarketplaceCapabilityContract {
    return {
      schemaVersion: 1,
      supported: true,
      version: "plugin-marketplace-capabilities.v1",
      sourceKinds: ["url", "local", "git"],
      installTargets: ["native-plugin", "hana-skills", "unsupported"],
      features: {
        multiSourceBrowse: true,
        ownerSourceLifecycle: true,
        sourceConfigRevision: true,
        sourceConfigDigest: true,
        lastKnownGoodRegistry: true,
        claudeCatalogClassification: true,
        marketplaceSkillInstall: true,
        agentMarketplaceManagement: true,
        claudeCompatibilityBindings: true,
        nativeMarketplaceInstall: false,
        exactSourceQualifiedActivation: true,
        nativeAgentPluginAccess: true,
        controlPlaneDiagnostics: true,
        controlPlaneActivationWrites: true,
        claudeCompatibilityBridgeValidation: true,
        desktopClaudeCompatibilityBridgeTransport: false,
      },
      unsupported: [
        {
          code: "PLUGIN_MARKETPLACE_NATIVE_INSTALL_PREVIEW_ONLY",
          message: "Native marketplace packages are classified for review only until the PluginManager contract audit is complete.",
        },
      ],
      upgradeGuidance: null,
    };
  }

  getRegistryStatus(options: { forRemote?: boolean } = {}): MarketplaceSourceRegistryStatus {
    const status = this.registry.getStatus();
    return options.forRemote ? { ...status, path: "[server-local path redacted]" } : status;
  }

  getControlPlaneDiagnostics(options: { forRemote?: boolean } = {}): MarketplaceControlPlaneDiagnosticReport {
    const report = this.registry.diagnoseControlPlane();
    const bindings = report.file?.claudeCompatibility?.bindings;
    if (!options.forRemote || !bindings) return report;
    return {
      ...report,
      file: {
        ...report.file!,
        claudeCompatibility: {
          bindings: bindings.map((binding) => ({
            ...binding,
            inputs: binding.inputs.map((input) => ({ ...input, path: "[server-local path redacted]" })),
          })),
        },
      },
    };
  }

  listClaudeCompatibilityBindings(options: { forRemote?: boolean } = {}) {
    return this.claudeCompatibility.listBindings({ redactPaths: options.forRemote === true });
  }

  planClaudeCompatibilityMutation(input: Parameters<ClaudeCompatibilityBindingService["planMutation"]>[0]) {
    return this.claudeCompatibility.planMutation(input);
  }

  executeClaudeCompatibilityMutation(input: Parameters<ClaudeCompatibilityBindingService["executeMutation"]>[0]) {
    return this.claudeCompatibility.executeMutation(input);
  }

  refreshClaudeCompatibilityBinding(bindingId: string) {
    return this.claudeCompatibility.refresh(bindingId);
  }

  pollClaudeCompatibilityBindings() {
    return this.claudeCompatibility.pollLiveBindings();
  }

  startClaudeCompatibilityPolling(intervalMs = 15_000) {
    if (this._claudeCompatibilityPollTimer) return;
    this._pollClaudeCompatibilityBindingsSafely();
    this._claudeCompatibilityPollTimer = setInterval(
      () => this._pollClaudeCompatibilityBindingsSafely(),
      Math.max(1_000, intervalMs),
    );
    this._claudeCompatibilityPollTimer.unref?.();
  }

  stopClaudeCompatibilityPolling() {
    if (!this._claudeCompatibilityPollTimer) return;
    clearInterval(this._claudeCompatibilityPollTimer);
    this._claudeCompatibilityPollTimer = null;
  }

  _pollClaudeCompatibilityBindingsSafely() {
    try {
      this.pollClaudeCompatibilityBindings();
    } catch {
      // Binding diagnostics retain last-known-good state and the next bounded
      // poll retries, so polling must not prevent the service from starting.
    }
  }

  validateClaudeCompatibilityBridge(value: unknown, expected: {
    serverId: string;
    serverBindingId: string;
    deviceId?: string;
    sessionId?: string;
  }) {
    return this.claudeCompatibility.validateBridgeEnvelope(value, expected);
  }

  assertRegistryWritePrecondition(options: { expectedRevision?: number; expectedDigest?: string } = {}) {
    if (options.expectedRevision === undefined && options.expectedDigest === undefined) return;
    const status = this.getRegistryStatus();
    if (status.degraded) {
      const err = new Error(`Invalid registry (degraded): ${status.diagnostic || "malformed registry"}`) as Error & {
        code: string;
        status: number;
      };
      err.code = "PLUGIN_MARKETPLACE_REGISTRY_DEGRADED";
      err.status = 409;
      throw err;
    }
    if (options.expectedRevision !== undefined && options.expectedRevision !== status.revision) {
      const err = new Error(
        `Marketplace registry revision conflict: expected ${options.expectedRevision}, current ${status.revision}`,
      ) as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_REGISTRY_STALE";
      err.status = 409;
      throw err;
    }
    if (options.expectedDigest !== undefined && options.expectedDigest !== status.digest) {
      const err = new Error(
        `Marketplace registry digest conflict: expected ${options.expectedDigest}, current ${status.digest}`,
      ) as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_REGISTRY_STALE";
      err.status = 409;
      throw err;
    }
  }

  assertRegistryUsableForAcquisition() {
    const status = this.getRegistryStatus();
    if (!status.degraded) return;
    const err = new Error(`Invalid registry (degraded): ${status.diagnostic || "malformed registry"}`) as Error & {
      code: string;
      status: number;
    };
    err.code = "PLUGIN_MARKETPLACE_REGISTRY_DEGRADED";
    err.status = 409;
    throw err;
  }

  listSources(options: { forRemote?: boolean } = {}) {
    const listed = this.registry.listSources({ forRemote: options.forRemote });
    return this._listSourcesWithCatalogCounts(listed, this.snapshots.listCurrentPlugins(), options);
  }

  _listSourcesWithCatalogCounts(
    listed: EffectiveMarketplaceSource[],
    plugins: TaggedMarketplacePlugin[],
    options: { forRemote?: boolean } = {},
  ) {
    const catalogCounts = new Map<string, number>();
    for (const plugin of plugins) {
      catalogCounts.set(plugin.marketplaceId, (catalogCounts.get(plugin.marketplaceId) || 0) + 1);
    }
    return listed.map((source) => {
      const status = this.snapshots.getStatus(source.id);
      return {
        ...source,
        catalogCount: catalogCounts.get(source.id) || 0,
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
    expectedRevision?: number;
    expectedDigest?: string;
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
    this.assertRegistryWritePrecondition({
      expectedRevision: options.expectedRevision,
      expectedDigest: options.expectedDigest,
    });
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
    return this.registry.addSource(descriptor, {
      expectedRevision: options.expectedRevision,
      expectedDigest: options.expectedDigest,
    });
  }

  removeSource(marketplaceId: string, options: {
    isStudioOwner?: boolean;
    expectedRevision?: number;
    expectedDigest?: string;
  } = {}) {
    if (!options.isStudioOwner) {
      const err = new Error("studio.owner required") as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN";
      err.status = 403;
      throw err;
    }
    return this.registry.removeSource(marketplaceId, {
      expectedRevision: options.expectedRevision,
      expectedDigest: options.expectedDigest,
      isSourceInUse: (id) =>
        this.artifacts.isSourceInUse(id) || this.records.isSourceInUse(id),
    });
  }

  setSourceEnabled(marketplaceId: string, enabled: boolean, options: {
    isStudioOwner?: boolean;
    expectedRevision?: number;
    expectedDigest?: string;
  } = {}) {
    if (!options.isStudioOwner) {
      const err = new Error("studio.owner required") as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN";
      err.status = 403;
      throw err;
    }
    return this.registry.setSourceEnabled(marketplaceId, enabled, {
      expectedRevision: options.expectedRevision,
      expectedDigest: options.expectedDigest,
    });
  }

  setControlPlaneActivations(activations: unknown, options: {
    isStudioOwner?: boolean;
    expectedRevision?: number;
    expectedDigest?: string;
  } = {}): { revision: number; activations: MarketplaceControlPlaneActivations } {
    if (!options.isStudioOwner) {
      const err = new Error("studio.owner required to mutate marketplace control plane") as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN";
      err.status = 403;
      throw err;
    }
    return this.registry.setControlPlaneActivations(activations, {
      expectedRevision: options.expectedRevision,
      expectedDigest: options.expectedDigest,
    });
  }

  async refreshSource(marketplaceId: string, options: { isStudioOwner?: boolean } = {}) {
    if (!options.isStudioOwner) {
      const err = new Error("studio.owner required") as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN";
      err.status = 403;
      throw err;
    }
    this.assertRegistryUsableForAcquisition();
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

  listCatalogRows(options: { forRemote?: boolean; agentId?: string | null } = {}) {
    const plugins = this.snapshots.listCurrentPlugins();
    const listed = this.registry.listSources({ forRemote: options.forRemote });
    const sources = this._listSourcesWithCatalogCounts(listed, plugins, { forRemote: options.forRemote });
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const activations = this.registry.getControlPlaneActivations();
    const installedRuntimePluginRefs = this.installedRuntimePluginRefs();
    const installedMarketplaceSkillRefs = this.installedMarketplaceSkillRefs();
    const rows = plugins.map((plugin) => {
      const source = sourceById.get(plugin.marketplaceId);
      const install = this.records.get(plugin.id);
      const active = install?.activeMarketplaceId === plugin.marketplaceId;
      const retained = Boolean(install?.retained?.[plugin.marketplaceId]);
      const installMeta = plugin.install && typeof plugin.install === "object"
        ? plugin.install as Record<string, unknown>
        : {};
      const inspection = inspectMarketplacePackage(plugin);
      const installPlan = createMarketplaceInstallPlan(inspection);
      const catalogFormat = typeof installMeta.catalogFormat === "string" ? installMeta.catalogFormat : null;
      const runtimeIdentity = buildPluginMarketplaceRef({
        pluginId: plugin.id,
        marketplaceId: plugin.marketplaceId,
      });
      const runtimeActivation = computeRuntimePluginActivation({
        identity: runtimeIdentity,
        activations,
        sources,
        installedRuntimePluginRefs,
      });
      const marketplaceSkillActivations = inspection.destination === "hana-skills"
        ? installedMarketplaceSkillRefs
          .filter((identity) => identity.endsWith(`@${plugin.marketplaceId}/${plugin.id}`))
          .map((identity) => computeMarketplaceSkillActivation({
            identity,
            activations,
            sources,
            installedMarketplaceSkillRefs,
          }))
        : [];
      const nativeAgentPluginAccess = inspection.destination === "native-plugin" && options.agentId
        ? computeNativeAgentPluginAccess({
            identity: runtimeIdentity,
            agentId: options.agentId,
            activations,
            sources,
            installedRuntimePluginRefs,
            nativeContributions: inspection.capabilityInventory.nativePluginContributions,
          })
        : null;
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
        catalogFormat,
        installTarget: inspection.destination,
        installAdapter: inspection.installAdapter,
        installable: inspection.installable,
        confirmationLevel: inspection.confirmationLevel,
        capabilityInventory: inspection.capabilityInventory,
        warnings: inspection.warnings,
        installPlan,
        runtimeActivation,
        marketplaceSkillActivations,
        nativeAgentPluginAccess,
        canInstall: inspection.installable,
        sourceAuthority: source?.authority || "custom",
        sourceStatus: source?.status || "error",
        sourceEnabled: source?.enabled !== false,
        active,
        retained,
        available: source?.enabled !== false,
      };
    });
    return { sources, plugins: rows };
  }

  installedRuntimePluginRefs(): string[] {
    const refs = new Set<string>();
    for (const record of this.records.list()) {
      for (const marketplaceId of Object.keys(record.retained || {})) {
        if (marketplaceId === "legacy-unqualified") continue;
        refs.add(buildPluginMarketplaceRef({
          pluginId: record.pluginId,
          marketplaceId,
        }));
      }
    }
    return [...refs].sort();
  }

  installedMarketplaceSkillRefs(): string[] {
    const refs: string[] = [];
    for (const record of listClaudeSkillsInstallRecords(this._hanakoHome)) {
      for (const skillName of record.skills || []) {
        refs.push(buildMarketplaceSkillRef({
          skillName,
          marketplaceId: record.marketplaceId,
          pluginId: record.pluginId,
        }));
      }
    }
    return refs.sort();
  }

  getRuntimePluginActivation(pluginId: string, marketplaceId: string) {
    return computeRuntimePluginActivation({
      identity: buildPluginMarketplaceRef({ pluginId, marketplaceId }),
      activations: this.registry.getControlPlaneActivations(),
      sources: this.registry.listSources(),
      installedRuntimePluginRefs: this.installedRuntimePluginRefs(),
    });
  }

  getMarketplaceSkillActivation(
    skillName: string,
    marketplaceId: string,
    pluginId: string,
    options: { agentId?: string | null } = {},
  ) {
    return computeMarketplaceSkillActivation({
      identity: { skillName, marketplaceId, pluginId },
      agentId: options.agentId,
      activations: this.registry.getControlPlaneActivations(),
      sources: this.registry.listSources(),
      installedMarketplaceSkillRefs: this.installedMarketplaceSkillRefs(),
    });
  }

  getNativeAgentPluginAccess(
    agentId: string,
    pluginId: string,
    marketplaceId: string,
    nativeContributions: Iterable<string> = [],
  ) {
    return computeNativeAgentPluginAccess({
      identity: buildPluginMarketplaceRef({ pluginId, marketplaceId }),
      agentId,
      activations: this.registry.getControlPlaneActivations(),
      sources: this.registry.listSources(),
      installedRuntimePluginRefs: this.installedRuntimePluginRefs(),
      nativeContributions,
    });
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
    const registryStatus = this.registry.getStatus();
    if (registryStatus.degraded) {
      return this.snapshots.getStatus(OFFICIAL_MARKETPLACE_ID);
    }
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
    warnings: string[];
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
    this.assertRegistryUsableForAcquisition();

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
      // default conflictPolicy is preserve for marketplace imports
    });

    if (result.installed.length === 0) {
      const err = new Error("No Claude marketplace skills were installed") as Error & {
        code: string;
        status: number;
        skipped?: Array<{ path: string; reason: string }>;
        warnings?: string[];
      };
      err.code = "PLUGIN_MARKETPLACE_SKILLS_INSTALL_EMPTY";
      err.status = 409;
      err.skipped = result.skipped;
      err.warnings = result.warnings;
      throw err;
    }

    writeClaudeSkillsInstallRecord(this._hanakoHome, {
      kind: "claude-skills",
      marketplaceId,
      pluginId,
      packagePath,
      resolvedRevision: materialized.resolvedRevision,
      skills: result.installed.map((s) => s.name),
      warnings: result.warnings,
      installedAt: new Date().toISOString(),
    });

    return {
      marketplaceId,
      pluginId,
      skills: result.installed.map((s) => s.name),
      skipped: result.skipped,
      warnings: result.warnings,
      resolvedRevision: materialized.resolvedRevision,
    };
  }
}
