import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { SettingsSection } from '../components/SettingsSection';
import { MarketplaceSourcesPanel, type MarketplaceSourceRow } from '../components/MarketplaceSourcesPanel';
import { renderMarkdown } from '../../utils/markdown';
import styles from '../Settings.module.css';

interface MarketplacePlugin {
  id: string;
  name: string;
  publisher?: string;
  version?: string;
  description?: string;
  trust?: 'restricted' | 'full-access';
  permissions?: string[];
  contributions?: string[];
  repository?: string | null;
  compatibility?: { minAppVersion?: string; hanaApi?: string };
  distribution?: { kind?: 'source' | 'release'; path?: string; packageUrl?: string; sha256?: string } | null;
  installed?: boolean;
  installedVersion?: string | null;
  latestVersion?: string | null;
  selectedVersion?: string | null;
  updateAvailable?: boolean;
  downgrade?: boolean;
  reinstall?: boolean;
  compatible?: boolean;
  canInstall?: boolean;
  installAction?: 'install' | 'update' | 'downgrade' | 'reinstall' | 'incompatible';
  /** Multi-source composite fields (Approach 1). */
  marketplaceId?: string;
  compositeKey?: string;
  sourceAuthority?: 'official' | 'custom' | 'legacy';
  sourceStatus?: string;
  active?: boolean;
  retained?: boolean;
  catalogFormat?: string | null;
  installTarget?: string | null;
  installAdapter?: string | null;
  installable?: boolean;
  confirmationLevel?: 'inline' | 'capability-review' | 'typed-exact' | string | null;
  capabilityInventory?: {
    skills?: string[];
    nativePluginContributions?: string[];
    agentFacing?: string[];
    serverImpact?: string[];
    unsupportedClaudeComponents?: string[];
  } | null;
  warnings?: string[];
  installPlan?: {
    action?: string;
    destination?: string;
    installAdapter?: string;
    confirmationLevel?: string;
    warnings?: string[];
    installable?: boolean;
  } | null;
  runtimeActivation?: { state?: string; reason?: string | null; enabled?: boolean } | null;
  marketplaceSkillActivations?: Array<{ identity?: string; state?: string; reason?: string | null; enabled?: boolean }>;
  nativeAgentPluginAccess?: {
    identity?: string;
    agentId?: string;
    enabled?: boolean;
    state?: string;
    reason?: string | null;
    allowedContributions?: string[];
    requestedContributions?: string[];
    serverGlobalContributions?: string[];
    warnings?: string[];
  } | null;
}

interface MarketplaceConfigDiagnostics {
  ok?: boolean;
  degraded?: boolean;
  path?: string;
  digest?: string | null;
  file?: { revision?: number; activations?: Record<string, any>; claudeCompatibility?: unknown } | null;
  diagnostics?: Array<{ severity?: string; code?: string; path?: string; message?: string }>;
  summary?: { revision?: number | null; schemaVersion?: number | null };
}

interface ClaudeCompatibilityStatus {
  binding: {
    id: string;
    mode: 'live' | 'mirror' | 'snapshot' | string;
    enabled: boolean;
    inputs?: Array<{ role?: string; path?: string }>;
  };
  state?: {
    digest?: string;
    generatedAt?: string;
    warnings?: Array<{ code?: string; category?: string; message?: string }>;
    packages?: Array<{ identity?: string; state?: string; classification?: string }>;
    virtualSources?: Array<{ id?: string; identity?: string }>;
  } | null;
  lastKnownGood?: boolean;
  diagnostic?: { code?: string; message?: string; graceExpired?: boolean } | null;
  pendingBoundary?: string | null;
}

interface MarketplaceResponse {
  source?: { kind?: string; configured?: boolean; path?: string; url?: string };
  plugins: MarketplacePlugin[];
  warnings?: string[];
  sources?: MarketplaceSourceRow[];
  capabilities?: {
    supported?: boolean;
    code?: string;
    message?: string;
    upgradeGuidance?: string | null;
    features?: Record<string, boolean>;
  } | null;
  access?: {
    isStudioOwner?: boolean;
    isLocalOwner?: boolean;
    connectionKind?: string;
  } | null;
  registry?: {
    revision?: number;
    digest?: string;
    path?: string;
    degraded?: boolean;
    diagnostic?: string | null;
    lastKnownGood?: boolean;
  } | null;
  configDiagnostics?: MarketplaceConfigDiagnostics | null;
  compatibilityBindings?: ClaudeCompatibilityStatus[];
}

function marketVersion(plugin: MarketplacePlugin): string {
  return plugin.selectedVersion || plugin.latestVersion || plugin.version || '0.0.0';
}

