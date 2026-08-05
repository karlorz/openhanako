/**
 * Marketplace catalog data hook: owns the catalog payload, loading state,
 * selection state, and the per-tab agent scope used by the catalog query.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import type { MarketplaceSourceRow } from '../components/MarketplaceSourcesPanel';
import type { MarketplaceConfigDiagnostics, MarketplacePayload, MarketplacePlugin } from '../marketplace-types';

export function isSkillsTarget(target?: string | null): boolean {
  return target === 'hana-skills' || target === 'skills';
}

export function marketVersion(plugin: MarketplacePlugin): string {
  return plugin.selectedVersion || plugin.latestVersion || plugin.version || '0.0.0';
}

export function marketInstallLabel(plugin: MarketplacePlugin): string {
  if (isSkillsTarget(plugin.installTarget)) {
    if (plugin.packageInstall?.state === 'installed') return 'Uninstall skills';
    if (plugin.packageInstall?.state === 'partial') return 'Uninstall remaining skills';
    if (plugin.packageInstall?.state === 'stale-record') return 'Clear stale installation';
  }
  if (plugin.installTarget === 'native-plugin' && plugin.nativeSettingsLifecycle?.canUninstall) return 'Uninstall';
  if (plugin.installTarget === 'native-plugin' && plugin.nativeSettingsLifecycle?.canInstall) return 'Install';
  if (plugin.installTarget === 'unsupported' || (plugin.installable === false && !plugin.nativeSettingsLifecycle?.supported)) return 'Inspect only';
  if (plugin.compatible === false || plugin.installAction === 'incompatible') return t('settings.plugins.marketIncompatible');
  if (plugin.installAction === 'downgrade') return t('settings.plugins.marketDowngrade');
  if (plugin.installAction === 'reinstall') return t('settings.plugins.marketReinstall');
  if (plugin.installAction === 'update' || plugin.updateAvailable) return t('settings.plugins.marketUpdate');
  // Trust server installTarget; keep legacy "skills" for older catalog rows mid-upgrade.
  if (isSkillsTarget(plugin.installTarget)) {
    return t('settings.plugins.marketInstallSkills') || 'Install skills';
  }
  return t('settings.plugins.marketInstall');
}

export function marketTargetLabel(target?: string | null): string {
  if (isSkillsTarget(target)) return 'Hana skills';
  if (target === 'native-plugin') return 'Native plugin';
  if (target === 'unsupported') return 'Unsupported';
  return target || 'Unknown';
}

export function marketAdapterLabel(adapter?: string | null): string {
  if (adapter === 'skill-manager') return 'Skill manager';
  if (adapter === 'plugin-manager') return 'Plugin manager';
  if (adapter === 'none') return 'None';
  return adapter || 'Unknown';
}

export function marketConfirmationLabel(level?: string | null): string {
  if (level === 'typed-exact') return 'Typed exact';
  if (level === 'capability-review') return 'Capability review';
  if (level === 'inline') return 'Inline';
  return level || 'Unknown';
}

export function sourceQualifiedId(plugin: MarketplacePlugin): string {
  return plugin.marketplaceId ? `${plugin.id}@${plugin.marketplaceId}` : plugin.id;
}

export function warningMessages(plugin: MarketplacePlugin): string[] {
  const fromPlugin = Array.isArray(plugin.warnings) ? plugin.warnings : [];
  const fromPlan = Array.isArray(plugin.installPlan?.warnings) ? plugin.installPlan!.warnings! : [];
  return [...new Set([...fromPlugin, ...fromPlan].filter(Boolean))];
}

export function isInstalledSkillsPackage(plugin: MarketplacePlugin): boolean {
  return isSkillsTarget(plugin.installTarget)
    && !!plugin.packageInstall
    && plugin.packageInstall.state !== 'not-installed';
}

export function rowKey(plugin: MarketplacePlugin): string {
  return plugin.compositeKey || (plugin.marketplaceId ? `${plugin.id}@${plugin.marketplaceId}` : plugin.id);
}

function mapCatalogRow(row: any): MarketplacePlugin {
  const id = row.pluginId || row.id;
  const marketplaceId = row.marketplaceId;
  const active = !!row.active;
  const installMeta = row.install && typeof row.install === 'object' ? row.install : {};
  const catalogFormat = row.catalogFormat || installMeta.catalogFormat || null;
  // Prefer inspector-backed server canInstall; fall back only for older payloads.
  const serverCanInstall = row.canInstall === true
    || (row.canInstall == null && installMeta.canInstall === true);
  const installable = row.installable ?? installMeta.installable;
  const packageInstall = row.packageInstall || { state: 'not-installed', recorded: [], present: [], missing: [], invalid: [] };
  const installTarget = row.installTarget || installMeta.installTarget || null;
  const nativeSettingsLifecycle = row.nativeSettingsLifecycle || null;
  const isSkillsPackage = isSkillsTarget(installTarget);
  const skillsInstalled = isSkillsPackage && packageInstall.state !== 'not-installed';
  return {
    id,
    name: row.name,
    version: row.version,
    description: row.description,
    publisher: row.publisher,
    trust: row.trust,
    distribution: row.distribution,
    marketplaceId,
    compositeKey: row.compositeKey || (marketplaceId ? `${id}@${marketplaceId}` : id),
    sourceAuthority: row.sourceAuthority,
    sourceStatus: row.sourceStatus,
    sourceEnabled: row.sourceEnabled,
    sourceSnapshot: row.sourceSnapshot,
    available: row.available,
    active,
    retained: row.retained,
    installed: isSkillsPackage ? skillsInstalled : active,
    canInstall: installTarget === 'native-plugin'
      ? nativeSettingsLifecycle?.canInstall === true
      : isSkillsPackage
      ? serverCanInstall && installable !== false && packageInstall.state === 'not-installed' && row.available !== false
      : serverCanInstall && installable !== false && !active,
    installAction: isSkillsPackage
      ? (packageInstall.state === 'not-installed' ? 'install' : 'reinstall')
      : (installTarget === 'native-plugin' && nativeSettingsLifecycle?.supported
          ? (active ? 'reinstall' : 'install')
          : (installable === false ? 'incompatible' : (active ? 'reinstall' : 'install'))),
    compatible: installable === false && !nativeSettingsLifecycle?.supported ? false : true,
    catalogFormat,
    installTarget,
    installAdapter: row.installAdapter || installMeta.installAdapter || null,
    installable: installable == null ? serverCanInstall : !!installable,
    confirmationLevel: row.confirmationLevel || installMeta.confirmationLevel || null,
    capabilityInventory: row.capabilityInventory || installMeta.capabilityInventory || null,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    installPlan: row.installPlan || null,
    runtimeActivation: row.runtimeActivation || null,
    marketplaceSkillActivations: Array.isArray(row.marketplaceSkillActivations) ? row.marketplaceSkillActivations : [],
    packageInstall,
    packageActivation: row.packageActivation || null,
    nativeAgentPluginAccess: row.nativeAgentPluginAccess || null,
    nativeSettingsLifecycle,
  };
}

/** Effective package enable gate for installed Hana-skill packages. */
export function packageGateEnabled(
  plugin: MarketplacePlugin,
  activations?: Record<string, any> | null,
): boolean {
  if (plugin.packageActivation && typeof plugin.packageActivation.enabled === 'boolean') {
    return plugin.packageActivation.enabled === true;
  }
  const identity = sourceQualifiedId(plugin);
  const packages = activations?.marketplaceSkillPackages;
  if (packages && Object.prototype.hasOwnProperty.call(packages, identity)) {
    return packages[identity]?.enabled === true;
  }
  // Installed-default when no packageActivation / no record.
  return true;
}

