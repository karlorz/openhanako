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
}

interface MarketplaceResponse {
  source?: { kind?: string; configured?: boolean; path?: string; url?: string };
  plugins: MarketplacePlugin[];
  warnings?: string[];
  sources?: MarketplaceSourceRow[];
}

function marketVersion(plugin: MarketplacePlugin): string {
  return plugin.selectedVersion || plugin.latestVersion || plugin.version || '0.0.0';
}

function marketInstallLabel(plugin: MarketplacePlugin): string {
  if (plugin.compatible === false || plugin.installAction === 'incompatible') return t('settings.plugins.marketIncompatible');
  if (plugin.installAction === 'downgrade') return t('settings.plugins.marketDowngrade');
  if (plugin.installAction === 'reinstall') return t('settings.plugins.marketReinstall');
  if (plugin.installAction === 'update' || plugin.updateAvailable) return t('settings.plugins.marketUpdate');
  if ((plugin as any).installTarget === 'skills' || (plugin as any).catalogFormat === 'claude') {
    return t('settings.plugins.marketInstallSkills') || 'Install skills';
  }
  return t('settings.plugins.marketInstall');
}

function marketVersionStatus(plugin: MarketplacePlugin): string | null {
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
  // Prefer server canInstall; Claude skills-lane uses install.canInstall; Hana plugins use active/release.
  const serverCanInstall = row.canInstall === true
    || installMeta.canInstall === true
    || (catalogFormat !== 'claude' && !active && row.distribution?.kind === 'release');
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
    canInstall: serverCanInstall && !active,
    installAction: active ? 'reinstall' : 'install',
    compatible: true,
    // surface for install button copy
    ...(catalogFormat ? { catalogFormat } as any : {}),
    ...(installMeta.installTarget ? { installTarget: installMeta.installTarget } as any : {}),
  };
}

export function PluginMarketplaceTab() {
  const showToast = useSettingsStore(s => s.showToast);
  const set = useSettingsStore(s => s.set);
  const [marketplace, setMarketplace] = useState<MarketplaceResponse | null>(null);
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [selectedPlugin, setSelectedPlugin] = useState<MarketplacePlugin | null>(null);
  const [readme, setReadme] = useState('');
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [installingPluginId, setInstallingPluginId] = useState<string | null>(null);
  const [switchingKey, setSwitchingKey] = useState<string | null>(null);
  const loadGenRef = React.useRef(0);
  const readmeGenRef = React.useRef(0);

  const loadReadme = useCallback(async (plugin: MarketplacePlugin) => {
    const gen = ++readmeGenRef.current;
    setSelectedPlugin(plugin);
    setReadme('');
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
      setReadme(data.markdown || '');
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

      try {
        const catalogRes = await hanaFetch('/api/plugins/marketplace/catalog', { timeout: 45_000 });
        const data = await catalogRes.json();
        if (Array.isArray(data.plugins)) {
          plugins = data.plugins.map(mapCatalogRow);
          multiOk = true;
        }
        if (Array.isArray(data.sources)) {
          sources = data.sources;
        }
        if (Array.isArray(data.warnings)) warnings = data.warnings;
      } catch {
        // fall through to legacy
      }

      if (!sources.length) {
        try {
          const sourcesRes = await hanaFetch('/api/plugins/marketplace/sources', { timeout: 45_000 });
          const srcData = await sourcesRes.json();
          if (Array.isArray(srcData.sources)) sources = srcData.sources;
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

      if (gen !== loadGenRef.current) return;

      const next = {
        source: source || {},
        sources,
        plugins,
        warnings,
      };
      setMarketplace(next);

      // Select first plugin without blocking list load on README network.
      if (plugins.length > 0) {
        setSelectedPlugin((prev) => {
          const keep = prev && plugins.some((p) => rowKey(p) === rowKey(prev));
          const pick = keep ? prev! : plugins[0];
          void loadReadme(pick);
          return pick;
        });
      } else {
        setSelectedPlugin(null);
        setReadme('');
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
  }, [loadReadme, showToast]);

  useEffect(() => {
    void loadMarketplace();
  }, [loadMarketplace]);

  const installPlugin = async (plugin: MarketplacePlugin) => {
    const allowDowngrade = plugin.installAction === 'downgrade'
      ? window.confirm(t('settings.plugins.marketDowngradeConfirm', {
          from: plugin.installedVersion || '',
          to: marketVersion(plugin),
        }))
      : false;
    if (plugin.installAction === 'downgrade' && !allowDowngrade) return;

    setInstallingPluginId(rowKey(plugin));
    try {
      const res = await hanaFetch(`/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: plugin.selectedVersion || undefined,
          allowDowngrade,
          marketplaceId: plugin.marketplaceId || undefined,
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

  const sourceCount = marketplace?.sources?.length || 0;
  const pluginCount = marketplace?.plugins?.length || 0;
  const statusText = pluginCount > 0 || sourceCount > 0 || marketplace?.source?.configured
    ? t('settings.plugins.marketplaceCount', { count: String(pluginCount) })
    : t('settings.plugins.marketplaceNoSource');

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
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
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
            title={t('settings.plugins.openMarketplace')}
            onClick={loadMarketplace}
            disabled={marketplaceLoading}
          >
            <svg
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
                  {marketplace.plugins.map(plugin => (
                    <div
                      key={rowKey(plugin)}
                      className={styles['skills-list-item']}
                      onClick={() => loadReadme(plugin)}
                      style={selectedPlugin && rowKey(selectedPlugin) === rowKey(plugin) ? { background: 'var(--bg-hover)' } : undefined}
                    >
                      <div className={styles['skills-list-info']}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span className={styles['skills-list-name']}>{plugin.name}</span>
                          <span className={styles['skills-list-name-hint']}>v{marketVersion(plugin)}</span>
                          {plugin.marketplaceId && (
                            <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                              {plugin.sourceAuthority || plugin.marketplaceId}
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
                          {plugin.marketplaceId ? ` · ${plugin.marketplaceId}` : ''}
                        </span>
                      </div>
                    </div>
                  ))}
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
                                {selectedPlugin.marketplaceId ? ` · ${selectedPlugin.marketplaceId}` : ''}
                              </div>
                              {marketVersionStatus(selectedPlugin) && (
                                <div className={styles['skills-list-desc']}>
                                  {marketVersionStatus(selectedPlugin)}
                                </div>
                              )}
                            </div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <button
                                className={styles['settings-save-btn-sm']}
                                disabled={!selectedPlugin.canInstall || installingPluginId === rowKey(selectedPlugin)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  installPlugin(selectedPlugin);
                                }}
                              >
                                {marketInstallLabel(selectedPlugin)}
                              </button>
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
                              __html: readmeLoading
                                ? `<p>${t('settings.plugins.marketReadmeLoading')}</p>`
                                : renderMarkdown(readme || selectedPlugin.description || ''),
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
      </SettingsSection>
    </div>
  );
}
