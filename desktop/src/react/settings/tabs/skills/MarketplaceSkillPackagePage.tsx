import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '../../store';
import type { SkillInfo } from '../../store';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import { AgentSelect } from '../bridge/AgentSelect';
import { SettingsSection } from '../../components/SettingsSection';
import styles from '../../Settings.module.css';
import {
  isMarketplaceSkillPreferenceWritable,
  marketplaceSkillPackageStatus,
  summarizeMarketplaceSkillPackage,
  type ManagePluginsSkillPackageRow,
} from './marketplace-package';
import { effectiveSkillEnabled } from './skill-state';

interface MarketplaceSkillPackagePageProps {
  pkg: ManagePluginsSkillPackageRow;
  defaultAgentId: string | null;
  isStudioOwner: boolean;
  onBack: () => void;
  onOpenMarketplace: () => void;
  onTogglePackage: (pkg: ManagePluginsSkillPackageRow, enable: boolean) => Promise<void> | void;
}

function packageSourceBlocked(pkg: ManagePluginsSkillPackageRow): boolean {
  return pkg.sourceStatus !== 'ok' || pkg.packageGateState === 'blocked-by-source';
}

function packageControlsLocked(pkg: ManagePluginsSkillPackageRow): boolean {
  return packageSourceBlocked(pkg) || !pkg.packageEnabled;
}

function packageLockHint(pkg: ManagePluginsSkillPackageRow): string | null {
  if (packageSourceBlocked(pkg)) return t('settings.plugins.skillPackagePageSourceBlocked');
  if (!pkg.packageEnabled) return t('settings.plugins.skillPackagePageDisabledHint');
  return null;
}

function effectivePackageSkillEnabled(skill: SkillInfo, pkg: ManagePluginsSkillPackageRow): boolean {
  return !packageControlsLocked(pkg) && effectiveSkillEnabled(skill);
}

function packageAvailabilityMessage(pkg: ManagePluginsSkillPackageRow): string {
  const lockHint = packageLockHint(pkg);
  if (lockHint) return lockHint;
  if (pkg.packageState === 'partial') return t('settings.plugins.skillPackagePagePartialHint');
  if (pkg.packageState === 'stale-record') return t('settings.plugins.skillPackagePageStaleHint');
  return t('settings.plugins.skillPackagePageAvailabilityHint');
}

function skillInactiveHint(skill: SkillInfo, pkg: ManagePluginsSkillPackageRow): string | null {
  const lockHint = packageLockHint(pkg);
  if (lockHint) return lockHint;
  if (skill.active !== false) return null;
  switch (skill.inactiveReason) {
    case 'agent-skill-disabled':
      return t('settings.skills.marketplaceInactiveAgent');
    case 'marketplace-source-blocked':
      return t('settings.plugins.skillPackagePageSourceBlocked');
    case 'marketplace-package-disabled':
      return t('settings.plugins.skillPackagePageDisabledHint');
    default:
      return skill.inactiveReason || null;
  }
}

function packageStatusLabel(pkg: ManagePluginsSkillPackageRow): string {
  if (packageSourceBlocked(pkg)) return t('settings.plugins.skillPackagePageSourceBlockedLabel');
  switch (marketplaceSkillPackageStatus(pkg)) {
    case 'disabled':
      return t('settings.plugins.skillPackageStatusDisabled');
    case 'partial':
      return t('settings.plugins.skillPackageStatusPartial');
    case 'stale':
      return t('settings.plugins.skillPackageStatusStale');
    default:
      return t('settings.plugins.skillPackageStatusEnabled');
  }
}

interface MarketplaceSkillRowProps {
  skill: SkillInfo;
  pkg: ManagePluginsSkillPackageRow;
  pending: boolean;
  onToggle: (skill: SkillInfo, enabled: boolean) => void;
}

