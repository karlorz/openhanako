/**
 * Manage Plugins skill-package panel: renders the installed marketplace
 * skill-package inventory rows (kind/status badges, identity, description,
 * skill count) and routes the row actions through onOpen / onToggle /
 * onUninstall. The tab keeps the dual-fetch, the list assembly (native
 * plugin rows, empty state, dropzone) and the action handlers.
 */
import React from 'react';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';
import { BrowseIcon, RemoveIcon } from '../PluginActionIcons';
import {
  marketplaceSkillPackageStatus,
  type ManagePluginsSkillPackageRow,
  type MarketplaceSkillPackageStatus,
} from '../../tabs/skills/marketplace-package';

export interface SkillPackageInventoryMeta {
  registry: { revision?: number; digest?: string } | null;
  access: { isStudioOwner?: boolean; isLocalOwner?: boolean } | null;
  activations: Record<string, unknown> | null;
}

const marketplaceBadgeClassName = `${styles['skills-source-badge']} ${styles['plugin-marketplace-badge']}`;

function SkillPackageStatusBadge({ status }: { status: MarketplaceSkillPackageStatus }) {
  const labelKey =
    status === 'enabled' ? 'settings.plugins.skillPackageStatusEnabled' :
    status === 'partial' ? 'settings.plugins.skillPackageStatusPartial' :
    status === 'stale' ? 'settings.plugins.skillPackageStatusStale' :
    'settings.plugins.skillPackageStatusDisabled';

  const style: React.CSSProperties =
    status === 'enabled'
      ? { color: 'var(--success, #5a9)', background: 'rgba(90,170,153,0.1)' }
      : status === 'partial' || status === 'stale'
      ? { color: 'var(--warning, #c90)', background: 'rgba(204,153,0,0.12)' }
      : { color: 'var(--text-muted)', background: 'var(--overlay-light, rgba(0,0,0,0.06))' };

  return (
    <span className={styles['oauth-status-badge']} style={style}>
      {t(labelKey)}
    </span>
  );
}

function effectivePackageLabel(status: MarketplaceSkillPackageStatus): string {
  if (status === 'enabled') return t('settings.plugins.skillPackageLayerAvailable');
  if (status === 'partial') return t('settings.plugins.skillPackageLayerPartial');
  return t('settings.plugins.skillPackageLayerUnavailable');
}

export function ManagePluginsSkillPackagesPanel(props: {
  rows: ManagePluginsSkillPackageRow[];
  meta: SkillPackageInventoryMeta;
  onOpen: (identity: string) => void;
  onToggle: (row: ManagePluginsSkillPackageRow, next: boolean) => void;
  onUninstall: (row: ManagePluginsSkillPackageRow) => void;
  busyIdentity: string | null;
}): React.JSX.Element {
  const { rows, meta, onOpen, onToggle, onUninstall, busyIdentity } = props;
  const isStudioOwner = meta.access?.isStudioOwner === true;

  return (
    <>
      {rows.map(pkg => {
        const status = marketplaceSkillPackageStatus(pkg);
        const canAct = isStudioOwner;
        const canToggle = canAct && pkg.actions?.canToggle !== false;
        const canUninstall = canAct && pkg.actions?.canUninstall !== false;

        return (
          <div
            key={pkg.identity}
            className={styles['skills-list-item']}
            data-kind="marketplace-skill-package"
            data-identity={pkg.identity}
          >
            <div
              className={`${styles['skills-list-info']} ${styles['skill-package-open-area']}`}
              role="button"
              tabIndex={0}
              aria-label={t('settings.plugins.skillPackageOpenArea', { name: pkg.name })}
              onClick={() => onOpen(pkg.identity)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpen(pkg.identity);
                }
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span className={styles['skills-list-name']}>{pkg.name}</span>
                {pkg.version && (
                  <span className={styles['skills-list-name-hint']}>v{pkg.version}</span>
                )}
                <span
                  className={marketplaceBadgeClassName}
                  style={{
                    opacity: 1,
                    background: 'var(--overlay-light, rgba(0,0,0,0.05))',
                    padding: '1px 6px',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  {t('settings.plugins.skillPackageKind')}
                </span>
                <SkillPackageStatusBadge status={status} />
              </div>
              <span className={styles['skills-list-desc']}>{pkg.identity}</span>
              {pkg.description && (
                <span className={styles['skills-list-desc']}>{pkg.description}</span>
              )}
              {pkg.skillCount > 0 && (
                <span className={styles['skills-list-desc']}>
                  {t('settings.plugins.skillPackageSkillsCount', { count: String(pkg.skillCount) })}
                  {pkg.skillNames.length > 0 ? ` · ${pkg.skillNames.slice(0, 3).join(', ')}` : ''}
                </span>
              )}
              <span className={styles['skills-list-desc']}>
                {t('settings.plugins.skillPackageLayerPackage')}: {' '}
                {pkg.packageEnabled
                  ? t('settings.plugins.marketPackageGateEnabled')
                  : t('settings.plugins.marketPackageGateDisabled')}
              </span>
              <span className={styles['skills-list-desc']}>
                {t('settings.plugins.skillPackageLayerAgentPreference')}: {' '}
                {t('settings.plugins.skillPackageLayerPreferencesPreserved')}
              </span>
              <span className={styles['skills-list-desc']}>
                {t('settings.plugins.skillPackageLayerEffectiveAvailability')}: {' '}
                {effectivePackageLabel(status)}
              </span>
            </div>

            <div className={styles['skills-list-actions']} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                className={`${styles['pv-add-form-btn']} ${styles['plugin-labeled-action']}`}
                disabled={pkg.actions?.canOpenSkills === false || pkg.skillCount <= 0}
                aria-label={t('settings.plugins.skillPackageOpenSkills', { name: pkg.name })}
                title={t('settings.plugins.skillPackageOpenSkills', { name: pkg.name })}
                onClick={() => onOpen(pkg.identity)}
              >
                <BrowseIcon />
                <span>{t('settings.plugins.skillPackageManageInSkills')}</span>
              </button>
              {canUninstall && (
                <button
                  type="button"
                  className={`${styles['pv-add-form-btn']} ${styles['plugin-labeled-action']} ${styles['plugin-action-danger']}`}
                  aria-label={t('settings.plugins.skillPackageUninstallConfirm', {
                    identity: pkg.identity,
                    name: pkg.name,
                    skillCount: String(pkg.skillCount),
                  })}
                  title={t('settings.plugins.skillPackageUninstallConfirm', {
                    identity: pkg.identity,
                    name: pkg.name,
                    skillCount: String(pkg.skillCount),
                  })}
                  onClick={() => onUninstall(pkg)}
                >
                  <RemoveIcon />
                  <span>{t('settings.plugins.skillPackageRemove')}</span>
                </button>
              )}
              {canToggle && (
                <button
                  type="button"
                  className={`${styles['pv-add-form-btn']} ${styles['plugin-labeled-action']} ${busyIdentity === pkg.identity ? 'loading' : ''}`}
                  disabled={busyIdentity === pkg.identity}
                  aria-pressed={pkg.packageEnabled}
                  aria-label={t('settings.plugins.skillPackageToggle', { identity: pkg.identity, name: pkg.name })}
                  onClick={() => onToggle(pkg, !pkg.packageEnabled)}
                >
                  {pkg.packageEnabled
                    ? t('settings.plugins.skillPackageDisable')
                    : t('settings.plugins.skillPackageEnable')}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