export interface MarketplaceDataState {
  marketplace: MarketplacePayload | null;
  loading: boolean;
  loadMarketplace: (opts?: { silent?: boolean }) => Promise<void>;
  selectedPlugin: MarketplacePlugin | null;
  selectPlugin: (plugin: MarketplacePlugin | null) => void;
  selectedAgentId: string | null;
  setSelectedAgentId: (agentId: string | null) => void;
  /** Patch every catalog row with the given key and the selected plugin when it matches. */
  updateMarketplacePlugin: (key: string, patch: (plugin: MarketplacePlugin) => MarketplacePlugin) => void;
  rowCount: number;
}

export function useMarketplaceData(): MarketplaceDataState {
  const showToast = useSettingsStore(s => s.showToast);
  const currentAgentId = useSettingsStore(s => s.currentAgentId);
  const settingsAgentId = useSettingsStore(s => s.settingsAgentId);
  const [marketplace, setMarketplace] = useState<MarketplacePayload | null>(null);
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [selectedPlugin, setSelectedPlugin] = useState<MarketplacePlugin | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(settingsAgentId || currentAgentId || null);
  const loadGenRef = React.useRef(0);

  useEffect(() => {
    if (!selectedAgentId && (settingsAgentId || currentAgentId)) {
      setSelectedAgentId(settingsAgentId || currentAgentId);
    }
  }, [currentAgentId, selectedAgentId, settingsAgentId]);

  const loadMarketplace = useCallback(async (opts: { silent?: boolean } = {}) => {
    const gen = ++loadGenRef.current;
    if (!opts.silent) setMarketplaceLoading(true);
    try {
      // Fetch independently so one slow/failing call does not wipe the other.
      let plugins: MarketplacePlugin[] = [];
      let sources: MarketplaceSourceRow[] = [];
      let source: MarketplacePayload['source'] = {};
      let warnings: string[] = [];
      let multiOk = false;
      let capabilities: MarketplacePayload['capabilities'] = null;
      let access: MarketplacePayload['access'] = null;
      let registry: MarketplacePayload['registry'] = null;
      let configDiagnostics: MarketplaceConfigDiagnostics | null = null;
      let compatibilityBindings: MarketplacePayload['compatibilityBindings'] = [];
      let compatibilityRequest: Promise<Record<string, any> | null> | null = null;

      const requestCompatibilityBindings = () => hanaFetch(
        '/api/plugins/marketplace/compatibility/bindings',
        { timeout: 15_000 },
      )
        .then((res) => res.json().catch(() => ({})))
        .catch(() => null);

      try {
        const capabilityRes = await hanaFetch('/api/plugins/marketplace/capabilities', { timeout: 15_000 });
        const capabilityData = await capabilityRes.json().catch(() => ({}));
        capabilities = capabilityData || null;
        access = capabilityData?.access || null;
        if (capabilityData?.registry) registry = capabilityData.registry;
        if (capabilityData?.configDiagnostics) configDiagnostics = capabilityData.configDiagnostics;
        const capabilityError = String(capabilityData?.error || capabilityData?.message || '');
        if (
          capabilityData?.supported === false
          || capabilityData?.code === 'PLUGIN_MARKETPLACE_UNSUPPORTED_SERVER'
          || capabilityRes.status === 404
          || capabilityRes.status === 405
          || /not found/i.test(capabilityError)
        ) {
          const guidance = capabilityData.upgradeGuidance || capabilityData.message || 'Upgrade the connected Hana server to use marketplace sources.';
          if (gen !== loadGenRef.current) return;
          setMarketplace({
            source: {},
            sources: [],
            plugins: [],
            warnings: [guidance],
            capabilities,
            access,
            registry,
            configDiagnostics,
            compatibilityBindings,
          });
          return;
        }
        if (capabilities?.features?.claudeCompatibilityBindings) {
          compatibilityRequest = requestCompatibilityBindings();
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/404|405|not found/i.test(msg)) {
          if (gen !== loadGenRef.current) return;
          setMarketplace({
            source: {},
            sources: [],
            plugins: [],
            warnings: ['The connected Hana server does not advertise plugin marketplace capabilities. Upgrade the server before managing marketplace sources.'],
            capabilities: {
              supported: false,
              code: 'PLUGIN_MARKETPLACE_UNSUPPORTED_SERVER',
              upgradeGuidance: 'Upgrade the connected Hana server to a build with plugin-marketplace-capabilities.v1.',
            },
            access: null,
            registry: null,
            configDiagnostics: null,
            compatibilityBindings: [],
          });
          return;
        }
      }

      try {
        const catalogQuery = selectedAgentId ? `?agentId=${encodeURIComponent(selectedAgentId)}` : '';
        const catalogRes = await hanaFetch(`/api/plugins/marketplace/catalog${catalogQuery}`, { timeout: 45_000 });
        const data = await catalogRes.json();
        if (Array.isArray(data.plugins)) {
          plugins = data.plugins.map(mapCatalogRow);
          multiOk = true;
        }
        if (Array.isArray(data.sources)) {
          sources = data.sources;
        }
        if (Array.isArray(data.warnings)) warnings = data.warnings;
        if (data.capabilities) capabilities = data.capabilities;
        if (data.access) access = data.access;
        if (data.registry) registry = data.registry;
        if (data.configDiagnostics) configDiagnostics = data.configDiagnostics;
      } catch {
        // fall through to legacy
      }

      if (!sources.length) {
        try {
          const sourcesRes = await hanaFetch('/api/plugins/marketplace/sources', { timeout: 45_000 });
          const srcData = await sourcesRes.json();
          if (Array.isArray(srcData.sources)) sources = srcData.sources;
          if (srcData.capabilities) capabilities = srcData.capabilities;
          if (srcData.access) access = srcData.access;
          if (srcData.registry) registry = srcData.registry;
        } catch {
          // keep empty; multi catalog may still have plugins
        }
      }

      if (!multiOk) {
        const res = await hanaFetch('/api/plugins/marketplace', { timeout: 45_000 });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        plugins = Array.isArray(data.plugins) ? data.plugins : [];
        source = data.source || {};
        if (Array.isArray(data.warnings)) warnings = data.warnings;
      } else if (sources.length) {
        source = { kind: 'multi', configured: true };
      }

      if (capabilities?.features?.claudeCompatibilityBindings) {
        const compatibilityData = await (compatibilityRequest || requestCompatibilityBindings());
        if (compatibilityData) {
          if (Array.isArray(compatibilityData.bindings)) compatibilityBindings = compatibilityData.bindings;
          if (compatibilityData.access) access = compatibilityData.access;
        }
      }

      if (gen !== loadGenRef.current) return;

      const next = {
        source: source || {},
        sources,
        plugins,
        warnings: [
          ...warnings,
          ...(registry?.degraded && registry.diagnostic
            ? [`Marketplace registry is using the last-known-good state: ${registry.diagnostic}`]
            : []),
        ],
        capabilities,
        access,
        registry,
        configDiagnostics,
        compatibilityBindings,
      };
      setMarketplace(next);

      // Select first plugin without blocking list load on README network.
      if (plugins.length > 0) {
        setSelectedPlugin((prev) => {
          const retainedSelection = prev
            ? plugins.find((plugin) => rowKey(plugin) === rowKey(prev))
            : undefined;
          return retainedSelection || plugins[0];
        });
      } else {
        setSelectedPlugin(null);
      }
    } catch (err: unknown) {
      if (gen !== loadGenRef.current) return;
      // Keep prior plugins if we already showed some — avoid flash-to-empty on flaky fetch.
      setMarketplace((prev) => prev || { source: {}, plugins: [], sources: [], warnings: [] });
      const msg = err instanceof Error ? err.message : String(err);
      // Soft: do not toast transient network abort/fetch noise if list may still be usable
      if (!/abort|The user aborted|Failed to fetch/i.test(msg)) {
        showToast(t('settings.plugins.marketLoadError') + ': ' + msg, 'error');
      }
    } finally {
      if (gen === loadGenRef.current) setMarketplaceLoading(false);
    }
  }, [selectedAgentId, showToast]);

  useEffect(() => {
    void loadMarketplace();
  }, [loadMarketplace]);

  const updateMarketplacePlugin = useCallback((
    key: string,
    patch: (plugin: MarketplacePlugin) => MarketplacePlugin,
  ) => {
    setMarketplace((prev) => {
      if (!prev) return prev;
      return { ...prev, plugins: prev.plugins.map(p => (rowKey(p) === key ? patch(p) : p)) };
    });
    setSelectedPlugin((prev) => (prev && rowKey(prev) === key ? patch(prev) : prev));
  }, []);

  return {
    marketplace,
    loading: marketplaceLoading,
    loadMarketplace,
    selectedPlugin,
    selectPlugin: setSelectedPlugin,
    selectedAgentId,
    setSelectedAgentId,
    updateMarketplacePlugin,
    rowCount: marketplace?.plugins?.length || 0,
  };
}
