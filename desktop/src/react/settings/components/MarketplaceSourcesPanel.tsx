import React, { useCallback, useEffect, useState } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { useSettingsStore } from '../store';
import styles from '../Settings.module.css';

export interface MarketplaceSourceRow {
  id: string;
  name?: string;
  kind?: string;
  authority?: string;
  status?: string;
  mutable?: boolean;
}

export interface MarketplaceSourcesPanelProps {
  /** When true, expand the add form on first mount. */
  defaultShowAdd?: boolean;
  /** Compact layout for embedding under Plugins tab. */
  compact?: boolean;
  onSourcesChanged?: (sources: MarketplaceSourceRow[]) => void;
}

const emptyForm = {
  id: '',
  name: '',
  kind: 'url' as 'url' | 'local' | 'git',
  url: '',
  path: '',
  gitUrl: '',
  gitRef: 'refs/heads/main',
  indexPath: 'marketplace.json',
};

function sourceKindLabel(kind?: string): string {
  if (kind === 'url') return t('settings.plugins.marketSourceKindUrl');
  if (kind === 'local') return t('settings.plugins.marketSourceKindLocal');
  if (kind === 'git') return t('settings.plugins.marketSourceKindGit');
  return kind || 'source';
}

function sourceStatusLabel(status?: string): string {
  if (!status) return '';
  if (status === 'ok') return t('settings.plugins.marketSourceStatusOk');
  if (status === 'stale') return t('settings.plugins.marketSourceStatusStale');
  if (status === 'error') return t('settings.plugins.marketSourceStatusError');
  if (status === 'refreshing') return t('settings.plugins.marketSourceStatusRefreshing');
  return status;
}

function authorityLabel(authority?: string): string {
  if (authority === 'official') return t('settings.plugins.marketSourceAuthorityOfficial');
  if (authority === 'legacy') return t('settings.plugins.marketSourceAuthorityLegacy');
  if (authority === 'custom') return t('settings.plugins.marketSourceAuthorityCustom');
  return authority || '';
}

/**
 * First-class marketplace source list + add/remove/refresh.
 * Uses the same form primitives as Connectors / Providers settings.
 */
