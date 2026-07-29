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

/**
 * First-class marketplace source list + add/remove/refresh.
 * Used on Settings → Plugins and on the marketplace browse subpage.
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

  const loadSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await hanaFetch('/api/plugins/marketplace/sources');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
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

  const showToast = useSettingsStore((s) => s.showToast);
  const toast = (message: string, type: 'success' | 'error') => {
    showToast(message, type);
  };

  const addSource = async () => {
    const id = form.id.trim();
    const name = form.name.trim() || id;
    if (!id) {
      toast(t('settings.plugins.marketSourceIdRequired'), 'error');
      return;
    }
    let body: Record<string, string> = { id, name, kind: form.kind };
    if (form.kind === 'url') {
      if (!form.url.trim()) {
        toast(t('settings.plugins.marketSourceUrlRequired'), 'error');
        return;
      }
      body = { ...body, url: form.url.trim() };
    } else if (form.kind === 'local') {
      if (!form.path.trim()) {
        toast(t('settings.plugins.marketSourcePathRequired'), 'error');
        return;
      }
      body = {
        ...body,
        path: form.path.trim(),
        ...(form.indexPath.trim() ? { indexPath: form.indexPath.trim() } : {}),
      };
    } else {
      if (!form.gitUrl.trim()) {
        toast(t('settings.plugins.marketSourceGitUrlRequired'), 'error');
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
        throw new Error(data.error || t('settings.plugins.marketSourceAddFailed'));
      }
      toast(t('settings.plugins.marketSourceAdded'), 'success');
      setShowAdd(false);
      setForm(emptyForm);
      await loadSources();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : String(err), 'error');
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
        throw new Error(data.error || t('settings.plugins.marketSourceRemoveFailed'));
      }
      toast(t('settings.plugins.marketSourceRemoved'), 'success');
      await loadSources();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : String(err), 'error');
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
        throw new Error(data.error || t('settings.plugins.marketSourceRefreshFailed'));
      }
      toast(t('settings.plugins.marketSourceRefreshed'), 'success');
      await loadSources();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles['skills-list-block']} style={compact ? { marginTop: 8 } : undefined}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        {loading && sources.length === 0 ? (
          <span className={styles['skills-list-desc']}>{t('settings.plugins.marketSourceLoading')}</span>
        ) : (
          sources.map((src) => (
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
                    disabled={busy}
                    title={t('settings.plugins.marketSourceRefresh')}
                    onClick={() => refreshSource(src.id)}
                  >
                    ↻
                  </button>
                  <button
                    type="button"
                    className={styles['settings-icon-btn']}
                    style={{ width: 18, height: 18 }}
                    disabled={busy}
                    title={t('settings.plugins.marketSourceRemove')}
                    onClick={() => removeSource(src.id)}
                  >
                    ×
                  </button>
                </>
              )}
            </span>
          ))
        )}
        <button
          type="button"
          className={styles['settings-save-btn-sm']}
          disabled={busy}
          onClick={() => setShowAdd((v) => !v)}
        >
          {showAdd ? t('settings.plugins.marketSourceCancel') : t('settings.plugins.marketSourceAdd')}
        </button>
      </div>

      {error && (
        <p className={styles['skills-list-desc']} style={{ color: 'var(--danger, #c55)', marginBottom: 8 }}>
          {error}
        </p>
      )}

      {showAdd && (
        <div
          className={styles['skills-list-item']}
          style={{ cursor: 'default', flexDirection: 'column', alignItems: 'stretch', gap: 8, padding: 12 }}
        >
          <div className={styles['skills-list-desc']}>{t('settings.plugins.marketSourceAddHint')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label className={styles['skills-list-desc']}>
              {t('settings.plugins.marketSourceId')}
              <input
                style={{ display: 'block', width: '100%', marginTop: 4 }}
                value={form.id}
                onChange={(e) => setForm((s) => ({ ...s, id: e.target.value }))}
                placeholder="team-plugins"
              />
            </label>
            <label className={styles['skills-list-desc']}>
              {t('settings.plugins.marketSourceName')}
              <input
                style={{ display: 'block', width: '100%', marginTop: 4 }}
                value={form.name}
                onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
                placeholder="Team Plugins"
              />
            </label>
            <label className={styles['skills-list-desc']}>
              {t('settings.plugins.marketSourceKind')}
              <select
                style={{ display: 'block', width: '100%', marginTop: 4 }}
                value={form.kind}
                onChange={(e) => setForm((s) => ({
                  ...s,
                  kind: e.target.value as 'url' | 'local' | 'git',
                }))}
              >
                <option value="url">url (HTTPS catalog)</option>
                <option value="local">local (server path)</option>
                <option value="git">git (public HTTPS)</option>
              </select>
            </label>
            {form.kind === 'url' && (
              <label className={styles['skills-list-desc']} style={{ gridColumn: '1 / -1' }}>
                URL
                <input
                  style={{ display: 'block', width: '100%', marginTop: 4 }}
                  value={form.url}
                  onChange={(e) => setForm((s) => ({ ...s, url: e.target.value }))}
                  placeholder="https://example.com/marketplace.json"
                />
              </label>
            )}
            {form.kind === 'local' && (
              <>
                <label className={styles['skills-list-desc']} style={{ gridColumn: '1 / -1' }}>
                  {t('settings.plugins.marketSourceLocalPath')}
                  <input
                    style={{ display: 'block', width: '100%', marginTop: 4 }}
                    value={form.path}
                    onChange={(e) => setForm((s) => ({ ...s, path: e.target.value }))}
                    placeholder="my-market"
                  />
                </label>
                <label className={styles['skills-list-desc']}>
                  indexPath
                  <input
                    style={{ display: 'block', width: '100%', marginTop: 4 }}
                    value={form.indexPath}
                    onChange={(e) => setForm((s) => ({ ...s, indexPath: e.target.value }))}
                  />
                </label>
              </>
            )}
            {form.kind === 'git' && (
              <>
                <label className={styles['skills-list-desc']} style={{ gridColumn: '1 / -1' }}>
                  gitUrl
                  <input
                    style={{ display: 'block', width: '100%', marginTop: 4 }}
                    value={form.gitUrl}
                    onChange={(e) => setForm((s) => ({ ...s, gitUrl: e.target.value }))}
                    placeholder="https://github.com/org/repo.git"
                  />
                </label>
                <label className={styles['skills-list-desc']}>
                  gitRef
                  <input
                    style={{ display: 'block', width: '100%', marginTop: 4 }}
                    value={form.gitRef}
                    onChange={(e) => setForm((s) => ({ ...s, gitRef: e.target.value }))}
                  />
                </label>
                <label className={styles['skills-list-desc']}>
                  indexPath
                  <input
                    style={{ display: 'block', width: '100%', marginTop: 4 }}
                    value={form.indexPath}
                    onChange={(e) => setForm((s) => ({ ...s, indexPath: e.target.value }))}
                  />
                </label>
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className={styles['settings-save-btn-sm']}
              disabled={busy}
              onClick={addSource}
            >
              {t('settings.plugins.marketSourceSubmit')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