function marketInstallLabel(plugin: MarketplacePlugin): string {
  if (plugin.installTarget === 'unsupported' || plugin.installable === false) return 'Inspect only';
  if (plugin.compatible === false || plugin.installAction === 'incompatible') return t('settings.plugins.marketIncompatible');
  if (plugin.installAction === 'downgrade') return t('settings.plugins.marketDowngrade');
  if (plugin.installAction === 'reinstall') return t('settings.plugins.marketReinstall');
  if (plugin.installAction === 'update' || plugin.updateAvailable) return t('settings.plugins.marketUpdate');
  // Trust server installTarget; keep legacy "skills" for older catalog rows mid-upgrade.
  if (plugin.installTarget === 'hana-skills' || plugin.installTarget === 'skills') {
    return t('settings.plugins.marketInstallSkills') || 'Install skills';
  }
  return t('settings.plugins.marketInstall');
}

function marketTargetLabel(target?: string | null): string {
  if (target === 'hana-skills' || target === 'skills') return 'Hana skills';
  if (target === 'native-plugin') return 'Native plugin';
  if (target === 'unsupported') return 'Unsupported';
  return target || 'Unknown';
}

function marketAdapterLabel(adapter?: string | null): string {
  if (adapter === 'skill-manager') return 'Skill manager';
  if (adapter === 'plugin-manager') return 'Plugin manager';
  if (adapter === 'none') return 'None';
  return adapter || 'Unknown';
}

function marketConfirmationLabel(level?: string | null): string {
  if (level === 'typed-exact') return 'Typed exact';
  if (level === 'capability-review') return 'Capability review';
  if (level === 'inline') return 'Inline';
  return level || 'Unknown';
}

function sourceQualifiedId(plugin: MarketplacePlugin): string {
  return plugin.marketplaceId ? `${plugin.id}@${plugin.marketplaceId}` : plugin.id;
}

function warningMessages(plugin: MarketplacePlugin): string[] {
  const fromPlugin = Array.isArray(plugin.warnings) ? plugin.warnings : [];
  const fromPlan = Array.isArray(plugin.installPlan?.warnings) ? plugin.installPlan!.warnings! : [];
  return [...new Set([...fromPlugin, ...fromPlan].filter(Boolean))];
}

function inventoryGroups(plugin: MarketplacePlugin): Array<{ key: string; label: string; values: string[] }> {
  const inv = plugin.capabilityInventory || {};
  return [
    { key: 'skills', label: 'Skills', values: inv.skills || [] },
    { key: 'agentFacing', label: 'Agent-facing', values: inv.agentFacing || [] },
    { key: 'serverImpact', label: 'Server impact', values: inv.serverImpact || [] },
    { key: 'nativePluginContributions', label: 'Native contributions', values: inv.nativePluginContributions || [] },
    { key: 'unsupportedClaudeComponents', label: 'Unsupported Claude components', values: inv.unsupportedClaudeComponents || [] },
  ].filter(group => group.values.length > 0);
}

function marketVersionStatus(plugin: MarketplacePlugin): string | null {
  if (plugin.installTarget === 'unsupported' || plugin.installable === false) return 'Unsupported package';
  if (plugin.compatible === false || plugin.installAction === 'incompatible') return t('settings.plugins.marketIncompatible');
  if (plugin.installAction === 'downgrade') {
    return t('settings.plugins.marketDowngradeTo', { version: marketVersion(plugin) });
  }
  if (plugin.updateAvailable && plugin.installedVersion) {
    return t('settings.plugins.marketUpdateFrom', {
      from: plugin.installedVersion,
      to: marketVersion(plugin),
    });
  }
  if (plugin.installedVersion) return t('settings.plugins.marketInstalledVersion', { version: plugin.installedVersion });
  return null;
}

function rowKey(plugin: MarketplacePlugin): string {
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
    active,
    retained: row.retained,
    installed: active,
    canInstall: serverCanInstall && installable !== false && !active,
    installAction: installable === false ? 'incompatible' : (active ? 'reinstall' : 'install'),
    compatible: installable === false ? false : true,
    catalogFormat,
    installTarget: row.installTarget || installMeta.installTarget || null,
    installAdapter: row.installAdapter || installMeta.installAdapter || null,
    installable: installable == null ? serverCanInstall : !!installable,
    confirmationLevel: row.confirmationLevel || installMeta.confirmationLevel || null,
    capabilityInventory: row.capabilityInventory || installMeta.capabilityInventory || null,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    installPlan: row.installPlan || null,
    runtimeActivation: row.runtimeActivation || null,
    marketplaceSkillActivations: Array.isArray(row.marketplaceSkillActivations) ? row.marketplaceSkillActivations : [],
    nativeAgentPluginAccess: row.nativeAgentPluginAccess || null,
  };
}

