import React, { useCallback, useEffect, useState } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { useSettingsStore } from '../store';
import styles from '../Settings.module.css';
import { AddMarketplaceSourceDialog, type MarketplaceSourceInput } from './AddMarketplaceSourceDialog';
import { RefreshIcon, RemoveIcon } from './PluginActionIcons';
import {
  isMarketplaceRegistryStaleConflict,
  type MarketplaceRegistryPrecondition,
} from '../marketplace-registry';

export interface MarketplaceSourceRow {
  id: string;
  name?: string;
  kind?: string;
  authority?: string;
  status?: string;
  mutable?: boolean;
  enabled?: boolean;
  catalogCount?: number;
  url?: string;
  path?: string;
  gitUrl?: string;
  gitRef?: string;
  indexPath?: string;
  refreshError?: { message?: string; code?: string } | null;
}

type MarketplaceRegistrySnapshot = MarketplaceRegistryPrecondition & {
  degraded?: boolean;
};

type MarketplaceSourcesLoadResult = {
  registry: MarketplaceRegistrySnapshot | null;
  sources: MarketplaceSourceRow[];
};

export interface MarketplaceSourcesPanelProps {
  /** When true, open the add-source dialog on first mount. */
  defaultShowAdd?: boolean;
  /** Render inside a parent surface instead of drawing another card. */
  embedded?: boolean;
  /** Optional inline heading for an embedded source area. */
  heading?: string;
  /** Separate an embedded source area from the content immediately above it. */
  withTopDivider?: boolean;
  onSourcesChanged?: (sources: MarketplaceSourceRow[]) => void;
  /** Called once after each successful source mutation that also yields a refreshed source list. */
}

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

/** Map host/proxy/owner failures to actionable Settings copy. */
export function mapMarketplaceSourceError(message: unknown, status?: number): string {
  const msg = typeof message === 'string' ? message : message != null ? String(message) : '';
  if (status === 403 || /studio\.owner/i.test(msg) || /studio owner/i.test(msg)) {
    return t('settings.plugins.marketSourceStudioOwnerRequired');
  }
  // Old servers still route /plugins/marketplace/* through the plugin catch-all.
  if (/marketplace/i.test(msg) && /not found/i.test(msg)) {
    return t('settings.plugins.marketSourceServerTooOld');
  }
  if (msg) return msg;
  return t('settings.plugins.marketSourceLoadFailed');
}

function authorityLabel(authority?: string): string {
  if (authority === 'official') return t('settings.plugins.marketSourceAuthorityOfficial');
  if (authority === 'legacy') return t('settings.plugins.marketSourceAuthorityLegacy');
  if (authority === 'custom') return t('settings.plugins.marketSourceAuthorityCustom');
  return authority || '';
}

function sourceLocation(source: MarketplaceSourceRow): string {
  if (source.kind === 'git') return source.gitUrl || '[server-owned Git source]';
  if (source.kind === 'url') return source.url || '[server-owned HTTPS source]';
  if (source.kind === 'local') {
    if (source.path === '[redacted]') return '[server-local path redacted]';
    return source.path || '[server-local path]';
  }
  return '[server-owned source]';
}

/**
 * First-class marketplace source list + add/remove/refresh.
 * Uses the same form primitives as Connectors / Providers settings.
 */
