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
  activationSourceIds,
} from "./plugin-marketplace-sources.ts";
import { MarketplaceSnapshotStore } from "./plugin-marketplace-snapshots.ts";
import { acquireAndPublishSourceSnapshot } from "./plugin-marketplace-adapters.ts";
import type { TaggedResolveRow } from "./plugin-marketplace-resolve.ts";
import { PluginInstallRecords } from "./plugin-install-records.ts";
import { PluginArtifactStore } from "./plugin-artifact-store.ts";
import type { SafeFetchOptions } from "./plugin-marketplace-network-policy.ts";
import { sanitizeAcquisitionError } from "./plugin-marketplace-network-policy.ts";
import {
  buildMarketplaceSkillRef,
  buildPluginMarketplaceRef,
} from "./plugin-marketplace-identity.ts";
import { legacyMarketplaceSkillRecordState } from "./marketplace-skill-preferences.ts";
import {
  computeSkillDirSha256,
  readClaudeSkillsInstallRecord,
  uninstallClaudeSkillsInstallRecord,
} from "./plugin-marketplace-claude-skills.ts";
import {
  ClaudeCompatibilityBindingService,
  type ClaudeCompatibilityBinding,
} from "./claude-compatibility.ts";
import type { TaggedMarketplacePlugin } from "./plugin-marketplace-schema.ts";
import { resolveContainedPath } from "./plugin-marketplace-path-policy.ts";
import { MarketplaceCatalogProjection } from "./plugin-marketplace-catalog.ts";
import type {
  ManagePluginsSkillPackageRow,
  ManagePluginsSkillPackageState,
} from "./plugin-marketplace-catalog.ts";

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
    marketplaceSkillUninstall: boolean;
    agentMarketplaceManagement: boolean;
    claudeCompatibilityBindings: boolean;
    nativeMarketplaceInstall: boolean;
    nativeMarketplaceSettingsLifecycle: boolean;
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

export type {
  ManagePluginsSkillPackageRow,
  ManagePluginsSkillPackageState,
};

