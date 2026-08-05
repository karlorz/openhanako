/**
 * Marketplace plugin inspector panel: the selected-plugin detail composition
 * (header actions, property rows, contribution badges). The readme body and
 * the catalog list stay in the tab.
 */
import React from 'react';
import { useSettingsStore } from '../../store';
import { t } from '../../helpers';
import type { MarketplacePayload, MarketplacePlugin } from '../../marketplace-types';
import {
  isInstalledSkillsPackage,
  isSkillsTarget,
  marketAdapterLabel,
  marketConfirmationLabel,
  marketInstallLabel,
  marketTargetLabel,
  marketVersion,
  packageGateEnabled,
  rowKey,
  sourceQualifiedId,
  warningMessages,
} from '../../hooks/useMarketplaceData';
import { type MarketplaceActions } from '../../hooks/useMarketplaceActions';
import styles from '../../Settings.module.css';

const marketplaceBadgeClassName = `${styles['skills-source-badge']} ${styles['plugin-marketplace-badge']}`;

function marketVersionStatus(plugin: MarketplacePlugin): string | null {
  if (isSkillsTarget(plugin.installTarget)) {
    if (plugin.packageInstall?.state === 'installed') {
      const count = plugin.packageInstall.present.length;
      return t('settings.plugins.marketVersionStatusInstalled', {
        count: String(count),
        unit: count === 1
          ? t('settings.plugins.marketSkillDirectory')
          : t('settings.plugins.marketSkillDirectories'),
      });
    }
    if (plugin.packageInstall?.state === 'partial') {
      return t('settings.plugins.marketVersionStatusPartial', {
        present: String(plugin.packageInstall.present.length),
        missing: String(plugin.packageInstall.missing.length),
      });
    }
    if (plugin.packageInstall?.state === 'stale-record') {
      const count = plugin.packageInstall.missing.length;
      return t('settings.plugins.marketVersionStatusStale', {
        count: String(count),
        unit: count === 1
          ? t('settings.plugins.marketSkillDirectory')
          : t('settings.plugins.marketSkillDirectories'),
      });
    }
  }
  if (plugin.installTarget === 'unsupported' || (plugin.installable === false && !plugin.nativeSettingsLifecycle?.supported)) return t('settings.plugins.marketVersionStatusUnsupported');
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

function inventoryGroups(plugin: MarketplacePlugin): Array<{ key: string; label: string; values: string[] }> {
  const inv = plugin.capabilityInventory || {};
  return [
    { key: 'skills', label: t('settings.plugins.marketInventorySkills'), values: inv.skills || [] },
    { key: 'agentFacing', label: t('settings.plugins.marketInventoryAgentFacing'), values: inv.agentFacing || [] },
    { key: 'serverImpact', label: t('settings.plugins.marketInventoryServerImpact'), values: inv.serverImpact || [] },
    { key: 'nativePluginContributions', label: t('settings.plugins.marketInventoryNativeContributions'), values: inv.nativePluginContributions || [] },
    { key: 'unsupportedClaudeComponents', label: t('settings.plugins.marketInventoryUnsupportedClaudeComponents'), values: inv.unsupportedClaudeComponents || [] },
  ].filter(group => group.values.length > 0);
}

export interface MarketplacePluginInspectorProps {
  plugin: MarketplacePlugin;
  marketplace: MarketplacePayload | null;
  actions: MarketplaceActions;
  selectedAgentId?: string | null;
}

export function MarketplacePluginInspector({
  plugin,
  marketplace,
  actions,
  selectedAgentId,
}: MarketplacePluginInspectorProps): React.JSX.Element {
  const set = useSettingsStore(s => s.set);
  const selectedWarnings = warningMessages(plugin);
  const selectedInventoryGroups = inventoryGroups(plugin);
  const pluginBusy = actions.busyKey === rowKey(plugin);
  // While any action owns the single busy slot, no visible mutation control may
  // stay enabled: the handler guards would otherwise swallow clicks silently.
  const anyBusy = actions.busyKey !== null;

  return (
    <>
      <div className={styles['plugin-marketplace-detail-header']}>
        <div style={{ minWidth: 0 }}>
          <div className={styles['skills-list-name']}>{plugin.name}</div>
          <div className={styles['skills-list-desc']}>
            {(plugin.publisher || 'unknown') + ' · v' + marketVersion(plugin)}
            {plugin.marketplaceId ? ` · ${sourceQualifiedId(plugin)}` : ''}
          </div>
          {marketVersionStatus(plugin) && (
            <div className={styles['skills-list-desc']}>
              {marketVersionStatus(plugin)}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={styles['settings-save-btn-sm']}
            disabled={
              anyBusy
              || marketplace?.access?.isStudioOwner === false
              || (
                plugin.installTarget === 'native-plugin'
                  ? !plugin.nativeSettingsLifecycle?.canInstall && !plugin.nativeSettingsLifecycle?.canUninstall
                  : plugin.packageInstall?.state === 'not-installed'
                  ? !plugin.canInstall
                  : false
              )
            }
            onClick={(e) => {
              e.stopPropagation();
              if (plugin.installTarget === 'native-plugin' && plugin.nativeSettingsLifecycle?.canUninstall) {
                void actions.uninstallNativePlugin(plugin);
              } else if (plugin.packageInstall && plugin.packageInstall.state !== 'not-installed') {
                void actions.uninstallSkillsPackage(plugin);
              } else {
                void actions.installPlugin(plugin);
              }
            }}
          >
            {marketInstallLabel(plugin)}
          </button>
          {isSkillsTarget(plugin.installTarget) && (
            <button
              type="button"
              className={styles['settings-save-btn-sm']}
              onClick={() => set({ activeTab: 'skills' })}
            >
              {t('settings.plugins.skillPackageManageInSkills')}
            </button>
          )}
          {isInstalledSkillsPackage(plugin)
            && marketplace?.access?.isStudioOwner === true && (
            <button
              type="button"
              className={`hana-toggle${packageGateEnabled(
                plugin,
                marketplace?.configDiagnostics?.file?.activations,
              ) ? ' on' : ''}${pluginBusy ? ' loading' : ''}`}
              disabled={anyBusy}
              aria-label={t('settings.plugins.skillPackageToggle', {
                identity: sourceQualifiedId(plugin),
                name: plugin.name,
              }) || t('settings.plugins.skillPackageToggleFallback', { identity: sourceQualifiedId(plugin) })}
              title={t('settings.plugins.marketPackageGateTitle')}
              onClick={(e) => {
                e.stopPropagation();
                const next = !packageGateEnabled(
                  plugin,
                  marketplace?.configDiagnostics?.file?.activations,
                );
                void actions.toggleSkillPackageGate(plugin, next);
              }}
            />
          )}
          {plugin.installTarget === 'native-plugin' && selectedAgentId && plugin.active && (
            <button
              type="button"
              className={styles['settings-save-btn-sm']}
              disabled={anyBusy || marketplace?.access?.isStudioOwner === false || plugin.nativeAgentPluginAccess?.state === 'desired-not-installed'}
              onClick={() => { void actions.toggleNativeAgentAccess(plugin); }}
            >
              {t(plugin.nativeAgentPluginAccess?.enabled ? 'settings.plugins.disableAgentAccess' : 'settings.plugins.enableAgentAccess')}
            </button>
          )}
          {plugin.marketplaceId && plugin.retained && !plugin.active && (
            <button
              className={styles['settings-save-btn-sm']}
              disabled={anyBusy}
              onClick={(e) => {
                e.stopPropagation();
                void actions.switchSource(plugin);
              }}
            >
              {t('settings.plugins.marketSwitchSource')}
            </button>
          )}
        </div>
      </div>
      <div className={styles['plugin-marketplace-inspector']}>
        <div className={styles['plugin-marketplace-property-row']}>
          <span>{t('settings.plugins.marketIdentity')}</span>
          <code translate="no">{sourceQualifiedId(plugin)}</code>
        </div>
        <div className={styles['plugin-marketplace-property-row']}>
          <span>{t('settings.plugins.marketInstallTarget')}</span>
          <strong>{marketTargetLabel(plugin.installTarget || plugin.installPlan?.destination)}</strong>
        </div>
        <div className={styles['plugin-marketplace-property-row']}>
          <span>{t('settings.plugins.marketInstallAdapter')}</span>
          <strong>{marketAdapterLabel(plugin.installAdapter || plugin.installPlan?.installAdapter)}</strong>
        </div>
        <div className={styles['plugin-marketplace-property-row']}>
          <span>{t('settings.plugins.marketConfirmation')}</span>
          <strong>{marketConfirmationLabel(plugin.confirmationLevel || plugin.installPlan?.confirmationLevel)}</strong>
        </div>
        <div className={styles['plugin-marketplace-property-row']}>
          <span>{t('settings.plugins.marketInstallable')}</span>
          <strong>{plugin.nativeSettingsLifecycle?.supported || (plugin.installable !== false && plugin.installTarget !== 'unsupported') ? t('settings.plugins.marketYes') : t('settings.plugins.marketNo')}</strong>
        </div>
        {plugin.installTarget === 'native-plugin' && plugin.nativeSettingsLifecycle && (
          <div className={styles['plugin-marketplace-property-row']}>
            <span>{t('settings.plugins.marketInstallation')}</span>
            <strong>{plugin.active ? t('settings.plugins.marketInstalled') : t('settings.plugins.marketNotInstalled')} · {plugin.nativeSettingsLifecycle.reason || t('settings.plugins.marketLifecycleUnavailable')}</strong>
          </div>
        )}
        {(plugin.catalogFormat || plugin.sourceStatus) && (
          <div className={styles['plugin-marketplace-property-row']}>
            <span>{t('settings.plugins.marketSource')}</span>
            <strong>
              {[plugin.catalogFormat, plugin.sourceAuthority, plugin.sourceStatus]
                .filter(Boolean)
                .join(' · ')}
            </strong>
          </div>
        )}
        {plugin.runtimeActivation && (
          <div className={styles['plugin-marketplace-property-row']}>
            <span>{t('settings.plugins.marketServerRuntime')}</span>
            <strong>{plugin.runtimeActivation.state || t('settings.plugins.marketUnknown')}{plugin.runtimeActivation.reason ? ` · ${plugin.runtimeActivation.reason}` : ''}</strong>
          </div>
        )}
        {plugin.installTarget === 'native-plugin' && plugin.nativeAgentPluginAccess && (
          <div className={styles['plugin-marketplace-plan']}>
            <span>{t('settings.plugins.marketAgentPluginAccess')}</span>
            <strong>
              {plugin.nativeAgentPluginAccess.state || t('settings.plugins.marketUnknown')}
              {plugin.nativeAgentPluginAccess.reason ? ` · ${plugin.nativeAgentPluginAccess.reason}` : ''}
            </strong>
          </div>
        )}
        {isSkillsTarget(plugin.installTarget) && (
          <div className={styles['plugin-marketplace-plan']}>
            <span>{t('settings.plugins.marketPackageState')}</span>
            <strong>
              {plugin.packageInstall?.state || t('settings.plugins.marketNotInstalled')}
              {plugin.available === false ? ' · ' + t('settings.plugins.marketSourceRemovedUninstallOnly') : ''}
            </strong>
          </div>
        )}
        {isInstalledSkillsPackage(plugin) && (
          <div className={styles['plugin-marketplace-plan']}>
            <span>{t('settings.plugins.marketPackageGate')}</span>
            <strong>
              {packageGateEnabled(
                plugin,
                marketplace?.configDiagnostics?.file?.activations,
              ) ? t('settings.plugins.marketPackageGateEnabled') : t('settings.plugins.marketPackageGateDisabled')}
              {plugin.packageActivation?.state
                ? ` · ${plugin.packageActivation.state}`
                : ''}
              {plugin.packageActivation?.reason
                ? ` · ${plugin.packageActivation.reason}`
                : ''}
              {' · ' + t('settings.plugins.marketPackageGateScope')}
            </strong>
          </div>
        )}
        {isSkillsTarget(plugin.installTarget) && (
          <div className={styles['plugin-marketplace-plan']}>
            <span>{t('settings.plugins.marketActivationRoute')}</span>
            <strong>{t('settings.plugins.marketActivationRouteValue')}</strong>
          </div>
        )}
        {plugin.installPlan && (
          <div className={styles['plugin-marketplace-plan']}>
            <span>{t('settings.plugins.marketInstallPlan')}</span>
            <strong>
              {[
                plugin.installPlan.action || t('settings.plugins.marketActionInstall'),
                marketTargetLabel(plugin.installPlan.destination || plugin.installTarget),
                marketAdapterLabel(plugin.installPlan.installAdapter || plugin.installAdapter),
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
            <span>{t('settings.plugins.marketWarnings')}</span>
            <ul>
              {selectedWarnings.map(warning => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {(plugin.contributions || []).map(item => (
          <span key={item} className={marketplaceBadgeClassName}>
            {item}
          </span>
        ))}
      </div>
    </>
  );
}