export function MarketplaceSourcesPanel({
  defaultShowAdd = false,
  compact = false,
  onSourcesChanged,
}: MarketplaceSourcesPanelProps) {
  const [sources, setSources] = useState<MarketplaceSourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(defaultShowAdd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const showToast = useSettingsStore((s) => s.showToast);

  const loadSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await hanaFetch('/api/plugins/marketplace/sources');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        const msg = data.error || data.detail || `HTTP ${res.status}`;
        // Soft-hint for old servers that still route this as a plugin proxy.
        if (typeof msg === 'string' && /marketplace/i.test(msg) && /not found/i.test(msg)) {
          throw new Error(t('settings.plugins.marketSourceServerTooOld'));
        }
        throw new Error(typeof msg === 'string' ? msg : t('settings.plugins.marketSourceLoadFailed'));
      }
      const list = Array.isArray(data.sources) ? data.sources : [];
      setSources(list);
      onSourcesChanged?.(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setSources([]);
    } finally {
      setLoading(false);
    }
  }, [onSourcesChanged]);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (defaultShowAdd) setShowAdd(true);
  }, [defaultShowAdd]);

  const addSource = async () => {
    const id = form.id.trim();
    const name = form.name.trim() || id;
    if (!id) {
      showToast(t('settings.plugins.marketSourceIdRequired'), 'error');
      return;
    }
    let body: Record<string, string> = { id, name, kind: form.kind };
    if (form.kind === 'url') {
      if (!form.url.trim()) {
        showToast(t('settings.plugins.marketSourceUrlRequired'), 'error');
        return;
      }
      body = { ...body, url: form.url.trim() };
    } else if (form.kind === 'local') {
      if (!form.path.trim()) {
        showToast(t('settings.plugins.marketSourcePathRequired'), 'error');
        return;
      }
      body = {
        ...body,
        path: form.path.trim(),
        ...(form.indexPath.trim() ? { indexPath: form.indexPath.trim() } : {}),
      };
    } else {
      if (!form.gitUrl.trim()) {
        showToast(t('settings.plugins.marketSourceGitUrlRequired'), 'error');
        return;
      }
      body = {
        ...body,
        gitUrl: form.gitUrl.trim(),
        ...(form.gitRef.trim() ? { gitRef: form.gitRef.trim() } : {}),
        ...(form.indexPath.trim() ? { indexPath: form.indexPath.trim() } : {}),
      };
    }
    setBusy(true);
    try {
      const res = await hanaFetch('/api/plugins/marketplace/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || data.detail || t('settings.plugins.marketSourceAddFailed'));
      }
      showToast(t('settings.plugins.marketSourceAdded'), 'success');
      setShowAdd(false);
      setForm(emptyForm);
      await loadSources();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeSource = async (sourceId: string) => {
    if (!window.confirm(t('settings.plugins.marketSourceRemoveConfirm', { id: sourceId }))) return;
    setBusy(true);
    try {
      const res = await hanaFetch(`/api/plugins/marketplace/sources/${encodeURIComponent(sourceId)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || data.detail || t('settings.plugins.marketSourceRemoveFailed'));
      }
      showToast(t('settings.plugins.marketSourceRemoved'), 'success');
      await loadSources();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const refreshSource = async (sourceId: string) => {
    setBusy(true);
    try {
      const res = await hanaFetch(`/api/plugins/marketplace/sources/${encodeURIComponent(sourceId)}/refresh`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || data.detail || t('settings.plugins.marketSourceRefreshFailed'));
      }
      showToast(t('settings.plugins.marketSourceRefreshed'), 'success');
      await loadSources();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles['skills-list-block']} style={compact ? { marginTop: 4 } : undefined}>
      <div className={styles['pv-add-form-actions']} style={{ marginBottom: sources.length || showAdd ? 8 : 0 }}>
        <button
          type="button"
          className={styles['pv-add-form-btn']}
          disabled={busy || loading}
          onClick={() => setShowAdd((v) => !v)}
        >
          {showAdd ? t('settings.plugins.marketSourceCancel') : t('settings.plugins.marketSourceAdd')}
        </button>
        <button
          type="button"
          className={styles['settings-icon-btn']}
          disabled={busy || loading}
          title={t('settings.plugins.marketSourceRefreshAll')}
          onClick={() => loadSources()}
        >
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            className={loading ? styles['spin'] : ''}
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      {error && (
        <div className={styles['settings-form-hint']} style={{ color: 'var(--danger, #c55)', marginBottom: 8 }}>
          {error}
        </div>
      )}

      {loading && sources.length === 0 && !error ? (
        <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`}>
          {t('settings.plugins.marketSourceLoading')}
        </p>
      ) : null}

      {sources.length > 0 && (
        <div className={styles['skills-list-block']}>
          {sources.map((src) => {
            const canMutate = src.mutable !== false && src.authority !== 'official' && src.authority !== 'legacy';
            return (
              <div key={src.id} className={styles['skills-list-item']} style={{ cursor: 'default' }}>
                <div className={styles['skills-list-info']}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span className={styles['skills-list-name']}>{src.name || src.id}</span>
                    {src.authority && (
                      <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                        {authorityLabel(src.authority)}
                      </span>
                    )}
                    {src.status && (
                      <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                        {sourceStatusLabel(src.status)}
                      </span>
                    )}
                  </div>
                  <span className={styles['skills-list-desc']}>
                    {src.id}
                    {src.kind ? ` · ${sourceKindLabel(src.kind)}` : ''}
                  </span>
                </div>
                {canMutate && (
                  <div className={styles['skills-list-actions']}>
                    <button
                      type="button"
                      className={styles['pv-add-form-btn']}
                      disabled={busy}
                      onClick={() => refreshSource(src.id)}
                    >
                      {t('settings.plugins.marketSourceRefresh')}
                    </button>
                    <button
                      type="button"
                      className={`${styles['pv-add-form-btn']} ${styles['danger'] || ''}`}
                      disabled={busy}
                      onClick={() => removeSource(src.id)}
                    >
                      {t('settings.plugins.marketSourceRemove')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loading && sources.length === 0 && !error && (
        <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`}>
          {t('settings.plugins.marketSourceEmpty')}
        </p>
      )}

      {showAdd && (
        <div className={styles['pv-add-form']} style={{ marginTop: 12 }}>
          <div className={styles['settings-form-hint']} style={{ marginBottom: 4 }}>
            {t('settings.plugins.marketSourceAddHint')}
          </div>

          <div className={styles['settings-form-grid']}>
            <div className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
              <label className={styles['settings-form-label']}>{t('settings.plugins.marketSourceId')}</label>
              <input
                className={styles['settings-input']}
                value={form.id}
                onChange={(e) => setForm((s) => ({ ...s, id: e.target.value }))}
                placeholder="team-plugins"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
              <label className={styles['settings-form-label']}>{t('settings.plugins.marketSourceName')}</label>
              <input
                className={styles['settings-input']}
                value={form.name}
                onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
                placeholder="Team Plugins"
              />
            </div>
          </div>

          <div className={styles['settings-form-field']}>
            <label className={styles['settings-form-label']}>{t('settings.plugins.marketSourceKind')}</label>
            <select
              className={styles['settings-input']}
              value={form.kind}
              onChange={(e) => setForm((s) => ({
                ...s,
                kind: e.target.value as 'url' | 'local' | 'git',
              }))}
            >
              <option value="url">{t('settings.plugins.marketSourceKindUrl')}</option>
              <option value="local">{t('settings.plugins.marketSourceKindLocal')}</option>
              <option value="git">{t('settings.plugins.marketSourceKindGit')}</option>
            </select>
          </div>

          {form.kind === 'url' && (
            <div className={styles['settings-form-field']}>
              <label className={styles['settings-form-label']}>URL</label>
              <input
                className={styles['settings-input']}
                value={form.url}
                onChange={(e) => setForm((s) => ({ ...s, url: e.target.value }))}
                placeholder="https://example.com/marketplace.json"
                autoComplete="off"
                spellCheck={false}
              />
              <span className={styles['settings-form-hint']}>{t('settings.plugins.marketSourceUrlHint')}</span>
            </div>
          )}

          {form.kind === 'local' && (
            <>
              <div className={styles['settings-form-field']}>
                <label className={styles['settings-form-label']}>{t('settings.plugins.marketSourceLocalPath')}</label>
                <input
                  className={styles['settings-input']}
                  value={form.path}
                  onChange={(e) => setForm((s) => ({ ...s, path: e.target.value }))}
                  placeholder="my-market"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className={styles['settings-form-hint']}>{t('settings.plugins.marketSourceLocalPathHint')}</span>
              </div>
              <div className={styles['settings-form-field']}>
                <label className={styles['settings-form-label']}>indexPath</label>
                <input
                  className={styles['settings-input']}
                  value={form.indexPath}
                  onChange={(e) => setForm((s) => ({ ...s, indexPath: e.target.value }))}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </>
          )}

          {form.kind === 'git' && (
            <>
              <div className={styles['settings-form-field']}>
                <label className={styles['settings-form-label']}>gitUrl</label>
                <input
                  className={styles['settings-input']}
                  value={form.gitUrl}
                  onChange={(e) => setForm((s) => ({ ...s, gitUrl: e.target.value }))}
                  placeholder="https://github.com/org/repo.git"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className={styles['settings-form-hint']}>{t('settings.plugins.marketSourceGitHint')}</span>
              </div>
              <div className={styles['settings-form-grid']}>
                <div className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
                  <label className={styles['settings-form-label']}>gitRef</label>
                  <input
                    className={styles['settings-input']}
                    value={form.gitRef}
                    onChange={(e) => setForm((s) => ({ ...s, gitRef: e.target.value }))}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
                  <label className={styles['settings-form-label']}>indexPath</label>
                  <input
                    className={styles['settings-input']}
                    value={form.indexPath}
                    onChange={(e) => setForm((s) => ({ ...s, indexPath: e.target.value }))}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </div>
            </>
          )}

          <div className={styles['pv-add-form-actions']}>
            <button
              type="button"
              className={styles['pv-add-form-btn']}
              disabled={busy}
              onClick={() => {
                setShowAdd(false);
                setForm(emptyForm);
              }}
            >
              {t('settings.plugins.marketSourceCancel')}
            </button>
            <button
              type="button"
              className={`${styles['pv-add-form-btn']} ${styles['primary']}`}
              disabled={busy}
              onClick={addSource}
            >
              {busy ? t('status.loading') : t('settings.plugins.marketSourceSubmit')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
