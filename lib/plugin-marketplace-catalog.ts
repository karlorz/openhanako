import path from "path";
import type { PluginMarketplaceSourceRegistry } from "./plugin-marketplace-sources.ts";
import type { MarketplaceSnapshotStore } from "./plugin-marketplace-snapshots.ts";
import type { PluginInstallRecords } from "./plugin-install-records.ts";
import type { PluginArtifactStore } from "./plugin-artifact-store.ts";
import type { PluginMarketplaceService } from "./plugin-marketplace-service.ts";
import {
  resolveMarketplacePlugin,
  type MarketplaceResolveSourceCoverage,
  type TaggedResolveRow,
} from "./plugin-marketplace-resolve.ts";
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
  computeMarketplaceSkillPackageActivation,
  computeNativeAgentPluginAccess,
  computeRuntimePluginActivation,
} from "./plugin-marketplace-activation.ts";
import {
  listClaudeSkillsInstallRecords,
  readClaudeSkillsInstallRecord,
  reconcileClaudeSkillsInstall,
  type ClaudeSkillsInstallState,
} from "./plugin-marketplace-claude-skills.ts";
import type { TaggedMarketplacePlugin } from "./plugin-marketplace-schema.ts";

/** Inventory row for Settings → Plugins → Manage Plugins (marketplace skill packages). */
export type ManagePluginsSkillPackageState = Exclude<ClaudeSkillsInstallState, "not-installed">;

export interface ManagePluginsSkillPackageRow {
  kind: "marketplace-skill-package";
  identity: string;
  pluginId: string;
  marketplaceId: string;
  name: string;
  version: string | null;
  description: string | null;
  packageState: ManagePluginsSkillPackageState;
  packageEnabled: boolean;
  packageGateRecorded: boolean;
  packageGateState: string;
  skillNames: string[];
  skillCount: number;
  missingSkillNames: string[];
  invalidSkillNames: string[];
  sourceStatus: "ok" | "disabled" | "removed";
  installAdapter: "skill-manager";
  installTarget: "hana-skills";
  actions: {
    canToggle: boolean;
    canUninstall: boolean;
    canOpenSkills: boolean;
    canReinstall: boolean;
  };
}

/**
 * Read-path catalog/inventory/resolution/activation projection of the marketplace
 * service. Holds no write access: mutations, registry asserts, diagnostics, compat
 * delegations and seeding stay on PluginMarketplaceService. The projection reads
 * shared context back through the service reference (install-plan context, listed
 * sources with catalog counts, registry status, install-record preconditions).
 */
export class MarketplaceCatalogProjection {
  declare registry: PluginMarketplaceSourceRegistry;
  declare snapshots: MarketplaceSnapshotStore;
  declare records: PluginInstallRecords;
  declare artifacts: PluginArtifactStore;
  declare service: PluginMarketplaceService;

  constructor(options: {
    registry: PluginMarketplaceSourceRegistry;
    snapshots: MarketplaceSnapshotStore;
    records: PluginInstallRecords;
    artifacts: PluginArtifactStore;
    service: PluginMarketplaceService; // for getInstallPlanContext/listSources/getRegistryStatus/requireClaudeSkillsInstallRecord
  }) {
    this.registry = options.registry;
    this.snapshots = options.snapshots;
    this.records = options.records;
    this.artifacts = options.artifacts;
    this.service = options.service;
  }

  /** hanakoHome is owned by the service; the projection reads it through the service reference. */
  private get _hanakoHome(): string {
    return this.service._hanakoHome;
  }