function pruneEmptySkillActivationMaps(activations: MarketplaceControlPlaneActivations): void {
  for (const kind of ["marketplaceSkills", "marketplaceSkillPackages"] as const) {
    const map = activations[kind];
    if (map && Object.keys(map).length === 0) delete activations[kind];
  }
  const agentOverrides = activations.agentSkillOverrides;
  if (!agentOverrides) return;
  for (const [agentId, entries] of Object.entries(agentOverrides)) {
    if (entries && Object.keys(entries).length === 0) delete agentOverrides[agentId];
  }
  if (Object.keys(agentOverrides).length === 0) delete activations.agentSkillOverrides;
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
  declare catalog: MarketplaceCatalogProjection;

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
    // Read-path projection is wired last so every store is initialized before
    // the projection is constructed; it only calls back into this service on
    // read methods, never during construction.
    this.catalog = new MarketplaceCatalogProjection({
      registry: this.registry,
      snapshots: this.snapshots,
      records: this.records,
      artifacts: this.artifacts,
      service: this,
    });
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
        marketplaceSkillUninstall: true,
        agentMarketplaceManagement: true,
        claudeCompatibilityBindings: true,
        nativeMarketplaceInstall: false,
        nativeMarketplaceSettingsLifecycle: true,
        exactSourceQualifiedActivation: true,
        nativeAgentPluginAccess: true,
        controlPlaneDiagnostics: true,
        controlPlaneActivationWrites: true,
        claudeCompatibilityBridgeValidation: true,
        desktopClaudeCompatibilityBridgeTransport: false,
      },
      unsupported: [
        {
          code: "PLUGIN_MARKETPLACE_NATIVE_AGENT_INSTALL_UNSUPPORTED",
          message: "Agent-driven native Marketplace installation remains unsupported; Studio owners can use the Settings lifecycle.",
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
    if (!options.forRemote) return report;
    const bindings = report.file?.claudeCompatibility?.bindings;
    const redactedReport = {
      ...report,
      path: "[server-local path redacted]",
    };
    if (!bindings) return redactedReport;

    return {
      ...redactedReport,
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

  getInstallPlanContext(marketplaceId: string) {
    const registry = this.getRegistryStatus({ forRemote: true });
    const source = this.registry.listSources().find((candidate) => candidate.id === marketplaceId) || null;
    const status = this.snapshots.getStatus(marketplaceId);
    const current = status.current;
    return {
      registry: {
        revision: registry.revision,
        digest: registry.digest,
      },
      sourceEnabled: Boolean(source && source.enabled !== false),
      sourceSnapshot: {
        state: status.state,
        sourceFingerprint: current?.sourceFingerprint || null,
        catalogSha256: current?.catalogSha256 || null,
        requestedRef: current?.requestedRef || null,
        resolvedRevision: current?.resolvedRevision || null,
      },
    };
  }

  _assertClaudeSkillsInstallPlan(
    marketplaceId: string,
    options: {
      expectedRevision?: number;
      expectedDigest?: string;
      expectedSourceSnapshot?: ReturnType<PluginMarketplaceService["getInstallPlanContext"]>["sourceSnapshot"];
    },
  ) {
    if (options.expectedRevision !== undefined || options.expectedDigest !== undefined) {
      this.assertRegistryWritePrecondition({
        expectedRevision: options.expectedRevision,
        expectedDigest: options.expectedDigest,
      });
    }
    if (options.expectedSourceSnapshot) {
      const current = this.getInstallPlanContext(marketplaceId).sourceSnapshot;
      const expected = options.expectedSourceSnapshot;
      if (
        current.state !== expected.state
        || current.sourceFingerprint !== expected.sourceFingerprint
        || current.catalogSha256 !== expected.catalogSha256
        || current.requestedRef !== expected.requestedRef
        || current.resolvedRevision !== expected.resolvedRevision
      ) {
        const err = new Error("Marketplace source snapshot changed; create a fresh install plan") as Error & {
          code: string;
          status: number;
        };
        err.code = "PLUGIN_MARKETPLACE_PLAN_STALE";
        err.status = 409;
        throw err;
      }
    }
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
      const current = status.state === "ok" || status.state === "stale" || status.state === "refreshing"
        ? status.current
        : null;
      return {
        ...source,
        catalogCount: catalogCounts.get(source.id) || 0,
        status: status.state,
        catalogSha256: current?.catalogSha256 || null,
        fetchedAt: current?.fetchedAt || null,
        resolvedRevision: current?.resolvedRevision || null,
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
        this.artifacts.isSourceInUse(id)
        || this.records.isSourceInUse(id)
        || this._activationsReferenceSource(id),
    });
  }

  _activationsReferenceSource(marketplaceId: string) {
    return activationSourceIds(this.registry.getControlPlaneActivations()).includes(marketplaceId);
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
    const next = activations && typeof activations === "object" ? activations as Record<string, any> : {};
    const previous = this.registry.getControlPlaneActivations()?.agentPluginAccess || {};
    const activeNativeRefs = new Set(this.installedRuntimePluginRefs());
    for (const [agentId, identities] of Object.entries(next.agentPluginAccess || {}) as Array<[string, Record<string, any>]>) {
      for (const [identity, state] of Object.entries(identities || {}) as Array<[string, any]>) {
        const wasEnabled = (previous as any)?.[agentId]?.[identity]?.enabled === true;
        if (state?.enabled === true && !wasEnabled && !activeNativeRefs.has(identity)) {
          const err = new Error(
            `Agent Plugin Access requires an actively installed native Marketplace identity: ${identity}`,
          ) as Error & { code: string; status: number };
          err.code = "PLUGIN_MARKETPLACE_NATIVE_NOT_INSTALLED";
          err.status = 409;
          throw err;
        }
      }
    }
    return this.registry.setControlPlaneActivations(activations, {
      expectedRevision: options.expectedRevision,
      expectedDigest: options.expectedDigest,
    });
  }

  /**
   * Remove successfully migrated legacy per-skill activation records in one
   * exact registry transform. Agent configuration owns completion metadata;
   * the registry keeps no migrated tombstone that could continue to disable a
   * skill after the user re-enables it.
   */
  retireLegacyMarketplaceSkillOverrides(
    candidates: Iterable<{ agentId: string; legacyRef: string }>,
  ): {
    revision: number;
    retiredLegacyRefs: Array<{ agentId: string; legacyRef: string }>;
  } {
    const unique = new Map<string, { agentId: string; legacyRef: string }>();
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.agentId !== "string" || typeof candidate.legacyRef !== "string") continue;
      if (!candidate.agentId || !candidate.legacyRef) continue;
      const key = JSON.stringify([candidate.agentId, candidate.legacyRef]);
      if (!unique.has(key)) unique.set(key, { agentId: candidate.agentId, legacyRef: candidate.legacyRef });
    }
    const requested = [...unique.values()].sort((left, right) =>
      left.agentId.localeCompare(right.agentId) || left.legacyRef.localeCompare(right.legacyRef));

    const transformed = this.registry.mutateControlPlaneActivations((activations) => {
      const retiredLegacyRefs: Array<{ agentId: string; legacyRef: string }> = [];
      for (const { agentId, legacyRef } of requested) {
        const entries = activations.agentSkillOverrides?.[agentId];
        if (!entries || !Object.prototype.hasOwnProperty.call(entries, legacyRef)) continue;
        if (!legacyMarketplaceSkillRecordState(entries[legacyRef])) continue;
        delete entries[legacyRef];
        retiredLegacyRefs.push({ agentId, legacyRef });
      }
      if (retiredLegacyRefs.length > 0) pruneEmptySkillActivationMaps(activations);
      return {
        changed: retiredLegacyRefs.length > 0,
        result: retiredLegacyRefs,
      };
    });

    return {
      revision: transformed.revision,
      retiredLegacyRefs: transformed.result,
    };
  }

  async refreshSource(marketplaceId: string, options: {
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
    if (options.expectedRevision !== undefined || options.expectedDigest !== undefined) {
      this.assertRegistryWritePrecondition({
        expectedRevision: options.expectedRevision,
        expectedDigest: options.expectedDigest,
      });
    } else {
      this.assertRegistryUsableForAcquisition();
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

  listCatalogRows(options: { forRemote?: boolean; agentId?: string | null } = {}) {
    return this.catalog.listCatalogRows(options);
  }

  installedRuntimePluginRefs(): string[] {
    return this.catalog.installedRuntimePluginRefs();
  }

  installedMarketplaceSkillRefs(): string[] {
    return this.catalog.installedMarketplaceSkillRefs();
  }

  listInstalledSkillPackages(options: {
    userSkillsDir?: string;
  } = {}): ManagePluginsSkillPackageRow[] {
    return this.catalog.listInstalledSkillPackages(options);
  }

  /**
   * Install-record precondition shared with MarketplaceCatalogProjection:
   * reads the record for a marketplace skill package identity or throws
   * PLUGIN_MARKETPLACE_SKILLS_NOT_INSTALLED. Read-only; mutation callers
   * combine it with the registry write preconditions.
   */
  requireClaudeSkillsInstallRecord(pluginId: string, marketplaceId: string) {
    const record = readClaudeSkillsInstallRecord(this._hanakoHome, marketplaceId, pluginId);
    if (record) return record;
    const err = new Error(`Marketplace skills install record not found: ${pluginId}@${marketplaceId}`) as Error & {
      code: string;
      status: number;
    };
    err.code = "PLUGIN_MARKETPLACE_SKILLS_NOT_INSTALLED";
    err.status = 404;
    throw err;
  }

  setMarketplaceSkillPackageEnabled(
    pluginId: string,
    marketplaceId: string,
    enabled: boolean,
    options: {
      isStudioOwner?: boolean;
      expectedRevision?: number;
      expectedDigest?: string;
    } = {},
  ) {
    if (!options.isStudioOwner) {
      const err = new Error("studio.owner required to configure marketplace skill packages") as Error & {
        code: string;
        status: number;
      };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN";
      err.status = 403;
      throw err;
    }
    this.assertRegistryWritePrecondition({
      expectedRevision: options.expectedRevision,
      expectedDigest: options.expectedDigest,
    });
    this.requireClaudeSkillsInstallRecord(pluginId, marketplaceId);

    const identity = buildPluginMarketplaceRef({ pluginId, marketplaceId });
    const activations = this.registry.getControlPlaneActivations();
    const current = activations.marketplaceSkillPackages?.[identity];
    const currentEnabled = typeof current === "boolean"
      ? current
      : current && typeof current === "object" && typeof (current as any).enabled === "boolean"
        ? (current as any).enabled
        : undefined;
    if (currentEnabled === enabled) {
      const status = this.getRegistryStatus({ forRemote: true });
      return {
        pluginId,
        marketplaceId,
        identity,
        enabled,
        changed: false,
        revision: status.revision,
        digest: status.digest,
        activations,
      };
    }
    activations.marketplaceSkillPackages = {
      ...(activations.marketplaceSkillPackages || {}),
      [identity]: { enabled },
    };
    const written = this.registry.setControlPlaneActivations(activations, {
      expectedRevision: options.expectedRevision,
      expectedDigest: options.expectedDigest,
    });
    const status = this.getRegistryStatus({ forRemote: true });
    return {
      pluginId,
      marketplaceId,
      identity,
      enabled,
      changed: true,
      revision: written.revision,
      digest: status.digest,
      activations: written.activations,
    };
  }

  getMarketplaceSkillPackageUninstallFacts(
    pluginId: string,
    marketplaceId: string,
    options: { userSkillsDir?: string } = {},
  ) {
    return this.catalog.getMarketplaceSkillPackageUninstallFacts(pluginId, marketplaceId, options);
  }

  getRemovedMarketplaceSkillsPackage(pluginId: string, marketplaceId: string) {
    return this.catalog.getRemovedMarketplaceSkillsPackage(pluginId, marketplaceId);
  }

  uninstallClaudePluginSkills(
    pluginId: string,
    marketplaceId: string,
    options: {
      userSkillsDir?: string;
      isStudioOwner?: boolean;
      expectedRevision?: number;
      expectedDigest?: string;
      removeDir?: (dir: string) => void;
    } = {},
  ) {
    if (!options.isStudioOwner) {
      const err = new Error("studio.owner required to uninstall marketplace skills") as Error & {
        code: string;
        status: number;
      };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN";
      err.status = 403;
      throw err;
    }
    this.assertRegistryWritePrecondition({
      expectedRevision: options.expectedRevision,
      expectedDigest: options.expectedDigest,
    });
    const result = uninstallClaudeSkillsInstallRecord({
      hanakoHome: this._hanakoHome,
      marketplaceId,
      pluginId,
      userSkillsDir: options.userSkillsDir,
      removeDir: options.removeDir,
    });
    if (!result) {
      const err = new Error(`Marketplace skills install record not found: ${pluginId}@${marketplaceId}`) as Error & {
        code: string;
        status: number;
      };
      err.code = "PLUGIN_MARKETPLACE_SKILLS_NOT_INSTALLED";
      err.status = 404;
      throw err;
    }

    const handled = new Set([...result.deleted, ...result.alreadyMissing]);
    const activations: MarketplaceControlPlaneActivations = this.registry.getControlPlaneActivations();
    let changed = false;
    for (const skillName of handled) {
      const identity = buildMarketplaceSkillRef({ skillName, marketplaceId, pluginId });
      if (activations.marketplaceSkills && identity in activations.marketplaceSkills) {
        delete activations.marketplaceSkills[identity];
        changed = true;
      }
      for (const entries of Object.values(activations.agentSkillOverrides || {})) {
        if (entries && identity in entries) {
          delete entries[identity];
          changed = true;
        }
      }
    }
    // Full uninstall success clears the package-level gate; partial retains it.
    if (result.complete === true) {
      const packageIdentity = buildPluginMarketplaceRef({ pluginId, marketplaceId });
      if (activations.marketplaceSkillPackages?.[packageIdentity] !== undefined) {
        delete activations.marketplaceSkillPackages[packageIdentity];
        changed = true;
      }
    }
    let activationCleanupError: string | null = null;
    if (changed) {
      pruneEmptySkillActivationMaps(activations);
      try {
        this.registry.setControlPlaneActivations(activations, {
          expectedRevision: options.expectedRevision,
          expectedDigest: options.expectedDigest,
        });
      } catch (err: any) {
        activationCleanupError = err?.message || String(err);
      }
    }
    return { ...result, activationCleanupError };
  }

  getRuntimePluginActivation(pluginId: string, marketplaceId: string) {
    return this.catalog.getRuntimePluginActivation(pluginId, marketplaceId);
  }

  getMarketplaceSkillActivation(
    skillName: string,
    marketplaceId: string,
    pluginId: string,
    options: { agentId?: string | null } = {},
  ) {
    return this.catalog.getMarketplaceSkillActivation(skillName, marketplaceId, pluginId, options);
  }

  getNativeAgentPluginAccess(
    agentId: string,
    pluginId: string,
    marketplaceId: string,
    nativeContributions: Iterable<string> = [],
  ) {
    return this.catalog.getNativeAgentPluginAccess(agentId, pluginId, marketplaceId, nativeContributions);
  }

  resolveInstall(pluginId: string, marketplaceId?: string | null) {
    return this.catalog.resolveInstall(pluginId, marketplaceId);
  }

  /** Full snapshot plugin row for install/readme after resolution. */
  getCatalogPlugin(pluginId: string, marketplaceId: string) {
    return this.catalog.getCatalogPlugin(pluginId, marketplaceId);
  }

  listResolveRows(): TaggedResolveRow[] {
    return this.catalog.listResolveRows();
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
    if (
      status.state === "ok"
      || status.state === "stale"
      || (status.state === "refreshing" && this._officialSeedPromise)
    ) {
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
      expectedRevision?: number;
      expectedDigest?: string;
      expectedSourceSnapshot?: ReturnType<PluginMarketplaceService["getInstallPlanContext"]>["sourceSnapshot"];
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
    this._assertClaudeSkillsInstallPlan(marketplaceId, options);
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
    if (!source || (source.kind !== "git" && source.kind !== "local")) {
      const err = new Error(
        "Claude skills install requires a git or authorized local marketplace source",
      ) as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_INVALID";
      err.status = 400;
      throw err;
    }
    if (source.enabled === false) {
      const err = new Error(`Marketplace source is disabled: ${marketplaceId}`) as Error & {
        code: string;
        status: number;
      };
      err.code = "PLUGIN_MARKETPLACE_SOURCE_DISABLED";
      err.status = 409;
      throw err;
    }

    const {
      installClaudeSkillsFromPackage,
      writeClaudeSkillsInstallRecord,
    } = await import("./plugin-marketplace-claude-skills.ts");
    let materialized: { packageRoot: string; resolvedRevision: string | null };
    if (source.kind === "git") {
      const { materializeGitMarketplacePackage } = await import("./plugin-marketplace-git-cache.ts");
      materialized = await materializeGitMarketplacePackage(
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
          expectedRevision: options.expectedSourceSnapshot?.resolvedRevision || undefined,
        },
      );
    } else {
      const sourceRoot = resolveContainedPath({
        rootDir: this.localAllowedRoot,
        candidatePath: source.path,
        allowAbsolute: true,
      });
      materialized = {
        packageRoot: resolveContainedPath({
          rootDir: sourceRoot,
          candidatePath: packagePath,
        }),
        resolvedRevision: null,
      };
    }

    this._assertClaudeSkillsInstallPlan(marketplaceId, options);
    const expectedResolvedRevision = options.expectedSourceSnapshot?.resolvedRevision || null;
    if (expectedResolvedRevision && materialized.resolvedRevision !== expectedResolvedRevision) {
      const err = new Error("Marketplace source revision changed; create a fresh install plan") as Error & {
        code: string;
        status: number;
      };
      err.code = "PLUGIN_MARKETPLACE_PLAN_STALE";
      err.status = 409;
      throw err;
    }

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
      skillDigests: Object.fromEntries(result.installed.map((s) => [s.name, computeSkillDirSha256(s.dir)])),
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
