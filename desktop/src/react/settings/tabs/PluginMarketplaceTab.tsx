import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { SettingsSection } from '../components/SettingsSection';
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

interface MarketplaceSourceRow {
  id: string;
  name?: string;
  kind?: string;
  authority?: string;
  status?: string;
  mutable?: boolean;
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
  const [showAddSource, setShowAddSource] = useState(false);
  const [sourceForm, setSourceForm] = useState({
    id: '',
    name: '',
    kind: 'url' as 'url' | 'local' | 'git',
    url: '',
    path: '',
    gitUrl: '',
    gitRef: 'refs/heads/main',
    indexPath: 'marketplace.json',
  });
  const [sourceBusy, setSourceBusy] = useState(false);

  const loadReadme = useCallback(async (plugin: MarketplacePlugin) => {
    setSelectedPlugin(plugin);
    setReadme('');
    setReadmeLoading(true);
    try {
      const qs = plugin.marketplaceId
        ? `?marketplaceId=${encodeURIComponent(plugin.marketplaceId)}`
        : '';
      const res = await hanaFetch(`/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/readme${qs}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setReadme(data.markdown || '');
    } catch (err: unknown) {
      showToast(t('settings.plugins.marketReadmeLoadError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setReadmeLoading(false);
    }
  }, [showToast]);

  const loadMarketplace = useCallback(async () => {
    setMarketplaceLoading(true);
    try {
      // Prefer multi-source catalog when available; fall back to legacy single marketplace list.
      let data: any = null;
      let sources: MarketplaceSourceRow[] = [];
      try {
        const [catalogRes, sourcesRes] = await Promise.all([
          hanaFetch('/api/plugins/marketplace/catalog'),
          hanaFetch('/api/plugins/marketplace/sources'),
        ]);
        if (catalogRes.ok) {
          data = await catalogRes.json();
          if (Array.isArray(data.plugins)) {
            data.plugins = data.plugins.map((row: any) => ({
              id: row.pluginId || row.id,
              name: row.name,
              version: row.version,
              description: row.description,
              publisher: row.publisher,
              trust: row.trust,
              distribution: row.distribution,
              marketplaceId: row.marketplaceId,
              compositeKey: row.compositeKey || `${row.pluginId || row.id}@${row.marketplaceId}`,
              sourceAuthority: row.sourceAuthority,
              sourceStatus: row.sourceStatus,
              active: row.active,
              retained: row.retained,
              installed: !!row.active,
              canInstall: !row.active,
              installAction: row.active ? 'reinstall' : 'install',
              compatible: true,
            }));
          }
        }
        if (sourcesRes.ok) {
          const srcData = await sourcesRes.json();
          sources = Array.isArray(srcData.sources) ? srcData.sources : [];
        }
      } catch {
        data = null;
      }
      if (!data || data.error || !Array.isArray(data.plugins)) {
        const res = await hanaFetch('/api/plugins/marketplace');
        data = await res.json();
        if (data.error) throw new Error(data.error);
      }
      const plugins = Array.isArray(data.plugins) ? data.plugins : [];
      const next = {
        source: data.source || {},
        sources: sources.length ? sources : data.sources || [],
        plugins,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
      };
      setMarketplace(next);
      if (plugins.length > 0) {
        await loadReadme(plugins[0]);
      } else {
        setSelectedPlugin(null);
        setReadme('');
      }
    } catch (err: unknown) {
      showToast(t('settings.plugins.marketLoadError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setMarketplaceLoading(false);
    }
  }, [loadReadme, showToast]);

  useEffect(() => {
    loadMarketplace();
  }, [loadMarketplace]);

  const addMarketplaceSource = async () => {
    const id = sourceForm.id.trim();
    const name = sourceForm.name.trim() || id;
    if (!id) {
      showToast(t('settings.plugins.marketSourceIdRequired'), 'error');
      return;
    }
    let body: Record<string, string> = { id, name, kind: sourceForm.kind };
    if (sourceForm.kind === 'url') {
      if (!sourceForm.url.trim()) {
        showToast(t('settings.plugins.marketSourceUrlRequired'), 'error');
        return;
      }
      body = { ...body, url: sourceForm.url.trim() };
    } else if (sourceForm.kind === 'local') {
      if (!sourceForm.path.trim()) {
        showToast(t('settings.plugins.marketSourcePathRequired'), 'error');
        return;
      }
      body = {
        ...body,
        path: sourceForm.path.trim(),
        ...(sourceForm.indexPath.trim() ? { indexPath: sourceForm.indexPath.trim() } : {}),
      };
    } else {
      if (!sourceForm.gitUrl.trim()) {
        showToast(t('settings.plugins.marketSourceGitUrlRequired'), 'error');
        return;
      }
      body = {
        ...body,
        gitUrl: sourceForm.gitUrl.trim(),
        ...(sourceForm.gitRef.trim() ? { gitRef: sourceForm.gitRef.trim() } : {}),
        ...(sourceForm.indexPath.trim() ? { indexPath: sourceForm.indexPath.trim() } : {}),
      };
    }
    setSourceBusy(true);
    try {
      const res = await hanaFetch('/api/plugins/marketplace/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || t('settings.plugins.marketSourceAddFailed'));
      showToast(t('settings.plugins.marketSourceAdded'), 'success');
      setShowAddSource(false);
      setSourceForm({
        id: '',
        name: '',
        kind: 'url',
        url: '',
        path: '',
        gitUrl: '',
        gitRef: 'refs/heads/main',
        indexPath: 'marketplace.json',
      });
      await loadMarketplace();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSourceBusy(false);
    }
  };

  const removeMarketplaceSource = async (sourceId: string) => {
    if (!window.confirm(t('settings.plugins.marketSourceRemoveConfirm', { id: sourceId }))) return;
    setSourceBusy(true);
    try {
      const res = await hanaFetch(`/api/plugins/marketplace/sources/${encodeURIComponent(sourceId)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || t('settings.plugins.marketSourceRemoveFailed'));
      showToast(t('settings.plugins.marketSourceRemoved'), 'success');
      await loadMarketplace();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSourceBusy(false);
    }
  };

  const refreshMarketplaceSource = async (sourceId: string) => {
    setSourceBusy(true);
    try {
      const res = await hanaFetch(`/api/plugins/marketplace/sources/${encodeURIComponent(sourceId)}/refresh`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || t('settings.plugins.marketSourceRefreshFailed'));
      showToast(t('settings.plugins.marketSourceRefreshed'), 'success');
      await loadMarketplace();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSourceBusy(false);
    }
  };

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

  const statusText = marketplace?.source?.configured
    ? t('settings.plugins.marketplaceCount', { count: String(marketplace.plugins.length) })
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
        {!marketplace ? (
          <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`}>
            {t('settings.plugins.marketLoading')}
          </p>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                {(marketplace.sources || []).map((src) => (
                  <span
                    key={src.id}
                    className={styles['skills-source-badge']}
                    title={`${src.id} · ${src.status || 'unknown'}`}
                    style={{ marginRight: 0, alignItems: 'center', gap: 4, display: 'inline-flex' }}
                  >
                    {(src.authority || src.kind || 'source') + ': ' + (src.name || src.id)}
                    {src.status ? ` (${src.status})` : ''}
                    {src.mutable !== false && src.authority !== 'official' && (
                      <>
                        <button
                          type="button"
                          className={styles['settings-icon-btn']}
                          style={{ width: 18, height: 18, marginLeft: 4 }}
                          disabled={sourceBusy}
                          title={t('settings.plugins.marketSourceRefresh')}
                          onClick={(e) => {
                            e.stopPropagation();
                            refreshMarketplaceSource(src.id);
                          }}
                        >
                          ↻
                        </button>
                        <button
                          type="button"
                          className={styles['settings-icon-btn']}
                          style={{ width: 18, height: 18 }}
                          disabled={sourceBusy}
                          title={t('settings.plugins.marketSourceRemove')}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeMarketplaceSource(src.id);
                          }}
                        >
                          ×
                        </button>
                      </>
                    )}
                  </span>
                ))}
                <button
                  type="button"
                  className={styles['settings-save-btn-sm']}
                  disabled={sourceBusy}
                  onClick={() => setShowAddSource((v) => !v)}
                >
                  {showAddSource ? t('settings.plugins.marketSourceCancel') : t('settings.plugins.marketSourceAdd')}
                </button>
              </div>
              {showAddSource && (
                <div
                  className={styles['skills-list-item']}
                  style={{ cursor: 'default', flexDirection: 'column', alignItems: 'stretch', gap: 8, padding: 12 }}
                >
                  <div className={styles['skills-list-desc']}>{t('settings.plugins.marketSourceAddHint')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <label className={styles['skills-list-desc']}>
                      {t('settings.plugins.marketSourceId')}
                      <input
                        className={styles['settings-input'] || undefined}
                        style={{ display: 'block', width: '100%', marginTop: 4 }}
                        value={sourceForm.id}
                        onChange={(e) => setSourceForm((s) => ({ ...s, id: e.target.value }))}
                        placeholder="team-plugins"
                      />
                    </label>
                    <label className={styles['skills-list-desc']}>
                      {t('settings.plugins.marketSourceName')}
                      <input
                        style={{ display: 'block', width: '100%', marginTop: 4 }}
                        value={sourceForm.name}
                        onChange={(e) => setSourceForm((s) => ({ ...s, name: e.target.value }))}
                        placeholder="Team Plugins"
                      />
                    </label>
                    <label className={styles['skills-list-desc']}>
                      {t('settings.plugins.marketSourceKind')}
                      <select
                        style={{ display: 'block', width: '100%', marginTop: 4 }}
                        value={sourceForm.kind}
                        onChange={(e) => setSourceForm((s) => ({
                          ...s,
                          kind: e.target.value as 'url' | 'local' | 'git',
                        }))}
                      >
                        <option value="url">url (HTTPS catalog)</option>
                        <option value="local">local (server path)</option>
                        <option value="git">git (public HTTPS)</option>
                      </select>
                    </label>
                    {sourceForm.kind === 'url' && (
                      <label className={styles['skills-list-desc']} style={{ gridColumn: '1 / -1' }}>
                        URL
                        <input
                          style={{ display: 'block', width: '100%', marginTop: 4 }}
                          value={sourceForm.url}
                          onChange={(e) => setSourceForm((s) => ({ ...s, url: e.target.value }))}
                          placeholder="https://example.com/marketplace.json"
                        />
                      </label>
                    )}
                    {sourceForm.kind === 'local' && (
                      <>
                        <label className={styles['skills-list-desc']} style={{ gridColumn: '1 / -1' }}>
                          {t('settings.plugins.marketSourceLocalPath')}
                          <input
                            style={{ display: 'block', width: '100%', marginTop: 4 }}
                            value={sourceForm.path}
                            onChange={(e) => setSourceForm((s) => ({ ...s, path: e.target.value }))}
                            placeholder="my-market"
                          />
                        </label>
                        <label className={styles['skills-list-desc']}>
                          indexPath
                          <input
                            style={{ display: 'block', width: '100%', marginTop: 4 }}
                            value={sourceForm.indexPath}
                            onChange={(e) => setSourceForm((s) => ({ ...s, indexPath: e.target.value }))}
                          />
                        </label>
                      </>
                    )}
                    {sourceForm.kind === 'git' && (
                      <>
                        <label className={styles['skills-list-desc']} style={{ gridColumn: '1 / -1' }}>
                          gitUrl
                          <input
                            style={{ display: 'block', width: '100%', marginTop: 4 }}
                            value={sourceForm.gitUrl}
                            onChange={(e) => setSourceForm((s) => ({ ...s, gitUrl: e.target.value }))}
                            placeholder="https://github.com/org/repo.git"
                          />
                        </label>
                        <label className={styles['skills-list-desc']}>
                          gitRef
                          <input
                            style={{ display: 'block', width: '100%', marginTop: 4 }}
                            value={sourceForm.gitRef}
                            onChange={(e) => setSourceForm((s) => ({ ...s, gitRef: e.target.value }))}
                          />
                        </label>
                        <label className={styles['skills-list-desc']}>
                          indexPath
                          <input
                            style={{ display: 'block', width: '100%', marginTop: 4 }}
                            value={sourceForm.indexPath}
                            onChange={(e) => setSourceForm((s) => ({ ...s, indexPath: e.target.value }))}
                          />
                        </label>
                      </>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className={styles['settings-save-btn-sm']}
                      disabled={sourceBusy}
                      onClick={addMarketplaceSource}
                    >
                      {t('settings.plugins.marketSourceSubmit')}
                    </button>
                  </div>
                </div>
              )}
            </div>
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