function MarketplaceSkillRow({ skill, pkg, pending, onToggle }: MarketplaceSkillRowProps) {
  const enabled = effectivePackageSkillEnabled(skill, pkg);
  const writable = isMarketplaceSkillPreferenceWritable(skill);
  const disabled = pending || !writable || packageControlsLocked(pkg);
  const inactiveHint = skillInactiveHint(skill, pkg);
  const toggleLabel = enabled
    ? t('settings.skills.toggleDisableNamed', { name: skill.name })
    : t('settings.skills.toggleEnableNamed', { name: skill.name });

  return (
    <div className={styles['skill-package-page-row']} data-skill-name={skill.name}>
      <div className={styles['skills-list-info']}>
        <div className={styles['skill-package-page-skill-title']}>
          <span className={styles['skills-list-name']}>{skill.name}</span>
          <span className={styles['skills-source-badge']} translate="no">
            {t('settings.plugins.skillPackageKind')}
          </span>
          {!writable && (
            <span className={styles['skill-package-page-readonly']}>
              {t('settings.plugins.skillPackagePageReadOnly')}
            </span>
          )}
        </div>
        {inactiveHint && (
          <span className={styles['skill-package-page-inactive']}>
            {inactiveHint}
          </span>
        )}
        <span className={styles['skills-list-desc']}>{skill.description || ''}</span>
      </div>
      <div className={styles['skills-list-actions']}>
        <button
          type="button"
          className={`hana-toggle${enabled ? ' on' : ''}${disabled ? ' disabled' : ''}`}
          disabled={disabled}
          aria-label={toggleLabel}
          title={disabled && !writable ? t('settings.plugins.skillPackagePageReadOnly') : toggleLabel}
          onClick={() => onToggle(skill, !enabled)}
        />
      </div>
    </div>
  );
}