function confirmInstallPlan(plugin: MarketplacePlugin): boolean {
  const warnings = warningMessages(plugin);
  const level = plugin.confirmationLevel || plugin.installPlan?.confirmationLevel || 'inline';
  const planLines = [
    `${sourceQualifiedId(plugin)}`,
    `Target: ${marketTargetLabel(plugin.installTarget || plugin.installPlan?.destination)}`,
    `Adapter: ${marketAdapterLabel(plugin.installAdapter || plugin.installPlan?.installAdapter)}`,
    `Confirmation: ${marketConfirmationLabel(level)}`,
    warnings.length ? `Warnings:\n${warnings.map(w => `- ${w}`).join('\n')}` : '',
  ].filter(Boolean);

  if (level === 'typed-exact') {
    const expected = sourceQualifiedId(plugin);
    const typed = window.prompt(
      `Review this install plan before continuing:\n\n${planLines.join('\n')}\n\nType ${expected} to install.`,
    );
    return typed === expected;
  }

  return window.confirm(`Review this install plan before continuing:\n\n${planLines.join('\n')}\n\nThe connected server owner must approve this mutation.`);
}

export function PluginMarketplaceTab() {
  const showToast = useSettingsStore(s => s.showToast);
  const set = useSettingsStore(s => s.set);
  const agents = useSettingsStore(s => s.agents) || [];
  const currentAgentId = useSettingsStore(s => s.currentAgentId);
  const settingsAgentId = useSettingsStore(s => s.settingsAgentId);
  const [marketplace, setMarketplace] = useState<MarketplaceResponse | null>(null);
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [selectedPlugin, setSelectedPlugin] = useState<MarketplacePlugin | null>(null);
  const [readme, setReadme] = useState('');
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [installingPluginId, setInstallingPluginId] = useState<string | null>(null);
  const [switchingKey, setSwitchingKey] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(settingsAgentId || currentAgentId || null);
  const [updatingAgentAccess, setUpdatingAgentAccess] = useState(false);
  const loadGenRef = React.useRef(0);
  const readmeGenRef = React.useRef(0);
  const readmeKeyRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (!selectedAgentId && (settingsAgentId || currentAgentId)) {
      setSelectedAgentId(settingsAgentId || currentAgentId);
    }
  }, [currentAgentId, selectedAgentId, settingsAgentId]);

  const loadReadme = useCallback(async (plugin: MarketplacePlugin, opts: { force?: boolean } = {}) => {
    const key = rowKey(plugin);
    setSelectedPlugin(plugin);

    // Same selection: keep current body (description/readme) — no flash on catalog refresh.
    if (!opts.force && readmeKeyRef.current === key) {
      return;
    }

    readmeKeyRef.current = key;
    const gen = ++readmeGenRef.current;
    // Keep description visible while README loads; never blank the panel.
    setReadme((prev) => (prev && readmeKeyRef.current === key ? prev : (plugin.description || '')));
    setReadmeLoading(true);
    try {
      const qs = plugin.marketplaceId
        ? `?marketplaceId=${encodeURIComponent(plugin.marketplaceId)}`
        : '';
      // Soft-fail: many Claude rows have no README; do not fail the whole tab.
      let res: Response;
      try {
        res = await hanaFetch(`/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/readme${qs}`, {
          timeout: 15_000,
        });
      } catch {
        if (gen !== readmeGenRef.current) return;
        setReadme(plugin.description || '');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (gen !== readmeGenRef.current) return;
      if (data.error || !data.markdown) {
        setReadme(plugin.description || '');
        return;
      }
      // Avoid re-render flash when API returns the same description as body
      const next = String(data.markdown || '').trim();
      const desc = String(plugin.description || '').trim();
      setReadme(next || desc);
    } catch {
      if (gen !== readmeGenRef.current) return;
      setReadme(plugin.description || '');
    } finally {
      if (gen === readmeGenRef.current) setReadmeLoading(false);
    }
  }, []);

  const loadMarketplace = useCallback(async (opts: { silent?: boolean } = {}) => {
    const gen = ++loadGenRef.current;
    if (!opts.silent) setMarketplaceLoading(true);
    try {
      // Fetch independently so one slow/failing call does not wipe the other.
      let plugins: MarketplacePlugin[] = [];
      let sources: MarketplaceSourceRow[] = [];
      let source: MarketplaceResponse['source'] = {};
      let warnings: string[] = [];
      let multiOk = false;
      let capabilities: MarketplaceResponse['capabilities'] = null;
      let access: MarketplaceResponse['access'] = null;
      let registry: MarketplaceResponse['registry'] = null;
      let configDiagnostics: MarketplaceConfigDiagnostics | null = null;
      let compatibilityBindings: ClaudeCompatibilityStatus[] = [];
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
          const pick = retainedSelection || plugins[0];
          // Only fetch README when selection actually changes (prevents description flash).
          if (!retainedSelection) {
            void loadReadme(pick);
          }
          return pick;
        });
      } else {
        setSelectedPlugin(null);
        setReadme('');
        readmeKeyRef.current = null;
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
  }, [loadReadme, selectedAgentId, showToast]);

  useEffect(() => {
    void loadMarketplace();
  }, [loadMarketplace]);

  const installPlugin = async (plugin: MarketplacePlugin) => {
    if (!plugin.canInstall || plugin.installable === false || plugin.installTarget === 'unsupported') return;
    const allowDowngrade = plugin.installAction === 'downgrade'
      ? window.confirm(t('settings.plugins.marketDowngradeConfirm', {
          from: plugin.installedVersion || '',
          to: marketVersion(plugin),
        }))
      : false;
    if (plugin.installAction === 'downgrade' && !allowDowngrade) return;
    if (!confirmInstallPlan(plugin)) return;

    setInstallingPluginId(rowKey(plugin));
    try {
      const res = await hanaFetch(`/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: plugin.selectedVersion || undefined,
          allowDowngrade,
          marketplaceId: plugin.marketplaceId || undefined,
          ...(typeof marketplace?.registry?.revision === 'number'
            ? { expectedRevision: marketplace.registry.revision }
            : {}),
          ...(marketplace?.registry?.digest ? { expectedDigest: marketplace.registry.digest } : {}),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.plugins.installSuccess', { name: data.name || plugin.name }), 'success');
      await loadMarketplace();
    } catch (err: unknown) {
      showToast(t('settings.plugins.installError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setInstallingPluginId(null);
    }
  };

  const toggleNativeAgentAccess = async (plugin: MarketplacePlugin) => {
    if (!selectedAgentId || !plugin.marketplaceId || plugin.installTarget !== 'native-plugin') return;
    const identity = sourceQualifiedId(plugin);
    const current = plugin.nativeAgentPluginAccess?.enabled === true;
    const nextEnabled = !current;
    const serverGlobal = plugin.nativeAgentPluginAccess?.serverGlobalContributions
      || plugin.capabilityInventory?.serverImpact
      || [];
    const summary = [
      `${nextEnabled ? 'Enable' : 'Disable'} Agent Plugin Access for ${identity}`,
      `Agent: ${selectedAgentId}`,
      'Agent-facing scope: tools, commands, chat cards, and agent-aware surfaces only.',
      serverGlobal.length
        ? `Owner-reviewed server-global capabilities are unchanged: ${serverGlobal.join(', ')}`
        : 'No server-global capability state will be changed.',
      `Registry revision: ${marketplace?.registry?.revision ?? 'unknown'}`,
      `Registry digest: ${marketplace?.registry?.digest || 'unknown'}`,
    ].join('\n');
    if (!window.confirm(`${summary}\n\nConfirm this exact source-qualified access change?`)) return;

    const existing = marketplace?.configDiagnostics?.file?.activations || {};
    const activations = JSON.parse(JSON.stringify(existing));
    activations.agentPluginAccess ||= {};
    activations.agentPluginAccess[selectedAgentId] ||= {};
    activations.agentPluginAccess[selectedAgentId][identity] = {
      enabled: nextEnabled,
      contributions: plugin.capabilityInventory?.agentFacing || [],
    };

    setUpdatingAgentAccess(true);
    try {
      const res = await hanaFetch('/api/plugins/marketplace/config/activations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activations,
          ...(typeof marketplace?.registry?.revision === 'number'
            ? { expectedRevision: marketplace.registry.revision }
            : {}),
          ...(marketplace?.registry?.digest ? { expectedDigest: marketplace.registry.digest } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || 'Agent Plugin Access update failed');
      showToast(`Agent Plugin Access ${nextEnabled ? 'enabled' : 'disabled'} for ${identity}`, 'success');
      await loadMarketplace({ silent: true });
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setUpdatingAgentAccess(false);
    }
  };

  const sourceCount = marketplace?.sources?.length || 0;
  const pluginCount = marketplace?.plugins?.length || 0;
  const statusText = marketplace?.capabilities?.supported !== false
    ? t('settings.plugins.marketplaceCount', { count: String(pluginCount) })
    : t('settings.plugins.marketplaceNoSource');
  const selectedWarnings = selectedPlugin ? warningMessages(selectedPlugin) : [];
  const selectedInventoryGroups = selectedPlugin ? inventoryGroups(selectedPlugin) : [];
  const configDiagnostics = marketplace?.configDiagnostics?.diagnostics || [];
  const compatibilityBindings = marketplace?.compatibilityBindings || [];

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="plugin-marketplace">
      <div className={styles['plugin-marketplace-toolbar']}>
        <button
          type="button"
          className={styles['settings-return-btn']}
          onClick={() => set({ activeTab: 'plugins' })}
          aria-label={t('settings.plugins.marketBack')}
          title={t('settings.plugins.marketBack')}
        >
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className={styles['skills-list-desc']}>{t('settings.plugins.marketplaceHint')}</span>
        <div className={styles['plugin-marketplace-toolbar-actions']}>
          {marketplace && (
            <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
              {statusText}
            </span>
          )}
          <button
            type="button"
            className={styles['settings-icon-btn']}
            aria-label={t('settings.plugins.openMarketplace')}
            title={t('settings.plugins.openMarketplace')}
            onClick={() => { void loadMarketplace(); }}
            disabled={marketplaceLoading}
          >
            <svg
              aria-hidden="true"
              width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              className={marketplaceLoading ? styles['spin'] : ''}
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>
      </div>

      <SettingsSection surface="plain">
        <div className={styles['plugin-marketplace-scope-grid']}>
          <section className={styles['plugin-marketplace-scope-card']} aria-labelledby="marketplace-server-scope">
            <div className={styles['plugin-marketplace-scope-heading']}>
              <div>
                <h3 id="marketplace-server-scope">Server runtime &amp; sources</h3>
                <p>One server-owned registry and shared catalog for every connected desktop and Agent.</p>
              </div>
              <span className={styles['skills-source-badge']}>
                {marketplace?.capabilities?.supported === false ? 'Unsupported server' : 'Supported server'}
              </span>
            </div>
            <div className={styles['plugin-marketplace-scope-facts']}>
              <span>{sourceCount} source{sourceCount === 1 ? '' : 's'}</span>
              <span>{pluginCount} package{pluginCount === 1 ? '' : 's'}</span>
              <span>revision {marketplace?.registry?.revision ?? '—'}</span>
              <span>{marketplace?.registry?.degraded ? 'degraded / last-known-good' : 'configuration valid'}</span>
              <span>{marketplace?.access?.isStudioOwner === false ? 'needs owner for changes' : 'owner actions available'}</span>
            </div>
          </section>

          <section className={styles['plugin-marketplace-scope-card']} aria-labelledby="marketplace-agent-scope">
            <div className={styles['plugin-marketplace-scope-heading']}>
              <div>
                <h3 id="marketplace-agent-scope">Selected-Agent Plugin Access</h3>
                <p>Controls native plugin tools, commands, chat cards, and agent-aware surfaces for one Agent.</p>
              </div>
              <label className={styles['plugin-marketplace-agent-select']}>
                <span>Agent</span>
                <select
                  value={selectedAgentId || ''}
                  onChange={(event) => setSelectedAgentId(event.target.value || null)}
                  aria-label="Agent for native plugin access"
                >
                  {!selectedAgentId && <option value="">Select an Agent</option>}
                  {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
                </select>
              </label>
            </div>
            <p className={styles['settings-form-hint']}>
              Routes, providers, extensions, lifecycle/background behavior, and full-access policy remain server-global owner-reviewed state. This is not per-Agent sandboxing.
            </p>
          </section>
        </div>

        <div style={{ marginBottom: 14 }}>
          <MarketplaceSourcesPanel
            // Debounce parent reloads: sources panel already lists sources; only refresh catalog after mutations.
            onSourcesChanged={() => {
              window.setTimeout(() => { void loadMarketplace({ silent: true }); }, 100);
            }}
          />
        </div>
        {!marketplace ? (
          <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`}>
            {t('settings.plugins.marketLoading')}
          </p>
        ) : (
          <>
            {marketplace.warnings && marketplace.warnings.length > 0 && (
              <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`} style={{ color: 'var(--danger, #c55)' }}>
                {marketplace.warnings[0]}
              </p>
            )}
            {marketplace.plugins.length === 0 ? (
              <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`}>
                {t('settings.plugins.marketplaceEmpty')}
              </p>
            ) : (
              <div className={styles['plugin-marketplace-grid']}>
                <div className={styles['skills-list-block']}>
                  {marketplace.plugins.map(plugin => {
                    const warnings = warningMessages(plugin);
                    return (
                      <button
                        type="button"
                        key={rowKey(plugin)}
                        className={`${styles['skills-list-item']} ${styles['plugin-marketplace-catalog-item']}`}
                        onClick={() => loadReadme(plugin)}
                        aria-pressed={selectedPlugin ? rowKey(selectedPlugin) === rowKey(plugin) : false}
                        aria-label={`Inspect ${sourceQualifiedId(plugin)}`}
                        style={selectedPlugin && rowKey(selectedPlugin) === rowKey(plugin) ? { background: 'var(--bg-hover)' } : undefined}
                      >
                        <div className={styles['skills-list-info']}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            <span className={styles['skills-list-name']}>{plugin.name}</span>
                            <span className={styles['skills-list-name-hint']}>v{marketVersion(plugin)}</span>
                            {plugin.marketplaceId && (
                              <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                                {sourceQualifiedId(plugin)}
                              </span>
                            )}
                            {plugin.installTarget && (
                              <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                                {marketTargetLabel(plugin.installTarget)}
                              </span>
                            )}
                            {plugin.confirmationLevel && plugin.confirmationLevel !== 'inline' && (
                              <span className={styles['plugin-marketplace-risk-badge']}>
                                {marketConfirmationLabel(plugin.confirmationLevel)}
                              </span>
                            )}
                            {warnings.length > 0 && (
                              <span className={styles['plugin-marketplace-warning-badge']}>
                                {warnings.length} warning{warnings.length === 1 ? '' : 's'}
                              </span>
                            )}
                            {(plugin.installed || plugin.active) && (
                              <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                                {t('settings.plugins.marketInstalled')}
                              </span>
                            )}
                            {plugin.retained && !plugin.active && (
                              <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                                retained
                              </span>
                            )}
                            {plugin.updateAvailable && (
                              <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                                {t('settings.plugins.marketUpdateAvailable')}
                              </span>
                            )}
                          </div>
                          {plugin.description && <span className={styles['skills-list-desc']}>{plugin.description}</span>}
                          <span className={styles['skills-list-desc']}>
                            {(plugin.publisher || 'unknown') + ' · ' + (plugin.trust || 'restricted')}
                            {plugin.installAdapter ? ` · ${marketAdapterLabel(plugin.installAdapter)}` : ''}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className={styles['skills-list-block']}>
                  <div className={styles['skills-list-item']} style={{ alignItems: 'flex-start', cursor: 'default' }}>
                    <div className={styles['skills-list-info']} style={{ gap: 'var(--space-8)', width: '100%' }}>
                      {selectedPlugin ? (
                        <>
                          <div className={styles['plugin-marketplace-detail-header']}>
                            <div style={{ minWidth: 0 }}>
                              <div className={styles['skills-list-name']}>{selectedPlugin.name}</div>
                              <div className={styles['skills-list-desc']}>
                                {(selectedPlugin.publisher || 'unknown') + ' · v' + marketVersion(selectedPlugin)}
                                {selectedPlugin.marketplaceId ? ` · ${sourceQualifiedId(selectedPlugin)}` : ''}
                              </div>
                              {marketVersionStatus(selectedPlugin) && (
                                <div className={styles['skills-list-desc']}>
                                  {marketVersionStatus(selectedPlugin)}
                                </div>
                              )}
                            </div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                className={styles['settings-save-btn-sm']}
                                disabled={!selectedPlugin.canInstall || installingPluginId === rowKey(selectedPlugin)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  installPlugin(selectedPlugin);
                                }}
                              >
                                {marketInstallLabel(selectedPlugin)}
                              </button>
                              {(selectedPlugin.installTarget === 'hana-skills' || selectedPlugin.installTarget === 'skills') && (
                                <button
                                  type="button"
                                  className={styles['settings-save-btn-sm']}
                                  onClick={() => set({ activeTab: 'skills' })}
                                >
                                  Manage in Skills
                                </button>
                              )}
                              {selectedPlugin.installTarget === 'native-plugin' && selectedAgentId && (
                                <button
                                  type="button"
                                  className={styles['settings-save-btn-sm']}
                                  disabled={updatingAgentAccess || marketplace?.access?.isStudioOwner === false}
                                  onClick={() => { void toggleNativeAgentAccess(selectedPlugin); }}
                                >
                                  {selectedPlugin.nativeAgentPluginAccess?.enabled ? 'Disable Agent Access' : 'Enable Agent Access'}
                                </button>
                              )}
                              {selectedPlugin.marketplaceId && selectedPlugin.retained && !selectedPlugin.active && (
                                <button
                                  className={styles['settings-save-btn-sm']}
                                  disabled={switchingKey === rowKey(selectedPlugin)}
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    if (!window.confirm(
                                      `Switch active source to ${selectedPlugin.marketplaceId}? State and trust stay source-isolated; rollback is automatic on failure.`,
                                    )) return;
                                    setSwitchingKey(rowKey(selectedPlugin));
                                    try {
                                      const res = await hanaFetch(`/api/plugins/${encodeURIComponent(selectedPlugin.id)}/source-switch`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ marketplaceId: selectedPlugin.marketplaceId }),
                                      });
                                      const data = await res.json();
                                      if (!data.ok) throw new Error(data.error?.message || data.error || 'switch failed');
                                      showToast('Source switched', 'success');
                                      await loadMarketplace();
                                    } catch (err: unknown) {
                                      showToast(err instanceof Error ? err.message : String(err), 'error');
                                    } finally {
                                      setSwitchingKey(null);
                                    }
                                  }}
                                >
                                  Switch source
                                </button>
                              )}
                            </div>
                          </div>
                          <div className={styles['plugin-marketplace-inspector']}>
                            <div className={styles['plugin-marketplace-property-row']}>
                              <span>Identity</span>
                              <code translate="no">{sourceQualifiedId(selectedPlugin)}</code>
                            </div>
                            <div className={styles['plugin-marketplace-property-row']}>
                              <span>Install Target</span>
                              <strong>{marketTargetLabel(selectedPlugin.installTarget || selectedPlugin.installPlan?.destination)}</strong>
                            </div>
                            <div className={styles['plugin-marketplace-property-row']}>
                              <span>Install Adapter</span>
                              <strong>{marketAdapterLabel(selectedPlugin.installAdapter || selectedPlugin.installPlan?.installAdapter)}</strong>
                            </div>
                            <div className={styles['plugin-marketplace-property-row']}>
                              <span>Confirmation</span>
                              <strong>{marketConfirmationLabel(selectedPlugin.confirmationLevel || selectedPlugin.installPlan?.confirmationLevel)}</strong>
                            </div>
                            <div className={styles['plugin-marketplace-property-row']}>
                              <span>Installable</span>
                              <strong>{selectedPlugin.installable === false || selectedPlugin.installTarget === 'unsupported' ? 'No' : 'Yes'}</strong>
                            </div>
                            {(selectedPlugin.catalogFormat || selectedPlugin.sourceStatus) && (
                              <div className={styles['plugin-marketplace-property-row']}>
                                <span>Source</span>
                                <strong>
                                  {[selectedPlugin.catalogFormat, selectedPlugin.sourceAuthority, selectedPlugin.sourceStatus]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </strong>
                              </div>
                            )}
                            {selectedPlugin.runtimeActivation && (
                              <div className={styles['plugin-marketplace-property-row']}>
                                <span>Server runtime</span>
                                <strong>{selectedPlugin.runtimeActivation.state || 'unknown'}{selectedPlugin.runtimeActivation.reason ? ` · ${selectedPlugin.runtimeActivation.reason}` : ''}</strong>
                              </div>
                            )}
                            {selectedPlugin.installTarget === 'native-plugin' && selectedPlugin.nativeAgentPluginAccess && (
                              <div className={styles['plugin-marketplace-plan']}>
                                <span>Agent Plugin Access</span>
                                <strong>
                                  {selectedPlugin.nativeAgentPluginAccess.state || 'unknown'}
                                  {selectedPlugin.nativeAgentPluginAccess.reason ? ` · ${selectedPlugin.nativeAgentPluginAccess.reason}` : ''}
                                </strong>
                              </div>
                            )}
                            {(selectedPlugin.installTarget === 'hana-skills' || selectedPlugin.installTarget === 'skills') && (
                              <div className={styles['plugin-marketplace-plan']}>
                                <span>Activation route</span>
                                <strong>Skills Settings / Agent Skill Toggles (not Native Plugins)</strong>
                              </div>
                            )}
                            {selectedPlugin.installPlan && (
                              <div className={styles['plugin-marketplace-plan']}>
                                <span>Install Plan</span>
                                <strong>
                                  {[
                                    selectedPlugin.installPlan.action || 'install',
                                    marketTargetLabel(selectedPlugin.installPlan.destination || selectedPlugin.installTarget),
                                    marketAdapterLabel(selectedPlugin.installPlan.installAdapter || selectedPlugin.installAdapter),
                                  ].join(' · ')}
                                </strong>
                              </div>
                            )}
                            {selectedInventoryGroups.length > 0 && (
                              <div className={styles['plugin-marketplace-inventory']}>
                                {selectedInventoryGroups.map(group => (
                                  <div key={group.key} className={styles['plugin-marketplace-inventory-group']}>
                                    <span>{group.label}</span>
                                    <div>
                                      {group.values.map(value => (
                                        <code key={value} translate="no">{value}</code>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {selectedWarnings.length > 0 && (
                              <div className={styles['plugin-marketplace-warnings']} role="status">
                                <span>Warnings</span>
                                <ul>
                                  {selectedWarnings.map(warning => (
                                    <li key={warning}>{warning}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {(selectedPlugin.contributions || []).map(item => (
                              <span key={item} className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                                {item}
                              </span>
                            ))}
                          </div>
                          <div
                            className={`preview-markdown ${styles['plugin-marketplace-readme']}`}
                            dangerouslySetInnerHTML={{
                              // Always keep description/readme body; never swap to a loading placeholder
                              // (that flash is what made HyperFrames description flicker on refresh).
                              __html: renderMarkdown(
                                readme || selectedPlugin.description || (readmeLoading ? '' : ''),
                              ),
                            }}
                          />
                        </>
                      ) : (
                        <span className={styles['skills-list-desc']}>{t('settings.plugins.marketSelectPlugin')}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {marketplace && marketplace.capabilities?.supported !== false && (
          <details className={styles['plugin-marketplace-advanced']}>
            <summary>Claude compatibility &amp; advanced JSON configuration</summary>
            <div className={styles['plugin-marketplace-advanced-body']}>
              <section aria-labelledby="marketplace-json-config">
                <h3 id="marketplace-json-config">Configuration-as-code diagnostics</h3>
                <p className={styles['settings-form-hint']}>
                  Advanced owner/operator view only. Use normal source and access controls for routine changes; direct JSON edits are revision-checked and keep the last-known-good state when invalid.
                </p>
                <div className={styles['plugin-marketplace-inspector']}>
                  <div className={styles['plugin-marketplace-property-row']}>
                    <span>Status</span>
                    <strong>{marketplace.configDiagnostics?.degraded ? 'Invalid edit · last-known-good active' : 'Valid'}</strong>
                  </div>
                  <div className={styles['plugin-marketplace-property-row']}>
                    <span>Server-local path</span>
                    <code translate="no">{marketplace.configDiagnostics?.path || marketplace.registry?.path || 'Unavailable'}</code>
                  </div>
                  <div className={styles['plugin-marketplace-property-row']}>
                    <span>Last valid revision</span>
                    <strong>{marketplace.configDiagnostics?.summary?.revision ?? marketplace.registry?.revision ?? '—'}</strong>
                  </div>
                  <div className={styles['plugin-marketplace-property-row']}>
                    <span>Digest</span>
                    <code translate="no">{marketplace.configDiagnostics?.digest || marketplace.registry?.digest || '—'}</code>
                  </div>
                  {configDiagnostics.length > 0 && (
                    <div className={styles['plugin-marketplace-warnings']} role="status">
                      <span>Diagnostics &amp; repair guidance</span>
                      <ul>
                        {configDiagnostics.map((diagnostic, index) => (
                          <li key={`${diagnostic.code || 'diagnostic'}-${index}`}>
                            {diagnostic.path ? `${diagnostic.path}: ` : ''}{diagnostic.message || diagnostic.code}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </section>

              <section aria-labelledby="marketplace-claude-bindings">
                <h3 id="marketplace-claude-bindings">Claude compatibility bindings</h3>
                <p className={styles['settings-form-hint']}>
                  Live, mirror, and snapshot bindings read only explicitly authorized paths. Secret-bearing settings, hooks, MCP/LSP, commands, binaries, lifecycle scripts, monitors, and permission policy are excluded before state is stored or shown.
                </p>
                {compatibilityBindings.length === 0 ? (
                  <p className={styles['settings-muted-note']}>No compatibility bindings configured.</p>
                ) : (
                  <div className={styles['plugin-marketplace-binding-list']}>
                    {compatibilityBindings.map(item => (
                      <article key={item.binding.id} className={styles['plugin-marketplace-binding-card']}>
                        <div className={styles['plugin-marketplace-scope-heading']}>
                          <div>
                            <h4>{item.binding.id}</h4>
                            <p>{item.binding.mode} · {item.binding.enabled ? 'enabled' : 'disabled'} · {item.pendingBoundary || 'current snapshot'}</p>
                          </div>
                          <span className={styles['skills-source-badge']}>
                            {item.diagnostic ? (item.lastKnownGood ? 'last-known-good' : 'diagnostic') : 'healthy'}
                          </span>
                        </div>
                        {(item.binding.inputs || []).map((input, index) => (
                          <div key={`${input.role}-${index}`} className={styles['plugin-marketplace-property-row']}>
                            <span>{input.role || 'input'}</span>
                            <code translate="no">{input.path || 'Unavailable'}</code>
                          </div>
                        ))}
                        <div className={styles['plugin-marketplace-property-row']}>
                          <span>Last-valid digest</span>
                          <code translate="no">{item.state?.digest || '—'}</code>
                        </div>
                        {item.diagnostic && (
                          <div className={styles['plugin-marketplace-warnings']} role="alert">
                            <span>{item.diagnostic.code || 'Binding diagnostic'}</span>
                            <ul><li>{item.diagnostic.message || 'Repair the authorized input and refresh the binding.'}</li></ul>
                          </div>
                        )}
                        {(item.state?.warnings || []).length > 0 && (
                          <div className={styles['plugin-marketplace-warnings']} role="status">
                            <span>Sanitized exclusions</span>
                            <ul>
                              {item.state!.warnings!.map((warning, index) => (
                                <li key={`${warning.code || warning.category}-${index}`}>{warning.message || warning.code}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                )}
                <div className={styles['plugin-marketplace-bridge-status']} role="status">
                  <strong>Desktop bridge transport: unavailable in this build.</strong>
                  <span>
                    The server can validate a versioned, device/session-scoped sanitized envelope, but the desktop does not collect or transmit Claude files yet. Use server-local authorized paths, mirror, or snapshot mode; no install, promotion, or activation bypass is provided.
                  </span>
                </div>
              </section>
            </div>
          </details>
        )}
      </SettingsSection>
    </div>
  );
}
