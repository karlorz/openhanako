import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { SettingsSection } from '../components/SettingsSection';
import { MarketplaceSourcesPanel } from '../components/MarketplaceSourcesPanel';
import { RefreshIcon } from '../components/PluginActionIcons';
import { renderMarkdown } from '../../utils/markdown';
import styles from '../Settings.module.css';
import type { MarketplacePlugin } from '../marketplace-types';
import {
  marketAdapterLabel,
  marketConfirmationLabel,
  marketTargetLabel,
  marketVersion,
  rowKey,
  sourceQualifiedId,
  warningMessages,
  useMarketplaceData,
} from '../hooks/useMarketplaceData';
import { useMarketplaceActions } from '../hooks/useMarketplaceActions';
import { MarketplacePluginInspector } from '../components/marketplace/MarketplacePluginInspector';

const marketplaceBadgeClassName = `${styles['skills-source-badge']} ${styles['plugin-marketplace-badge']}`;

export function PluginMarketplaceTab() {
  const set = useSettingsStore(s => s.set);
  const agents = useSettingsStore(s => s.agents) || [];
  const {
    marketplace,
    loading,
    loadMarketplace,
    selectedPlugin,
    selectPlugin,
    selectedAgentId,
    setSelectedAgentId,
    updateMarketplacePlugin,
    rowCount,
  } = useMarketplaceData();
  const actions = useMarketplaceActions({
    marketplace,
    reload: loadMarketplace,
    selectedAgentId,
    updateMarketplacePlugin,
  });
  const [readme, setReadme] = useState('');
  const [readmeLoading, setReadmeLoading] = useState(false);
  const readmeGenRef = React.useRef(0);
  const readmeKeyRef = React.useRef<string | null>(null);

  const loadReadme = useCallback(async (plugin: MarketplacePlugin, opts: { force?: boolean } = {}) => {
    const key = rowKey(plugin);

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

  // Selection changes (list clicks or catalog refresh picks) drive the readme load.
  useEffect(() => {
    if (!selectedPlugin) {
      setReadme('');
      readmeKeyRef.current = null;
      return;
    }
    void loadReadme(selectedPlugin);
  }, [loadReadme, selectedPlugin]);

  const sourceCount = marketplace?.sources?.length || 0;
  const statusText = marketplace?.capabilities?.supported !== false
    ? t('settings.plugins.marketplaceCount', { count: String(rowCount) })
    : t('settings.plugins.marketplaceNoSource');
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
            <span className={marketplaceBadgeClassName}>
              {statusText}
            </span>
          )}
          <button
            type="button"
            className={styles['settings-icon-btn']}
            aria-label={t('settings.plugins.reload')}
            title={t('settings.plugins.reload')}
            onClick={() => { void loadMarketplace(); }}
            disabled={loading}
          >
            <RefreshIcon spinning={loading} />
          </button>
        </div>
      </div>

      <SettingsSection surface="plain">
        <section className={styles['plugin-marketplace-summary']} aria-labelledby="marketplace-server-scope">
          <div className={styles['plugin-marketplace-summary-main']}>
            <div className={styles['plugin-marketplace-scope-heading']}>
              <div>
                <h3 id="marketplace-server-scope">{t('settings.plugins.marketServerRuntimeSources')}</h3>
                <p>{t('settings.plugins.marketSummaryScope')}</p>
              </div>
              <span className={styles['skills-source-badge']}>
                {marketplace?.capabilities?.supported === false ? 'Unsupported server' : t('settings.plugins.marketSupportedServer')}
              </span>
            </div>
            <div className={styles['plugin-marketplace-scope-facts']}>
              <span>{sourceCount} source{sourceCount === 1 ? '' : 's'}</span>
              <span>{rowCount} package{rowCount === 1 ? '' : 's'}</span>
              <span>revision {marketplace?.registry?.revision ?? '—'}</span>
              <span>{marketplace?.registry?.degraded ? 'degraded / last-known-good' : 'configuration valid'}</span>
              <span>{marketplace?.access?.isStudioOwner === false ? 'needs owner for changes' : 'owner actions available'}</span>
            </div>
          </div>
          <div className={styles['plugin-marketplace-summary-agent']} aria-labelledby="marketplace-agent-scope">
            <label className={styles['plugin-marketplace-agent-select']}>
              <span id="marketplace-agent-scope">{t('settings.plugins.marketSummaryAgentAccess')}</span>
              <select
                value={selectedAgentId || ''}
                onChange={(event) => setSelectedAgentId(event.target.value || null)}
                aria-label={t('settings.plugins.marketAgentForNativeAccess')}
              >
                {!selectedAgentId && <option value="">{t('settings.plugins.marketSummarySelectAgent')}</option>}
                {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
              </select>
            </label>
            <p className={styles['settings-form-hint']}>
              Routes, providers, extensions, lifecycle/background behavior, and full-access policy remain server-global owner-reviewed state. This is not per-Agent sandboxing.
            </p>
          </div>
        </section>

        <MarketplaceSourcesPanel
          embedded
          heading={t('settings.plugins.marketSourcesSection')}
          // Debounce parent reloads: sources panel already lists sources; only refresh catalog after mutations.
          onSourcesChanged={() => {
            window.setTimeout(() => { void loadMarketplace({ silent: true }); }, 100);
          }}
        />
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
                        onClick={() => selectPlugin(plugin)}
                        aria-pressed={selectedPlugin ? rowKey(selectedPlugin) === rowKey(plugin) : false}
                        aria-label={`Inspect ${sourceQualifiedId(plugin)}`}
                        style={selectedPlugin && rowKey(selectedPlugin) === rowKey(plugin) ? { background: 'var(--bg-hover)' } : undefined}
                      >
                        <div className={styles['skills-list-info']}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            <span className={styles['skills-list-name']}>{plugin.name}</span>
                            <span className={styles['skills-list-name-hint']}>v{marketVersion(plugin)}</span>
                            {plugin.marketplaceId && (
                              <span className={marketplaceBadgeClassName}>
                                {sourceQualifiedId(plugin)}
                              </span>
                            )}
                            {plugin.installTarget && (
                              <span className={marketplaceBadgeClassName}>
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
                              <span className={marketplaceBadgeClassName}>
                                {plugin.packageInstall?.state === 'partial'
                                  ? 'partial'
                                  : plugin.packageInstall?.state === 'stale-record'
                                    ? 'stale record'
                                    : t('settings.plugins.marketInstalled')}
                              </span>
                            )}
                            {plugin.retained && !plugin.active && (
                              <span className={marketplaceBadgeClassName}>
                                {t('settings.plugins.marketRetainedBadge')}
                              </span>
                            )}
                            {plugin.updateAvailable && (
                              <span className={marketplaceBadgeClassName}>
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
                          <MarketplacePluginInspector
                            plugin={selectedPlugin}
                            marketplace={marketplace}
                            actions={actions}
                            selectedAgentId={selectedAgentId}
                          />
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
            <summary>{t('settings.plugins.marketAdvancedJsonConfig')}</summary>
            <div className={styles['plugin-marketplace-advanced-body']}>
              <section aria-labelledby="marketplace-json-config">
                <h3 id="marketplace-json-config">{t('settings.plugins.marketConfigAsCodeDiagnostics')}</h3>
                <p className={styles['settings-form-hint']}>
                  Advanced owner/operator view only. Use normal source and access controls for routine changes; direct JSON edits are revision-checked and keep the last-known-good state when invalid.
                </p>
                <div className={styles['plugin-marketplace-inspector']}>
                  <div className={styles['plugin-marketplace-property-row']}>
                    <span>{t('settings.plugins.marketConfigStatus')}</span>
                    <strong>{marketplace.configDiagnostics?.degraded ? 'Invalid edit · last-known-good active' : 'Valid'}</strong>
                  </div>
                  <div className={styles['plugin-marketplace-property-row']}>
                    <span>{t('settings.plugins.marketServerLocalPath')}</span>
                    <code translate="no">{marketplace.configDiagnostics?.path || marketplace.registry?.path || 'Unavailable'}</code>
                  </div>
                  <div className={styles['plugin-marketplace-property-row']}>
                    <span>{t('settings.plugins.marketLastValidRevision')}</span>
                    <strong>{marketplace.configDiagnostics?.summary?.revision ?? marketplace.registry?.revision ?? '—'}</strong>
                  </div>
                  <div className={styles['plugin-marketplace-property-row']}>
                    <span>{t('settings.plugins.marketDigest')}</span>
                    <code translate="no">{marketplace.configDiagnostics?.digest || marketplace.registry?.digest || '—'}</code>
                  </div>
                  {configDiagnostics.length > 0 && (
                    <div className={styles['plugin-marketplace-warnings']} role="status">
                      <span>{t('settings.plugins.marketDiagnosticsRepairGuidance')}</span>
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
                <h3 id="marketplace-claude-bindings">{t('settings.plugins.marketClaudeCompatBindings')}</h3>
                <p className={styles['settings-form-hint']}>
                  Live, mirror, and snapshot bindings read only explicitly authorized paths. Secret-bearing settings, hooks, MCP/LSP, commands, binaries, lifecycle scripts, monitors, and permission policy are excluded before state is stored or shown.
                </p>
                {compatibilityBindings.length === 0 ? (
                  <p className={styles['settings-muted-note']}>{t('settings.plugins.marketNoCompatBindings')}</p>
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
                          <span>{t('settings.plugins.marketLastValidDigest')}</span>
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
                            <span>{t('settings.plugins.marketSanitizedExclusions')}</span>
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