export function MarketplaceSourcesPanel({
  defaultShowAdd = false,
  embedded = false,
  heading,
  withTopDivider = false,
  onSourcesChanged,
}: MarketplaceSourcesPanelProps) {
  const [sources, setSources] = useState<MarketplaceSourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(defaultShowAdd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<MarketplaceRegistrySnapshot | null>(null);
  const [isStudioOwner, setIsStudioOwner] = useState<boolean | null>(null);
  const showToast = useSettingsStore((s) => s.showToast);

  const loadSources = useCallback(async (): Promise<MarketplaceSourcesLoadResult | null> => {
    setLoading(true);
    setError(null);
    try {
      const res = await hanaFetch('/api/plugins/marketplace/sources');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(mapMarketplaceSourceError(data.error || data.detail || `HTTP ${res.status}`, res.status));
      }
      const list = Array.isArray(data.sources) ? data.sources : [];
      setSources(list);
      const nextRegistry = data.registry || null;
      setRegistry(nextRegistry);
      setIsStudioOwner(typeof data.access?.isStudioOwner === 'boolean' ? data.access.isStudioOwner : null);
      return { registry: nextRegistry, sources: list };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Soft: keep previous list on transient network abort/fetch failures
      if (!/abort|Failed to fetch/i.test(msg)) {
        setError(mapMarketplaceSourceError(msg));
        setSources([]);
      } else {
        setError((prev) => prev || mapMarketplaceSourceError(msg));
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (defaultShowAdd) setShowAdd(true);
  }, [defaultShowAdd]);

  const reloadAfterMutation = async () => {
    const refreshed = await loadSources();
    if (refreshed) onSourcesChanged?.(refreshed.sources);
  };

  /**
   * Source and package gates share one server-owned registry. A package change
   * can therefore make this panel's earlier source snapshot stale. Refresh and
   * replay this exact source operation once; never weaken server preconditions.
   */
  const withFreshRegistryRetry = async <T,>(
    operation: (snapshot: MarketplaceRegistrySnapshot | null) => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation(registry);
    } catch (err) {
      if (!isMarketplaceRegistryStaleConflict(err)) throw err;
      const fresh = await loadSources();
      if (!fresh?.registry) throw err;
      try {
        return await operation(fresh.registry);
      } catch (retryErr) {
        if (isMarketplaceRegistryStaleConflict(retryErr)) {
          await loadSources();
          throw new Error(t('settings.plugins.marketplaceChangedRetry'));
        }
        throw retryErr;
      }
    }
  };

  const addSource = async (input: MarketplaceSourceInput) => {
    setBusy(true);
    try {
      await withFreshRegistryRetry(async (snapshot) => {
        const body: Record<string, string | number> = {
          source: input.source,
          ...(typeof snapshot?.revision === 'number' ? { expectedRevision: snapshot.revision } : {}),
          ...(snapshot?.digest ? { expectedDigest: snapshot.digest } : {}),
        };
        const res = await hanaFetch('/api/plugins/marketplace/sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          if (isMarketplaceRegistryStaleConflict(data)) throw data;
          throw new Error(
            mapMarketplaceSourceError(data.error || data.detail || t('settings.plugins.marketSourceAddFailed'), res.status),
          );
        }
      });
      showToast(t('settings.plugins.marketSourceAdded'), 'success');
      await reloadAfterMutation();
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
      await withFreshRegistryRetry(async (snapshot) => {
        const query = new URLSearchParams();
        if (typeof snapshot?.revision === 'number') query.set('expectedRevision', String(snapshot.revision));
        if (snapshot?.digest) query.set('expectedDigest', snapshot.digest);
        const suffix = query.size ? `?${query.toString()}` : '';
        const res = await hanaFetch(`/api/plugins/marketplace/sources/${encodeURIComponent(sourceId)}${suffix}`, {
          method: 'DELETE',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          if (isMarketplaceRegistryStaleConflict(data)) throw data;
          throw new Error(data.error || data.detail || t('settings.plugins.marketSourceRemoveFailed'));
        }
      });
      showToast(t('settings.plugins.marketSourceRemoved'), 'success');
      await reloadAfterMutation();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const setSourceEnabled = async (source: MarketplaceSourceRow, enabled: boolean) => {
    const operation = enabled
      ? t('settings.plugins.marketSourceEnable')
      : t('settings.plugins.marketSourceDisable');
    if (!window.confirm(t('settings.plugins.marketSourceToggleConfirm', { operation, id: source.id }))) return;
    setBusy(true);
    try {
      await withFreshRegistryRetry(async (snapshot) => {
        const res = await hanaFetch(`/api/plugins/marketplace/sources/${encodeURIComponent(source.id)}/enabled`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled,
            ...(typeof snapshot?.revision === 'number' ? { expectedRevision: snapshot.revision } : {}),
            ...(snapshot?.digest ? { expectedDigest: snapshot.digest } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          if (isMarketplaceRegistryStaleConflict(data)) throw data;
          throw new Error(data.error || `${t('settings.plugins.marketSourceToggleFailed')}: ${source.id}`);
        }
      });
      showToast(t('settings.plugins.marketSourceToggleSuccess', {
        id: source.id,
        state: enabled ? t('settings.plugins.marketSourceEnabled') : t('settings.plugins.marketSourceDisabled'),
      }), 'success');
      await reloadAfterMutation();
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
      await reloadAfterMutation();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={embedded
      ? `${styles['marketplace-sources-panel']} ${withTopDivider ? styles['marketplace-sources-panel-divided'] : ''}`
      : styles['skills-list-block']}
    >
      <div className={styles['marketplace-sources-header']}>
        {heading && <span className={styles['marketplace-sources-title']}>{heading}</span>}
        <div className={styles['pv-add-form-actions']}>
          <button
            type="button"
            className={`${styles['pv-add-form-btn']} ${styles['plugin-add-source-btn']}`}
            disabled={busy || loading || isStudioOwner === false || registry?.degraded === true}
            onClick={() => setShowAdd(true)}
          >
            <span aria-hidden="true">＋</span>{' '}
            {t('settings.plugins.marketSourceAdd')}
          </button>
          <button
            type="button"
            className={styles['settings-icon-btn']}
            disabled={busy || loading}
            aria-label={t('settings.plugins.marketSourceRefreshAll')}
            title={t('settings.plugins.marketSourceRefreshAll')}
            onClick={() => loadSources()}
          >
            <RefreshIcon spinning={loading} />
          </button>
        </div>
      </div>

      {error && (
        <div className={styles['settings-form-hint']} style={{ color: 'var(--danger, #c55)', marginBottom: 8 }}>
          {error}
        </div>
      )}

      {isStudioOwner === false && !error && (
        <div className={styles['settings-form-hint']} role="status" style={{ marginBottom: 8 }}>
          {t('settings.plugins.marketSourceReadOnly')}
        </div>
      )}

      {registry?.degraded && !error && (
        <div className={styles['settings-form-hint']} role="alert" style={{ color: 'var(--danger, #c55)', marginBottom: 8 }}>
          {t('settings.plugins.marketSourceDegraded')}
        </div>
      )}

      {loading && sources.length === 0 && !error ? (
        <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`}>
          {t('settings.plugins.marketSourceLoading')}
        </p>
      ) : null}

      {sources.length > 0 && (
        <div className={embedded ? styles['marketplace-sources-list'] : styles['skills-list-block']}>
          {sources.map((src) => {
            const canMutate = isStudioOwner !== false && !registry?.degraded
              && src.mutable !== false && src.authority !== 'official' && src.authority !== 'legacy';
            const location = sourceLocation(src);
            return (
              <div
                key={src.id}
                className={`${styles['skills-list-item']} ${styles['marketplace-source-row']}`}
                style={{ cursor: 'default' }}
              >
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
                    <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                      {src.enabled === false
                        ? t('settings.plugins.marketSourceDisabled')
                        : t('settings.plugins.marketSourceEnabled')}
                    </span>
                    <span className={styles['skills-source-badge']} style={{ marginRight: 0 }}>
                      {t('settings.plugins.marketSourcePackages', { count: String(src.catalogCount || 0) })}
                    </span>
                  </div>
                  <span className={styles['skills-list-desc']}>
                    {src.id}
                    {src.kind ? ` · ${sourceKindLabel(src.kind)}` : ''}
                  </span>
                  <span className={styles['skills-list-desc']} title={location}>
                    {location}
                    {src.gitRef ? ` · ${src.gitRef}` : ''}
                    {src.indexPath ? ` · ${src.indexPath}` : ''}
                  </span>
                  {src.refreshError?.message && (
                    <span className={styles['skills-list-desc']} style={{ color: 'var(--danger, #c55)' }}>
                      {src.refreshError.message}
                    </span>
                  )}
                </div>
                {canMutate && (
                  <div className={`${styles['skills-list-actions']} ${styles['marketplace-source-actions']}`}>
                    <button
                      type="button"
                      className={`${styles['settings-icon-btn']} ${styles['plugin-action-icon']}`}
                      disabled={busy}
                      onClick={() => refreshSource(src.id)}
                      aria-label={t('settings.plugins.marketSourceRefreshNamed', { id: src.id })}
                      title={t('settings.plugins.marketSourceRefreshNamed', { id: src.id })}
                    >
                      <RefreshIcon />
                    </button>
                    <button
                      type="button"
                      className={`${styles['settings-icon-btn']} ${styles['plugin-action-icon']} ${styles['plugin-action-danger']}`}
                      disabled={busy}
                      onClick={() => removeSource(src.id)}
                      aria-label={t('settings.plugins.marketSourceRemoveNamed', { id: src.id })}
                      title={t('settings.plugins.marketSourceRemoveNamed', { id: src.id })}
                    >
                      <RemoveIcon />
                    </button>
                    <button
                      type="button"
                      className={`hana-toggle${src.enabled === false ? '' : ' on'}`}
                      disabled={busy}
                      onClick={() => setSourceEnabled(src, src.enabled === false)}
                      aria-label={`${src.enabled === false ? t('settings.plugins.marketSourceEnable') : t('settings.plugins.marketSourceDisable')} ${src.id}`}
                      title={`${src.enabled === false ? t('settings.plugins.marketSourceEnable') : t('settings.plugins.marketSourceDisable')} ${src.id}`}
                    />
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

      <AddMarketplaceSourceDialog
        open={showAdd}
        onSubmit={addSource}
        onClose={() => setShowAdd(false)}
      />
    </div>
  );
}
