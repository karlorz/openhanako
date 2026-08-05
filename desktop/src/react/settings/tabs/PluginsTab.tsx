import React, { useState, useEffect, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import styles from '../Settings.module.css';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { MarketplaceSourcesPanel } from '../components/MarketplaceSourcesPanel';
import { BrowseIcon, RefreshIcon, RemoveIcon } from '../components/PluginActionIcons';
import { Toggle } from '@/ui';
import { MarketplaceSkillPackagePage } from './skills/MarketplaceSkillPackagePage';
import {
  writeMarketplaceSkillPackageToggle,
  type MarketplaceActivationSnapshot,
} from '../marketplace-registry';
import { type ManagePluginsSkillPackageRow } from './skills/marketplace-package';
import { PluginConfigEditor, type PluginInfo } from '../components/plugins/PluginConfigEditor';
import {
  ManagePluginsSkillPackagesPanel,
  type SkillPackageInventoryMeta,
} from '../components/plugins/ManagePluginsSkillPackagesPanel';

const platform = window.platform;
const marketplaceBadgeClassName = `${styles['skills-source-badge']} ${styles['plugin-marketplace-badge']}`;

interface PluginDiagnostics {
  id: string;
  name?: string;
  status?: string;
  error?: string | null;
  activationState?: string | null;
  activationEvents?: string[];
  activationError?: string | null;
  source?: string;
  trust?: string;
  contributions?: string[];
  routes?: {
    hasRouteApp?: boolean;
    pages?: unknown[];
    widgets?: unknown[];
    settingsTabs?: unknown[];
  };
  tools?: { name: string; dynamic?: boolean }[];
  commands?: { name: string }[];
  providers?: { id: string; name?: string }[];
  config?: { hasSchema?: boolean; keys?: string[] };
}

interface PluginDiagnosticsResponse {
  plugins: PluginDiagnostics[];
  eventBus: { type: string; available?: boolean }[];
  tasks: { taskId: string; type: string; status?: string }[];
  schedules: { scheduleId: string; type: string; enabled?: boolean }[];
}

/* ── Status badge ── */

function StatusBadge({ status }: { status: PluginInfo['status'] }) {
  const labelKey =
    status === 'loaded' ? 'settings.plugins.statusLoaded' :
    status === 'failed' ? 'settings.plugins.statusFailed' :
    status === 'restricted' ? 'settings.plugins.statusRestricted' :
    'settings.plugins.statusDisabled';

  const style: React.CSSProperties =
    status === 'loaded'
      ? { color: 'var(--success, #5a9)', background: 'rgba(90,170,153,0.1)' }
      : status === 'failed'
      ? { color: 'var(--danger, #b56b66)', background: 'rgba(var(--danger-rgb, 181, 107, 102), 0.1)' }
      : status === 'restricted'
      ? { color: 'var(--danger, #b56b66)', background: 'rgba(var(--danger-rgb, 181, 107, 102), 0.1)' }
      : { color: 'var(--text-muted)', background: 'var(--overlay-light, rgba(0,0,0,0.06))' };

  return (
    <span className={styles['oauth-status-badge']} style={style}>
      {t(labelKey)}
    </span>
  );
}

/* ── Contribution badges ── */

function ContributionBadges({ contributions }: { contributions?: string[] }) {
  if (!contributions || contributions.length === 0) return null;
  return (
    <span style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
      {contributions.map(c => (
        <span
          key={c}
          className={marketplaceBadgeClassName}
          style={{
            opacity: 1,
            background: 'var(--overlay-light, rgba(0,0,0,0.05))',
            padding: '1px 6px', borderRadius: 'var(--radius-sm)',
          }}
        >
          {c}
        </span>
      ))}
    </span>
  );
}

function count(value: unknown[] | undefined): number {
  return Array.isArray(value) ? value.length : 0;
}

/* ── Main tab ── */

export function PluginsTab() {
  const { pluginAllowFullAccess, pluginDevToolsEnabled, pluginUserDir } = useSettingsStore(
    useShallow(s => ({
      pluginAllowFullAccess: s.pluginAllowFullAccess,
      pluginDevToolsEnabled: s.pluginDevToolsEnabled,
      pluginUserDir: s.pluginUserDir,
    }))
  );
  const showToast = useSettingsStore(s => s.showToast);
  const set = useSettingsStore(s => s.set);

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [skillPackages, setSkillPackages] = useState<ManagePluginsSkillPackageRow[]>([]);
  const [skillPackageMeta, setSkillPackageMeta] = useState<SkillPackageInventoryMeta>({
    registry: null,
    access: null,
    activations: null,
  });
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [configPlugin, setConfigPlugin] = useState<PluginInfo | null>(null);
  const [diagnostics, setDiagnostics] = useState<PluginDiagnosticsResponse | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [openSkillPackageIdentity, setOpenSkillPackageIdentity] = useState<string | null>(null);
  const [togglingSkillPackageIdentity, setTogglingSkillPackageIdentity] = useState<string | null>(null);

  /* ── data fetchers ── */

  const applySkillPackageSnapshot = useCallback((data: unknown): MarketplaceActivationSnapshot => {
    const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const registry = payload.registry && typeof payload.registry === 'object'
      ? payload.registry as SkillPackageInventoryMeta['registry']
      : null;
    const access = payload.access && typeof payload.access === 'object'
      ? payload.access as SkillPackageInventoryMeta['access']
      : null;
    const activations = payload.activations && typeof payload.activations === 'object'
      ? payload.activations as Record<string, unknown>
      : null;
    setSkillPackages(Array.isArray(payload.packages) ? payload.packages as ManagePluginsSkillPackageRow[] : []);
    setSkillPackageMeta({ registry, access, activations });
    return { registry, activations };
  }, []);

  const loadPlugins = useCallback(async () => {
    const [nativeResult, skillPackageResult] = await Promise.allSettled([
      hanaFetch('/api/plugins?source=community'),
      hanaFetch('/api/plugins/marketplace/installed-skill-packages'),
    ]);

    if (nativeResult.status === 'fulfilled') {
      try {
        const nativeData = await nativeResult.value.json();
        setPlugins(Array.isArray(nativeData) ? nativeData : []);
      } catch (err) {
        console.error('[plugins] native load failed:', err);
        setPlugins([]);
      }
    } else {
      console.error('[plugins] native load failed:', nativeResult.reason);
      setPlugins([]);
    }

    if (skillPackageResult.status === 'fulfilled') {
      try {
        const skillData = await skillPackageResult.value.json();
        applySkillPackageSnapshot(skillData);
      } catch (err) {
        console.error('[plugins] skill package inventory load failed:', err);
        applySkillPackageSnapshot({});
      }
    } else {
      console.error('[plugins] skill package inventory load failed:', skillPackageResult.reason);
      applySkillPackageSnapshot({});
    }
  }, [applySkillPackageSnapshot]);

  const loadDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    try {
      const res = await hanaFetch('/api/plugins/diagnostics');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDiagnostics({
        plugins: Array.isArray(data.plugins) ? data.plugins : [],
        eventBus: Array.isArray(data.eventBus) ? data.eventBus : [],
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        schedules: Array.isArray(data.schedules) ? data.schedules : [],
      });
    } catch (err: unknown) {
      showToast(t('settings.plugins.diagnosticsLoadError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [showToast]);

  const reload = useCallback(async () => {
    setLoading(true);
    await loadPlugins();
    setLoading(false);
  }, [loadPlugins]);

  useEffect(() => { reload(); }, [reload]);

  /* ── full-access toggle ── */

  const toggleFullAccess = async () => {
    if (pluginAllowFullAccess === undefined) return;
    const next = !pluginAllowFullAccess;
    set({ pluginAllowFullAccess: next });
    try {
      const res = await hanaFetch('/api/plugins/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_full_access: next }),
      });
      const data = await res.json();
      if (Array.isArray(data)) setPlugins(data);
      showToast(t('settings.autoSaved'), 'success');
    } catch (err: unknown) {
      set({ pluginAllowFullAccess: !next });
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const togglePluginDevTools = async () => {
    if (pluginDevToolsEnabled === undefined) return;
    const next = !pluginDevToolsEnabled;
    set({ pluginDevToolsEnabled: next });
    try {
      const res = await hanaFetch('/api/plugins/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin_dev_tools_enabled: next }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.autoSaved'), 'success');
    } catch (err: unknown) {
      set({ pluginDevToolsEnabled: !next });
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  /* ── install ── */

  const installFromPath = async (filePath: string) => {
    try {
      const res = await hanaFetch('/api/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.plugins.installSuccess', { name: data.name || '' }), 'success');
      await loadPlugins();
    } catch (err: unknown) {
      showToast(
        t('settings.plugins.installError') + ': ' + (err instanceof Error ? err.message : String(err)),
        'error',
      );
    }
  };

  const installByPicker = async () => {
    const selectedPath = await platform?.selectPlugin?.();
    if (!selectedPath) return;
    await installFromPath(selectedPath);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const filePath = platform?.getFilePath?.(file) || (file as File & { path?: string })?.path;
    if (filePath) await installFromPath(filePath);
  };

  /* ── enable / disable ── */

  const togglePlugin = async (id: string, enable: boolean) => {
    // Optimistic update
    setPlugins(prev => prev.map(p => p.id === id ? { ...p, status: enable ? 'loaded' : 'disabled' } as PluginInfo : p));
    try {
      const res = await hanaFetch(`/api/plugins/${encodeURIComponent(id)}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enable }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.autoSaved'), 'success');
      await loadPlugins();
    } catch (err: unknown) {
      // Revert
      setPlugins(prev => prev.map(p => p.id === id ? { ...p, status: enable ? 'disabled' : 'loaded' } as PluginInfo : p));
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  /* ── delete ── */

  const deletePlugin = async (plugin: PluginInfo) => {
    const msg = t('settings.plugins.deleteConfirm', { name: plugin.name });
    if (!confirm(msg)) return;
    try {
      const res = await hanaFetch(`/api/plugins/${encodeURIComponent(plugin.id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.autoSaved'), 'success');
      await loadPlugins();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  /* ── marketplace skill packages (package gate + uninstall) ── */

  const isStudioOwner = skillPackageMeta.access?.isStudioOwner === true;

  const reloadSkillPackageSnapshot = async (): Promise<MarketplaceActivationSnapshot> => {
    const res = await hanaFetch('/api/plugins/marketplace/installed-skill-packages');
    const data = await res.json().catch(() => ({}));
    if (data.error) throw new Error(data.error);
    return applySkillPackageSnapshot(data);
  };

  const toggleSkillPackage = async (pkg: ManagePluginsSkillPackageRow, enable: boolean) => {
    if (!isStudioOwner) return;
    if (pkg.actions?.canToggle === false) return;
    // Owner path should always include a full activations snapshot; never PUT a bare {}.
    if (!skillPackageMeta.activations || typeof skillPackageMeta.activations !== 'object') {
      showToast(
        t('settings.saveFailed') + ': missing activations snapshot',
        'error',
      );
      return;
    }
    // Optimistic update
    setSkillPackages(prev => prev.map(row => (
      row.identity === pkg.identity ? { ...row, packageEnabled: enable } : row
    )));
    setTogglingSkillPackageIdentity(pkg.identity);
    try {
      const initial: MarketplaceActivationSnapshot = {
        registry: skillPackageMeta.registry,
        activations: skillPackageMeta.activations,
      };
      let result = await writeMarketplaceSkillPackageToggle(initial, pkg.identity, enable);
      if (result === 'stale') {
        result = await writeMarketplaceSkillPackageToggle(await reloadSkillPackageSnapshot(), pkg.identity, enable);
        if (result === 'stale') {
          await loadPlugins();
          showToast(t('settings.plugins.marketplaceChangedRetry'), 'error');
          return;
        }
      }
      showToast(t('settings.autoSaved'), 'success');
      await loadPlugins();
    } catch (err: unknown) {
      setSkillPackages(prev => prev.map(row => (
        row.identity === pkg.identity ? { ...row, packageEnabled: !enable } : row
      )));
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setTogglingSkillPackageIdentity(null);
    }
  };

  const uninstallSkillPackage = async (pkg: ManagePluginsSkillPackageRow) => {
    if (!isStudioOwner) return;
    const msg = t('settings.plugins.skillPackageUninstallConfirm', {
      identity: pkg.identity,
      name: pkg.name,
      skillCount: String(pkg.skillCount),
    });
    if (!confirm(msg)) return;
    try {
      const body: Record<string, unknown> = { marketplaceId: pkg.marketplaceId };
      if (typeof skillPackageMeta.registry?.revision === 'number') {
        body.expectedRevision = skillPackageMeta.registry.revision;
      }
      if (skillPackageMeta.registry?.digest) {
        body.expectedDigest = skillPackageMeta.registry.digest;
      }
      const res = await hanaFetch(
        `/api/plugins/marketplace/${encodeURIComponent(pkg.pluginId)}/skills`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || 'Skill package uninstall failed');
      if (data.ok === false || (Array.isArray(data.failed) && data.failed.length > 0)) {
        showToast(t('settings.saveFailed') + ': partial skill package uninstall', 'error');
      } else {
        showToast(t('settings.autoSaved'), 'success');
      }
      await loadPlugins();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const openSkillPackage = (identity: string) => {
    const pkg = skillPackages.find(row => row.identity === identity);
    if (!pkg) return;
    if (pkg.actions?.canOpenSkills === false || pkg.skillCount <= 0) {
      showToast(t('settings.plugins.skillPackagePageNoSkills'), 'error');
      return;
    }
    setOpenSkillPackageIdentity(pkg.identity);
  };

  const closeConfigEditor = useCallback(() => {
    setConfigPlugin(null);
  }, []);

  // The editor refreshes its own draft after a successful save; the tab has
  // no post-save side effect (same as before the decomposition).
  const handleConfigSaved = useCallback(() => {}, []);

  /* ── render ── */

  const isEnabled = (p: PluginInfo) => p.status === 'loaded' || p.status === 'failed';
  const isDimmed = (p: PluginInfo) => p.status === 'disabled' || p.status === 'restricted';
  const inventoryEmpty = plugins.length === 0 && skillPackages.length === 0;
  const openSkillPackageRow = openSkillPackageIdentity
    ? skillPackages.find((pkg) => pkg.identity === openSkillPackageIdentity) || null
    : null;

  useEffect(() => {
    if (!openSkillPackageIdentity || loading || openSkillPackageRow) return;
    setOpenSkillPackageIdentity(null);
    showToast(t('settings.plugins.skillPackagePageStaleReturn'), 'error');
  }, [loading, openSkillPackageIdentity, openSkillPackageRow, showToast]);

  const reloadButton = (
    <button
      type="button"
      className={styles['settings-icon-btn']}
      aria-label={t('settings.plugins.reload')}
      title={t('settings.plugins.reload')}
      onClick={reload}
      disabled={loading}
    >
      <RefreshIcon spinning={loading} />
    </button>
  );

  const marketplaceBody = (
    <div className={styles['skills-list-block']}>
      <button
        type="button"
        className={`${styles['skills-list-item']} ${styles['plugin-marketplace-entry']}`}
        aria-label={t('settings.plugins.openMarketplace')}
        title={t('settings.plugins.openMarketplace')}
        onClick={() => set({ activeTab: 'plugin-marketplace' })}
      >
        <span className={styles['skills-list-info']}>
          <span className={styles['skills-list-name']}>{t('settings.plugins.marketplaceTitle')}</span>
          <span className={styles['skills-list-desc']}>{t('settings.plugins.marketplaceHint')}</span>
        </span>
        <span className={styles['skills-list-actions']}>
          <span
            className={`${styles['settings-icon-btn']} ${styles['plugin-action-icon']}`}
            aria-hidden="true"
          >
            <BrowseIcon />
          </span>
        </span>
      </button>
      {/* First-class multi-source management remains part of this single marketplace surface. */}
      <MarketplaceSourcesPanel
        embedded
        withTopDivider
        heading={t('settings.plugins.marketSourcesSection')}
      />
    </div>
  );

  if (openSkillPackageRow) {
    return (
      <MarketplaceSkillPackagePage
        pkg={openSkillPackageRow}
        defaultAgentId={useSettingsStore.getState().getSettingsAgentId()}
        isStudioOwner={isStudioOwner}
        onBack={() => setOpenSkillPackageIdentity(null)}
        onOpenMarketplace={() => set({ activeTab: 'plugin-marketplace' })}
        onTogglePackage={toggleSkillPackage}
      />
    );
  }

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="plugins">
      <SettingsSection
        title={t('settings.plugins.marketplaceTitle')}
        surface="plain"
      >
        {marketplaceBody}
      </SettingsSection>

      {/* 管理插件：dropzone + 列表 + 路径提示，同一 flush section；reload 按钮放 context */}
      <SettingsSection
        title={t('settings.plugins.manageTitle')}
        surface="plain"
        context={reloadButton}
      >
        {/* 安装区：dropzone 自带虚线边框卡 */}
        <div
          className={`${styles['skills-dropzone']}${dragOver ? ' ' + styles['drag-over'] : ''}`}
          onClick={installByPicker}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          role="button"
          tabIndex={0}
          aria-label={t('settings.plugins.dropzone')}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              void installByPicker();
            }
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>{t('settings.plugins.dropzone')}</span>
        </div>

        {/* 已安装列表：native community plugins + marketplace skill packages */}
        {!loading && inventoryEmpty ? (
          <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`}>
            {t('settings.plugins.empty')}
          </p>
        ) : (
          <div className={styles['skills-list-block']}>
            {plugins.map(plugin => {
              const dimmed = isDimmed(plugin);
              const restricted = plugin.status === 'restricted';
              const enabled = isEnabled(plugin);
              const configurable = plugin.contributions?.includes('configuration');

              return (
                <div
                  key={plugin.id}
                  className={styles['skills-list-item']}
                  style={dimmed ? { opacity: 0.55 } : undefined}
                >
                  <div className={styles['skills-list-info']}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span className={styles['skills-list-name']}>{plugin.name}</span>
                      {plugin.version && (
                        <span className={styles['skills-list-name-hint']}>v{plugin.version}</span>
                      )}
                      <StatusBadge status={plugin.status} />
                      <ContributionBadges contributions={plugin.contributions} />
                    </div>
                    {plugin.description && (
                      <span className={styles['skills-list-desc']}>{plugin.description}</span>
                    )}
                    {plugin.status === 'failed' && plugin.error && (
                      <span className={styles['skills-list-desc']} style={{ color: 'var(--danger, #c55)' }}>
                        {plugin.error}
                      </span>
                    )}
                    {restricted && (
                      <span className={styles['skills-list-desc']} style={{ color: 'var(--danger, #b56b66)' }}>
                        {t('settings.plugins.needsFullAccess')}
                      </span>
                    )}
                  </div>

                  <div className={styles['skills-list-actions']}>
                    {configurable && (
                      <button
                        type="button"
                        className={`${styles['settings-icon-btn']} ${styles['plugin-action-icon']}`}
                        aria-label={t('settings.plugins.configure', { name: plugin.name })}
                        title={t('settings.plugins.configure', { name: plugin.name })}
                        onClick={() => setConfigPlugin(plugin)}
                      >
                        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="3" />
                          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
                        </svg>
                      </button>
                    )}
                    {/* Delete */}
                    <button
                      type="button"
                      className={`${styles['settings-icon-btn']} ${styles['plugin-action-icon']} ${styles['plugin-action-danger']}`}
                      aria-label={t('settings.plugins.deleteConfirm', { name: plugin.name })}
                      title={t('settings.plugins.deleteConfirm', { name: plugin.name })}
                      onClick={() => deletePlugin(plugin)}
                    >
                      <RemoveIcon />
                    </button>

                    {/* Enable/disable toggle */}
                    <button
                      className={`hana-toggle${enabled ? ' on' : ''}`}
                      disabled={restricted}
                      onClick={() => togglePlugin(plugin.id, !enabled)}
                    />
                  </div>
                </div>
              );
            })}

            <ManagePluginsSkillPackagesPanel
              rows={skillPackages}
              meta={skillPackageMeta}
              onOpen={openSkillPackage}
              onToggle={toggleSkillPackage}
              onUninstall={uninstallSkillPackage}
              busyIdentity={togglingSkillPackageIdentity}
            />
          </div>
        )}

        {/* 插件目录路径提示 */}
        {pluginUserDir && (
          <p style={{
            fontSize: '0.7rem',
            color: 'var(--text-muted)',
            marginTop: 'var(--space-8)',
          }}>
            {t('settings.plugins.pluginsDir', { path: pluginUserDir })}
          </p>
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.plugins.diagnosticsTitle')} surface="plain">
        <details
          onToggle={(event) => {
            const open = (event.currentTarget as HTMLDetailsElement).open;
            if (open && !diagnostics && !diagnosticsLoading) void loadDiagnostics();
          }}
        >
          <summary className={styles['skills-list-name']} style={{ cursor: 'pointer' }}>
            {t('settings.plugins.showDiagnostics')}
          </summary>
          {diagnosticsLoading && (
            <p className={styles['settings-muted-note']}>{t('settings.plugins.diagnosticsLoading')}</p>
          )}
          {diagnostics && (
            <>
              <span className={marketplaceBadgeClassName} style={{ marginTop: 8 }}>
                {t('settings.plugins.diagnosticsSummary', {
                  capabilities: String(diagnostics.eventBus.filter(item => item.available).length),
                  total: String(diagnostics.eventBus.length),
                  tasks: String(diagnostics.tasks.length),
                  schedules: String(diagnostics.schedules.length),
                })}
              </span>
          {diagnostics.plugins.length === 0 ? (
            <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`}>
              {t('settings.plugins.noDiagnostics')}
            </p>
          ) : (
            <div className={styles['skills-list-block']}>
              {diagnostics.plugins.map(plugin => {
                const routeText = t('settings.plugins.diagnosticRoutes', {
                  pages: String(count(plugin.routes?.pages)),
                  widgets: String(count(plugin.routes?.widgets)),
                  settingsTabs: String(count(plugin.routes?.settingsTabs)),
                });
                const capabilityText = [
                  t('settings.plugins.diagnosticTools', { count: String(count(plugin.tools)) }),
                  t('settings.plugins.diagnosticCommands', { count: String(count(plugin.commands)) }),
                  t('settings.plugins.diagnosticConfig', { count: String(count(plugin.config?.keys)) }),
                ].join(' · ');
                const activationText = plugin.activationState
                  ? t('settings.plugins.diagnosticActivation', { state: plugin.activationState })
                  : t('settings.plugins.diagnosticActivation', { state: '-' });
                return (
                  <div key={plugin.id} className={styles['skills-list-item']}>
                    <div className={styles['skills-list-info']}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span className={styles['skills-list-name']}>{plugin.name || plugin.id}</span>
                        <span className={styles['skills-list-name-hint']}>{plugin.id}</span>
                        {plugin.status && (
                          <span className={marketplaceBadgeClassName}>
                            {plugin.status}
                          </span>
                        )}
                        {plugin.activationState && (
                          <span className={marketplaceBadgeClassName}>
                            {plugin.activationState}
                          </span>
                        )}
                      </div>
                      <span className={styles['skills-list-desc']}>{activationText} · {routeText}</span>
                      <span className={styles['skills-list-desc']}>{capabilityText}</span>
                      {(plugin.error || plugin.activationError) && (
                        <span className={styles['skills-list-desc']} style={{ color: 'var(--danger, #c55)' }}>
                          {plugin.error || plugin.activationError}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
            </>
          )}
        </details>
      </SettingsSection>

      {configPlugin && (
        <PluginConfigEditor
          key={configPlugin.id}
          plugin={configPlugin}
          onClose={closeConfigEditor}
          onSaved={handleConfigSaved}
        />
      )}

      {/* 权限：标准白卡片 row */}
      <SettingsSection title={t('settings.plugins.permissionTitle')}>
        <SettingsRow
          label={t('settings.plugins.fullAccessToggle')}
          hint={t('settings.plugins.fullAccessDesc')}
          control={
            <Toggle
              on={pluginAllowFullAccess}
              onChange={toggleFullAccess}
            />
          }
        />
        <SettingsRow
          label={t('settings.plugins.devToolsToggle')}
          hint={t('settings.plugins.devToolsDesc')}
          control={
            <Toggle
              on={pluginDevToolsEnabled}
              onChange={togglePluginDevTools}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
