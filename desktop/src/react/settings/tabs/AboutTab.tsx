import React, { useEffect, useState, useCallback } from 'react';
import { useSettingsStore } from '../store';
import { autoSaveConfig, t } from '../helpers';
import { Toggle } from '../widgets/Toggle';
import { loadSettingsConfig } from '../actions';
import { readConfigBoolean } from '../resource-state';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { ExpandableRow } from '../components/ExpandableRow';
import { AutoUpdateStatus } from '../../components/AutoUpdateStatus';
import { useAutoUpdateState } from '../../hooks/use-auto-update-state';
import type { BuildInfo } from '../../types';
import appIconUrl from '../../../icon.png';
import styles from '../Settings.module.css';

export function AboutTab() {
  const hana = window.hana;
  const settingsConfig = useSettingsStore(s => s.settingsConfig);
  const [version, setVersion] = useState('');
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const autoUpdate = useAutoUpdateState();
  const isBeta = readConfigBoolean(settingsConfig, cfg => cfg.update_channel === 'beta', false);
  // 默认 true：老用户（preferences 里没写这个字段）保持原有"自动检查"行为
  const autoCheck = readConfigBoolean(settingsConfig, cfg => cfg.auto_check_updates, true);
  const displayVersion = buildInfo?.appVersion || version;
  const updatesEnabled = buildInfo?.updateEnabled !== false && autoUpdate?.status !== 'disabled';
  const sourceRepo = buildInfo?.sourceRepo || 'liliMozi/openhanako';
  const sourceRepoUrl = /^[-_.A-Za-z0-9]+\/[-_.A-Za-z0-9]+$/.test(sourceRepo)
    ? `https://github.com/${sourceRepo}`
    : 'https://github.com/liliMozi/openhanako';
  const isLocalBuild = buildInfo?.channel === 'local' || buildInfo?.updateEnabled === false;

  useEffect(() => {
    hana?.getAppVersion?.().then((v: string) => setVersion(v || ''));
  }, [hana]);

  useEffect(() => {
    let alive = true;
    hana?.getBuildInfo?.()
      .then((info) => {
        if (alive && info) setBuildInfo(info);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [hana]);

  const handleCheck = useCallback(() => {
    if (!updatesEnabled) return;
    hana?.autoUpdateCheck?.();
  }, [hana, updatesEnabled]);

  const handleInstall = useCallback(async () => {
    if (!updatesEnabled) return;
    await hana?.autoUpdateInstall?.();
  }, [hana, updatesEnabled]);

  const handleBetaToggle = useCallback(async (on: boolean) => {
    if (!updatesEnabled) return;
    const channel = on ? 'beta' : 'stable';
    hana?.autoUpdateSetChannel?.(channel);
    await autoSaveConfig({ update_channel: channel }, { silent: true });
    await loadSettingsConfig();
    hana?.autoUpdateCheck?.();
  }, [hana, updatesEnabled]);

  const handleAutoCheckToggle = useCallback(async (on: boolean) => {
    if (!updatesEnabled) return;
    await autoSaveConfig({ auto_check_updates: on }, { silent: true });
    await loadSettingsConfig();
  }, [updatesEnabled]);

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="about">
      {/* Hero：保留原 about-hero 独立视觉组件（icon + name + tagline + version + update + check 按钮） */}
      <div className={styles['about-hero']}>
        <img className={styles['about-icon']} src={appIconUrl} alt="HanaAgent" />
        <div className={styles['about-name']}>HanaAgent</div>
        <div className={styles['about-tagline']}>{t('settings.about.tagline')}</div>
        {displayVersion && <div className={styles['about-version']}>v{displayVersion}</div>}
        {isLocalBuild && (
          <div className={styles['about-build-info']}>
            <span className={styles['about-build-badge']}>{t('settings.about.localBuild')}</span>
            <span>{sourceRepo}</span>
            {buildInfo?.gitSha && <span>{buildInfo.gitSha.slice(0, 7)}</span>}
            {buildInfo?.baseTag && <span>{`base: ${buildInfo.baseTag}`}</span>}
            {buildInfo?.dirty === true && <span>{t('settings.about.localBuildDirty')}</span>}
            {buildInfo?.signatureKind && <span>{buildInfo.signatureKind}</span>}
          </div>
        )}
        <AutoUpdateStatus
          state={autoUpdate}
          agentName={settingsConfig?.agent?.name || 'Hanako'}
          onInstall={handleInstall}
        />
        {updatesEnabled && (!autoUpdate || autoUpdate.status === 'idle' || autoUpdate.status === 'latest' || autoUpdate.status === 'error') && (
          <button className={styles['about-check-update-btn']} onClick={handleCheck}>
            {t('settings.about.updateCheckBtn')}
          </button>
        )}
      </div>

      {/* Info：4 个标准 row（license / copyright / github / beta toggle） */}
      <SettingsSection>
        <SettingsRow
          label={t('settings.about.license')}
          control={<span>Apache License 2.0</span>}
        />
        <SettingsRow
          label={t('settings.about.copyright')}
          control={<span>© 2026 liliMozi</span>}
        />
        <SettingsRow
          label="GitHub"
          control={
            <a
              className={styles['about-link']}
              href="#"
              onClick={(e) => {
                e.preventDefault();
                hana?.openExternal?.(sourceRepoUrl);
              }}
            >
              github.com/{sourceRepo}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          }
        />
        {updatesEnabled && (
          <>
            <SettingsRow
              label={t('settings.about.autoCheckUpdates')}
              control={<Toggle on={autoCheck} onChange={handleAutoCheckToggle} />}
            />
            <SettingsRow
              label={t('settings.about.betaUpdates')}
              control={<Toggle on={isBeta} onChange={handleBetaToggle} />}
            />
          </>
        )}
      </SettingsSection>

      {/* License 全文：ExpandableRow 直接作为 tab 末尾元素 */}
      <ExpandableRow label={t('settings.about.licenseToggle')}>
        <pre className={styles['about-license-text']}>{LICENSE_TEXT}</pre>
      </ExpandableRow>
    </div>
  );
}

const LICENSE_TEXT = `Apache License, Version 2.0

Copyright 2026 liliMozi

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`;