  listCatalogRows(options: { forRemote?: boolean; agentId?: string | null } = {}) {
    const snapshotPlugins = this.snapshots.listCurrentPlugins();
    const sources = this.service.listSources({ forRemote: options.forRemote });
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const records = listClaudeSkillsInstallRecords(this._hanakoHome);
    const userSkillsDir = path.join(this._hanakoHome, "skills");
    const packageInstallByKey = new Map(records.map((record) => [
      buildPluginMarketplaceRef({ pluginId: record.pluginId, marketplaceId: record.marketplaceId }),
      reconcileClaudeSkillsInstall(record, userSkillsDir),
    ]));
    const snapshotKeys = new Set(snapshotPlugins.map((plugin) => buildPluginMarketplaceRef({
      pluginId: plugin.id,
      marketplaceId: plugin.marketplaceId,
    })));
    const orphanPlugins = records
      .filter((record) => !snapshotKeys.has(buildPluginMarketplaceRef({
        pluginId: record.pluginId,
        marketplaceId: record.marketplaceId,
      })))
      .map((record): TaggedMarketplacePlugin => ({
        schemaVersion: 1,
        id: record.pluginId,
        marketplaceId: record.marketplaceId,
        name: record.pluginId,
        publisher: record.marketplaceId,
        version: "unknown",
        description: "Marketplace source removed; installed skill record remains available for cleanup.",
        license: null,
        categories: [],
        keywords: [],
        homepage: null,
        repository: null,
        compatibility: {},
        trust: "restricted",
        permissions: [],
        contributions: [],
        distribution: null,
        versions: [],
        install: {
          catalogFormat: "claude",
          sourceKind: "relative",
          source: record.packagePath,
          canInstall: false,
        },
        screenshots: [],
        readme: null,
        readmePath: null,
        readmeUrl: null,
      }));
    const plugins = [
      ...snapshotPlugins.filter((plugin) =>
        sourceById.has(plugin.marketplaceId)
        || packageInstallByKey.has(buildPluginMarketplaceRef({
          pluginId: plugin.id,
          marketplaceId: plugin.marketplaceId,
        }))),
      ...orphanPlugins,
    ];
    const activations = this.registry.getControlPlaneActivations();
    const installedRuntimePluginRefs = this.installedRuntimePluginRefs();
    const installedMarketplaceSkillRefs = records.flatMap((record) => {
      const packageInstall = packageInstallByKey.get(buildPluginMarketplaceRef({
        pluginId: record.pluginId,
        marketplaceId: record.marketplaceId,
      }));
      return (packageInstall?.present || []).map((skillName) => buildMarketplaceSkillRef({
        skillName,
        marketplaceId: record.marketplaceId,
        pluginId: record.pluginId,
      }));
    }).sort();
    const rows = plugins.map((plugin) => {
      const source = sourceById.get(plugin.marketplaceId);
      const sourceAvailable = Boolean(source && source.enabled !== false);
      const sourceRemoved = !source;
      const packageInstall = packageInstallByKey.get(buildPluginMarketplaceRef({
        pluginId: plugin.id,
        marketplaceId: plugin.marketplaceId,
      })) || reconcileClaudeSkillsInstall(null, userSkillsDir);
      const install = this.records.get(plugin.id);
      const active = install?.activeMarketplaceId === plugin.marketplaceId;
      const retained = Boolean(install?.retained?.[plugin.marketplaceId]);
      const installMeta = plugin.install && typeof plugin.install === "object"
        ? plugin.install as Record<string, unknown>
        : {};
      const inspected = inspectMarketplacePackage(plugin);
      const uninstallOnly = packageInstall.state !== "not-installed"
        && (sourceRemoved || inspected.destination !== "hana-skills");
      const inspection = uninstallOnly
        ? {
            ...inspected,
            destination: "hana-skills" as const,
            installAdapter: "skill-manager" as const,
            installable: false,
            warnings: [
              ...inspected.warnings,
              sourceRemoved
                ? "marketplace source was removed; reinstall is unavailable until the source is added again"
                : "marketplace snapshot is unavailable; only installed-skill cleanup is available",
            ],
          }
        : inspected;
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
      const packageActivation = computeMarketplaceSkillPackageActivation({
        identity: runtimeIdentity,
        activations,
        sources,
        installedPresent: packageInstall.state !== "not-installed",
      });
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
      const nativeInstallEligible = inspection.destination === "native-plugin"
        && plugin.distribution?.kind === "release"
        && typeof plugin.distribution?.packageUrl === "string"
        && /^[a-f0-9]{64}$/.test(plugin.distribution?.sha256 || "")
        && !sourceRemoved
        && sourceAvailable;
      const nativeLifecycleSupported = inspection.destination === "native-plugin"
        && (nativeInstallEligible || active);
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
        packageActivation,
        packageInstall,
        nativeAgentPluginAccess,
        nativeSettingsLifecycle: inspection.destination === "native-plugin" ? {
          supported: nativeLifecycleSupported,
          canInstall: nativeInstallEligible && !active,
          canUninstall: active,
          reason: nativeLifecycleSupported
            ? (active ? "Exact Marketplace-native identity is actively installed" : "Studio-owner Settings install is available")
            : "Native Settings lifecycle is unavailable for this package or source",
        } : null,
        canInstall: inspection.destination === "native-plugin"
          ? nativeInstallEligible && !active
          : inspection.installable
            && packageInstall.state === "not-installed"
            && !sourceRemoved
            && sourceAvailable,
        sourceAuthority: source?.authority || "removed",
        sourceStatus: source?.status || "removed",
        sourceEnabled: sourceAvailable,
        sourceSnapshot: this.service.getInstallPlanContext(plugin.marketplaceId).sourceSnapshot,
        active,
        retained,
        available: sourceAvailable,
      };
    });
    return { sources, plugins: rows };
  }

  installedRuntimePluginRefs(): string[] {
    const refs = new Set<string>();
    for (const record of this.records.list()) {
      if (!record.activeMarketplaceId || record.activeMarketplaceId === "legacy-unqualified") continue;
      refs.add(buildPluginMarketplaceRef({
        pluginId: record.pluginId,
        marketplaceId: record.activeMarketplaceId,
      }));
    }
    return [...refs].sort();
  }

  installedMarketplaceSkillRefs(): string[] {
    const refs: string[] = [];
    for (const record of listClaudeSkillsInstallRecords(this._hanakoHome)) {
      const reconciled = reconcileClaudeSkillsInstall(record, path.join(this._hanakoHome, "skills"));
      for (const skillName of reconciled.present) {
        refs.push(buildMarketplaceSkillRef({
          skillName,
          marketplaceId: record.marketplaceId,
          pluginId: record.pluginId,
        }));
      }
    }
    return refs.sort();
  }

  /**
   * Inventory of installed Claude/marketplace skill packages for Manage Plugins.
   * Only packages with reconciled state in {installed, partial, stale-record}.
   * Never converts packages into native plugins.
   */
  listInstalledSkillPackages(options: {
    userSkillsDir?: string;
  } = {}): ManagePluginsSkillPackageRow[] {
    const userSkillsDir = options.userSkillsDir || path.join(this._hanakoHome, "skills");
    const sources = this.registry.listSources();
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const activations = this.registry.getControlPlaneActivations();
    const catalogByIdentity = new Map(
      this.snapshots.listCurrentPlugins().map((plugin) => [
        buildPluginMarketplaceRef({ pluginId: plugin.id, marketplaceId: plugin.marketplaceId }),
        plugin,
      ]),
    );
    const rows: ManagePluginsSkillPackageRow[] = [];

    for (const record of listClaudeSkillsInstallRecords(this._hanakoHome)) {
      const reconciled = reconcileClaudeSkillsInstall(record, userSkillsDir);
      if (
        reconciled.state !== "installed"
        && reconciled.state !== "partial"
        && reconciled.state !== "stale-record"
      ) {
        continue;
      }

      const identity = buildPluginMarketplaceRef({
        pluginId: record.pluginId,
        marketplaceId: record.marketplaceId,
      });
      const source = sourceById.get(record.marketplaceId);
      let sourceStatus: ManagePluginsSkillPackageRow["sourceStatus"];
      if (!source) sourceStatus = "removed";
      else if (source.enabled === false) sourceStatus = "disabled";
      else sourceStatus = "ok";

      // Listed rows are only installed/partial/stale-record ⇒ present for package gate.
      const packageGate = computeMarketplaceSkillPackageActivation({
        identity,
        activations,
        sources,
        installedPresent: true,
      });

      const catalog = catalogByIdentity.get(identity) || null;
      const name = (catalog?.name && typeof catalog.name === "string" && catalog.name.trim())
        ? catalog.name
        : record.pluginId;
      const version = catalog?.version != null && catalog.version !== ""
        ? String(catalog.version)
        : null;
      const description = catalog?.description != null && catalog.description !== ""
        ? String(catalog.description)
        : null;

      const skillNames = [...reconciled.present].sort((a, b) => a.localeCompare(b));
      const skillCount = skillNames.length;

      rows.push({
        kind: "marketplace-skill-package",
        identity,
        pluginId: record.pluginId,
        marketplaceId: record.marketplaceId,
        name,
        version,
        description,
        packageState: reconciled.state,
        packageEnabled: packageGate.enabled,
        packageGateRecorded: packageGate.recorded,
        packageGateState: packageGate.state,
        skillNames,
        skillCount,
        missingSkillNames: [...reconciled.missing],
        invalidSkillNames: [...reconciled.invalid],
        sourceStatus,
        installAdapter: "skill-manager",
        installTarget: "hana-skills",
        actions: {
          // Owner check is route-layer; service allows toggle whenever the package is listed
          // (including source-removed packages that remain for cleanup).
          canToggle: true,
          canUninstall: true,
          canOpenSkills: skillCount > 0,
          canReinstall: sourceStatus === "ok",
        },
      });
    }

    return rows.sort((a, b) =>
      a.name.localeCompare(b.name)
      || a.identity.localeCompare(b.identity)
    );
  }

  getMarketplaceSkillPackageUninstallFacts(
    pluginId: string,
    marketplaceId: string,
    options: { userSkillsDir?: string } = {},
  ) {
    const record = this.service.requireClaudeSkillsInstallRecord(pluginId, marketplaceId);
    const userSkillsDir = options.userSkillsDir || path.join(this._hanakoHome, "skills");
    const reconciled = reconcileClaudeSkillsInstall(record, userSkillsDir);
    const identity = buildPluginMarketplaceRef({ pluginId, marketplaceId });
    const recordedSkills = [...record.skills].sort((a, b) => a.localeCompare(b));
    const presentSkills = [...reconciled.present].sort((a, b) => a.localeCompare(b));
    const missingSkills = [...reconciled.missing].sort((a, b) => a.localeCompare(b));
    const invalidSkills = [...reconciled.invalid].sort((a, b) => a.localeCompare(b));
    const invalidSet = new Set(invalidSkills);
    const cleanupTargets = recordedSkills.filter((skillName) => !invalidSet.has(skillName));
    const activations = this.registry.getControlPlaneActivations();
    const marketplaceSkills = cleanupTargets
      .map((skillName) => buildMarketplaceSkillRef({ skillName, marketplaceId, pluginId }))
      .filter((skillIdentity) => activations.marketplaceSkills?.[skillIdentity] !== undefined)
      .sort((a, b) => a.localeCompare(b));
    const agentSkillOverrides = Object.entries(activations.agentSkillOverrides || {})
      .flatMap(([agentId, entries]) => marketplaceSkills
        .filter((skillIdentity) => entries?.[skillIdentity] !== undefined)
        .map((skillIdentity) => ({ agentId, skillIdentity })))
      .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.skillIdentity.localeCompare(b.skillIdentity));
    const source = this.registry.listSources().find((item) => item.id === marketplaceId);

    return {
      pluginId,
      marketplaceId,
      identity,
      state: reconciled.state,
      recordedSkills,
      presentSkills,
      missingSkills,
      invalidSkills,
      cleanupTargets,
      activationReferences: {
        packageGate: activations.marketplaceSkillPackages?.[identity] !== undefined ? identity : null,
        marketplaceSkills,
        agentSkillOverrides,
      },
      packageGateCleanupExpected: invalidSkills.length === 0,
      sourceStatus: !source ? "removed" : source.enabled === false ? "disabled" : "ok",
      registry: this.service.getRegistryStatus({ forRemote: true }),
    };
  }

  getRemovedMarketplaceSkillsPackage(pluginId: string, marketplaceId: string) {
    if (this.registry.listSources().some((source) => source.id === marketplaceId)) return null;
    const record = readClaudeSkillsInstallRecord(this._hanakoHome, marketplaceId, pluginId);
    if (!record) return null;
    const snapshot = this.getCatalogPlugin(pluginId, marketplaceId);
    return {
      description: snapshot?.description
        || "Marketplace source removed; installed skill record remains available for cleanup.",
      packageInstall: reconcileClaudeSkillsInstall(record, path.join(this._hanakoHome, "skills")),
    };
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
      const usable = source.enabled !== false && (
        status.state === "ok" || status.state === "stale"
        || (status.state === "refreshing" && !!status.current)
      );
      return {
        sourceId: source.id,
        authority: source.authority,
        usable,
      };
    });
  }
}