export function MarketplaceSkillPackagePage({
  pkg,
  defaultAgentId,
  isStudioOwner,
  onBack,
  onOpenMarketplace,
  onTogglePackage,
}: MarketplaceSkillPackagePageProps) {
  const showToast = useSettingsStore((state) => state.showToast);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(defaultAgentId);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [pendingSkillNames, setPendingSkillNames] = useState<Set<string>>(new Set());
  const [batchAction, setBatchAction] = useState<boolean | null>(null);
  const [packageTogglePending, setPackageTogglePending] = useState(false);
  const selectedAgentIdRef = useRef(selectedAgentId);
  const requestIdRef = useRef(0);
  const skillsAbortControllerRef = useRef<AbortController | null>(null);
  selectedAgentIdRef.current = selectedAgentId;

  useEffect(() => {
    if (!selectedAgentId && defaultAgentId) setSelectedAgentId(defaultAgentId);
  }, [defaultAgentId, selectedAgentId]);

  const loadSkills = useCallback(async (agentId: string | null) => {
    const requestId = ++requestIdRef.current;
    skillsAbortControllerRef.current?.abort();
    skillsAbortControllerRef.current = null;
    if (!agentId) {
      setSkills([]);
      setSkillsLoading(false);
      return;
    }
    const abortController = new AbortController();
    skillsAbortControllerRef.current = abortController;
    setSkillsLoading(true);
    try {
      const res = await hanaFetch(
        `/api/skills?agentId=${encodeURIComponent(agentId)}&runtime=1`,
        { signal: abortController.signal },
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (requestId === requestIdRef.current && selectedAgentIdRef.current === agentId) {
        setSkills(Array.isArray(data.skills) ? data.skills : []);
      }
    } catch (err: unknown) {
      if (abortController.signal.aborted) return;
      if (requestId === requestIdRef.current && selectedAgentIdRef.current === agentId) {
        setSkills([]);
        showToast(
          t('settings.plugins.skillPackagePageLoadError') + ': ' +
            (err instanceof Error ? err.message : String(err)),
          'error',
        );
      }
    } finally {
      if (skillsAbortControllerRef.current === abortController) {
        skillsAbortControllerRef.current = null;
      }
      if (requestId === requestIdRef.current && selectedAgentIdRef.current === agentId) {
        setSkillsLoading(false);
      }
    }
  }, [showToast]);

  useEffect(() => {
    void loadSkills(selectedAgentId);
    return () => skillsAbortControllerRef.current?.abort();
  }, [loadSkills, selectedAgentId, pkg.packageEnabled, pkg.packageGateState, pkg.sourceStatus]);

  const membership = useMemo(
    () => summarizeMarketplaceSkillPackage(pkg.identity, pkg.skillNames, skills),
    [pkg.identity, pkg.skillNames, skills],
  );
  const controlsLocked = packageControlsLocked(pkg);
  const displayEnabledCount = controlsLocked ? 0 : membership.enabledCount;
  const displayDisabledCount = membership.skills.length - displayEnabledCount;
  const writableSkills = controlsLocked ? [] : membership.configurableSkills;
  const batchActionsDisabled = !selectedAgentId
    || skillsLoading
    || controlsLocked
    || writableSkills.length === 0
    || batchAction !== null;
  const canTogglePackage = isStudioOwner
    && pkg.actions?.canToggle !== false
    && !packageSourceBlocked(pkg)
    && !packageTogglePending;

  const updatePendingSkillNames = (names: Iterable<string>) => {
    setPendingSkillNames(new Set(names));
  };

  const patchSkill = useCallback(async (agentId: string, skillName: string, enabled: boolean) => {
    const res = await hanaFetch(
      `/api/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillName)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || 'Skill preference update failed');
  }, []);

  const toggleSkill = async (skill: SkillInfo, enabled: boolean) => {
    const agentId = selectedAgentIdRef.current;
    if (!agentId || controlsLocked || !isMarketplaceSkillPreferenceWritable(skill)) return;
    const snapshotAgentId = agentId;
    updatePendingSkillNames([skill.name]);
    setSkills((prev) => prev.map((item) => item.name === skill.name
      ? { ...item, enabled }
      : item));
    try {
      await patchSkill(snapshotAgentId, skill.name, enabled);
      if (selectedAgentIdRef.current === snapshotAgentId) {
        showToast(t('settings.autoSaved'), 'success');
        await loadSkills(snapshotAgentId);
      }
    } catch (err: unknown) {
      if (selectedAgentIdRef.current === snapshotAgentId) {
        await loadSkills(snapshotAgentId);
        showToast(
          t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)),
          'error',
        );
      }
    } finally {
      setPendingSkillNames(new Set());
    }
  };

  const updateAllSkills = async (enabled: boolean) => {
    const agentId = selectedAgentIdRef.current;
    if (!agentId || controlsLocked || batchAction !== null) return;
    const targets = writableSkills.filter((skill) =>
      effectivePackageSkillEnabled(skill, pkg) !== enabled,
    );
    if (targets.length === 0) {
      showToast(t('settings.plugins.skillPackagePageBatchNoop'), 'success');
      return;
    }

    const snapshotAgentId = agentId;
    setBatchAction(enabled);
    updatePendingSkillNames(targets.map((skill) => skill.name));
    const targetNames = new Set(targets.map((skill) => skill.name));
    setSkills((prev) => prev.map((skill) => targetNames.has(skill.name)
      ? { ...skill, enabled }
      : skill));
    const results = await Promise.allSettled(
      targets.map((skill) => patchSkill(snapshotAgentId, skill.name, enabled)),
    );
    const succeeded = results.filter((result) => result.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    if (selectedAgentIdRef.current === snapshotAgentId) {
      await loadSkills(snapshotAgentId);
      if (failed > 0) {
        showToast(
          t('settings.plugins.skillPackagePageBatchPartial', {
            action: enabled
              ? t('settings.plugins.skillPackagePageEnableAll')
              : t('settings.plugins.skillPackagePageDisableAll'),
            succeeded: String(succeeded),
            failed: String(failed),
          }),
          'error',
        );
      } else {
        showToast(
          t('settings.plugins.skillPackagePageBatchSuccess', {
            action: enabled
              ? t('settings.plugins.skillPackagePageEnableAll')
              : t('settings.plugins.skillPackagePageDisableAll'),
            count: String(succeeded),
          }),
          'success',
        );
      }
    }
    setPendingSkillNames(new Set());
    setBatchAction(null);
  };

  const togglePackage = async () => {
    if (!canTogglePackage) return;
    setPackageTogglePending(true);
    try {
      await onTogglePackage(pkg, !pkg.packageEnabled);
    } finally {
      setPackageTogglePending(false);
    }
  };

  return (
    <div
      className={`${styles['settings-tab-content']} ${styles['active']} ${styles['skill-package-page']}`}
      data-tab="plugins"
      data-package-identity={pkg.identity}
    >
      <nav className={styles['skill-package-page-breadcrumb']} aria-label={t('settings.plugins.skillPackagePageBreadcrumb')}>
        <button type="button" className={styles['skill-package-page-back']} onClick={onBack}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span>{t('settings.plugins.manageTitle')}</span>
        </button>
        <span aria-hidden="true" className={styles['skill-package-page-breadcrumb-separator']}>›</span>
        <span className={styles['skill-package-page-breadcrumb-current']}>{pkg.name}</span>
      </nav>

      <header className={styles['skill-package-page-header']}>
        <div className={styles['skills-list-info']}>
          <div className={styles['skill-package-page-title-row']}>
            <h2 className={styles['skill-package-page-title']}>{pkg.name}</h2>
            {pkg.version && <span className={styles['skills-list-name-hint']}>v{pkg.version}</span>}
            <span className={styles['skills-source-badge']}>{t('settings.plugins.skillPackageKind')}</span>
          </div>
          <span className={styles['skill-package-page-identity']} translate="no">{pkg.identity}</span>
          {pkg.description && <p className={styles['skill-package-page-description']}>{pkg.description}</p>}
        </div>
        <button type="button" className={styles['settings-save-btn-sm']} onClick={onOpenMarketplace}>
          {t('settings.plugins.skillPackagePageOpenMarketplace')}
        </button>
      </header>

      <SettingsSection title={t('settings.plugins.skillPackagePageAvailability')} surface="plain">
        <div className={`${styles['skill-package-page-availability']} ${controlsLocked ? styles['skill-package-page-availability-locked'] : ''}`}>
          <div className={styles['skill-package-page-availability-copy']}>
            <div className={styles['skill-package-page-availability-title']}>
              <span>{controlsLocked ? t('settings.plugins.skillPackagePageGlobalDisabled') : t('settings.plugins.skillPackagePageGlobalEnabled')}</span>
              <span className={styles['skill-package-page-status-badge']}>
                {packageStatusLabel(pkg)}
              </span>
            </div>
            <p>{packageAvailabilityMessage(pkg)}</p>
          </div>
          {isStudioOwner && (
            <button
              type="button"
              className={`hana-toggle${pkg.packageEnabled && !packageSourceBlocked(pkg) ? ' on' : ''}`}
              disabled={!canTogglePackage}
              aria-label={t('settings.plugins.skillPackageToggle', { identity: pkg.identity, name: pkg.name })}
              onClick={() => void togglePackage()}
            />
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.plugins.skillPackagePageSkills')}
        context={<AgentSelect value={selectedAgentId} onChange={setSelectedAgentId} />}
        surface="plain"
      >
        <div className={styles['skill-package-page-summary']}>
          <span>{t('settings.plugins.skillPackagePageSummary', {
            installed: String(membership.skills.length),
            enabled: String(displayEnabledCount),
            disabled: String(displayDisabledCount),
          })}</span>
          {controlsLocked && <span>{t('settings.plugins.skillPackagePagePreferencesPreserved')}</span>}
        </div>

        <div className={styles['skill-package-page-toolbar']}>
          <p className={styles['skill-package-page-toolbar-hint']}>
            {t('settings.plugins.skillPackagePageAgentHint')}
          </p>
          <div className={styles['skill-package-page-batch-actions']}>
            <button
              type="button"
              className={styles['settings-save-btn-sm']}
              disabled={batchActionsDisabled}
              onClick={() => void updateAllSkills(true)}
            >
              {t('settings.plugins.skillPackagePageEnableAll')}
            </button>
            <button
              type="button"
              className={styles['settings-save-btn-sm']}
              disabled={batchActionsDisabled}
              onClick={() => void updateAllSkills(false)}
            >
              {t('settings.plugins.skillPackagePageDisableAll')}
            </button>
          </div>
        </div>

        {!selectedAgentId ? (
          <p className={`${styles['agent-skill-empty']} ${styles['settings-empty-inset']}`}>
            {t('settings.plugins.skillPackagePageNoAgent')}
          </p>
        ) : skillsLoading ? (
          <p className={`${styles['agent-skill-empty']} ${styles['settings-empty-inset']}`}>
            {t('settings.plugins.skillPackagePageLoading')}
          </p>
        ) : membership.skills.length === 0 ? (
          <p className={`${styles['agent-skill-empty']} ${styles['settings-empty-inset']}`}>
            {t('settings.plugins.skillPackagePageNoSkills')}
          </p>
        ) : (
          <div className={styles['skill-package-page-list']}>
            {membership.skills.map((skill) => (
              <MarketplaceSkillRow
                key={skill.name}
                skill={skill}
                pkg={pkg}
                pending={pendingSkillNames.has(skill.name)}
                onToggle={(item, enabled) => { void toggleSkill(item, enabled); }}
              />
            ))}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
