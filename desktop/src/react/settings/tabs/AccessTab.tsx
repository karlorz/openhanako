import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { hanaFetch, hanaUrl } from '../api';
import { t } from '../helpers';
import { useSettingsStore } from '../store';
import {
  DESKTOP_REMOTE_ACCESS_SCOPES,
  MOBILE_REMOTE_ACCESS_SCOPES,
} from '../../../../../shared/access-scope-profiles.ts';
import {
  LOCAL_CONNECTION_ID,
  connectDeviceServerConnection,
  isLocalOwnerConnection,
  persistServerConnectionSelection,
  upsertServerConnection,
  writePersistedServerConnectionState,
} from '../../services/server-connection';
import { Toggle } from '../widgets/Toggle';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import styles from '../Settings.module.css';

type AccessMode = 'loopback' | 'lan';

interface AccessSummary {
  network: {
    mode: AccessMode;
    listenHost: string;
    configuredPort: number;
    actualPort: number;
    runtimeMode: AccessMode;
    runtimeHost: string;
    restartRequired: boolean;
    lanAddresses: string[];
    localServerUrl: string;
    candidateLanServerUrl: string | null;
    lanServerUrl: string | null;
    localMobileUrl: string;
    candidateLanMobileUrl: string | null;
    lanMobileUrl: string | null;
    localDesktopUrl: string;
    candidateLanDesktopUrl: string | null;
    lanDesktopUrl: string | null;
  };
  account: {
    userId: string;
    username: string;
    displayName: string;
    passwordSet: boolean;
  };
  devices: Array<{
    deviceId: string;
    displayName: string;
    deviceKind?: string;
    status: string;
    trustState?: string;
    lastSeenAt?: string | null;
  }>;
  credentials: Array<{
    credentialId: string;
    deviceId: string;
    status: string;
    scopes: string[];
    secretPrefix?: string;
    createdAt?: string | null;
    lastUsedAt?: string | null;
  }>;
}

interface RemoteServerIdentity {
  connectionKind?: string;
  serverId?: string;
  serverNodeId?: string;
  userId?: string;
  studioId?: string;
  label?: string;
  userLabel?: string;
  studioLabel?: string;
  trustState?: string;
  authState?: string;
  credentialKind?: string;
  capabilities?: string[];
  version?: string;
  executionBoundary?: {
    kind?: string;
    workbench?: {
      kind?: string;
    };
  };
}

const MOBILE_ACCESS_SCOPES = [...MOBILE_REMOTE_ACCESS_SCOPES];
const DESKTOP_ACCESS_SCOPES = [...DESKTOP_REMOTE_ACCESS_SCOPES];

export function AccessTab() {
  const showToast = useSettingsStore(s => s.showToast);
  const activeConnection = useSettingsStore(s => s.activeServerConnection);
  const serverConnections = useSettingsStore(s => s.serverConnections);
  const snapshotAccess = useSettingsStore(s => s.settingsSnapshot.data?.access as AccessSummary | null | undefined);
  const localConnection = serverConnections[LOCAL_CONNECTION_ID] ?? null;
  const effectiveConnection = activeConnection ?? localConnection;
  const isLocalOwner = isLocalOwnerConnection(effectiveConnection);
  const [summary, setSummary] = useState<AccessSummary | null>(() => snapshotAccess || null);
  const [mode, setMode] = useState<AccessMode | null>(() => snapshotAccess?.network?.mode || null);
  const [port, setPort] = useState(() => (
    Number.isInteger(snapshotAccess?.network?.configuredPort)
      ? String(snapshotAccess!.network.configuredPort)
      : ''
  ));
  const [mobileKey, setMobileKey] = useState('');
  const [desktopKey, setDesktopKey] = useState('');
  const [generatingMobileKey, setGeneratingMobileKey] = useState(false);
  const [generatingDesktopKey, setGeneratingDesktopKey] = useState(false);
  const [remoteServerUrl, setRemoteServerUrl] = useState('');
  const [remoteServerKey, setRemoteServerKey] = useState('');
  const [connectingRemoteServer, setConnectingRemoteServer] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [savingNetwork, setSavingNetwork] = useState(false);
  const [accountDraft, setAccountDraft] = useState({ username: '', displayName: '' });
  const [passwordDraft, setPasswordDraft] = useState('');
  const [remoteIdentity, setRemoteIdentity] = useState<RemoteServerIdentity | null>(null);

  useEffect(() => {
    if (!snapshotAccess) return;
    setSummary(snapshotAccess);
    setMode(snapshotAccess.network.mode);
    setPort(String(snapshotAccess.network.configuredPort));
    setAccountDraft({
      username: snapshotAccess.account.username || '',
      displayName: snapshotAccess.account.displayName || '',
    });
  }, [snapshotAccess]);

  const loadSummary = useCallback(async () => {
    if (!isLocalOwner) {
      setSummary(null);
      setLoadingSummary(false);
      return;
    }
    setLoadingSummary(true);
    try {
      const res = await hanaFetch('/api/access/summary');
      const data = await res.json();
      setSummary(data);
      setMode(data.network.mode);
      setPort(String(data.network.configuredPort));
      setAccountDraft({
        username: data.account.username || '',
        displayName: data.account.displayName || '',
      });
    } finally {
      setLoadingSummary(false);
    }
  }, [isLocalOwner]);

  useEffect(() => {
    loadSummary().catch((err) => {
      showToast(`${t('settings.access.loadFailed')}: ${err.message}`, 'error');
    });
  }, [loadSummary, showToast]);

  useEffect(() => {
    let cancelled = false;
    if (isLocalOwner) {
      setRemoteIdentity(null);
      return () => { cancelled = true; };
    }
    setRemoteIdentity(null);
    hanaFetch('/api/server/identity')
      .then(res => res.json())
      .then((data) => {
        if (!cancelled && data && typeof data === 'object' && !data.error) {
          setRemoteIdentity(data as RemoteServerIdentity);
        }
      })
      .catch((err) => {
        console.warn('[access] remote identity load failed:', err);
      });
    return () => { cancelled = true; };
  }, [effectiveConnection?.connectionId, isLocalOwner]);

  const mobileUrl = useMemo(() => {
    if (!summary) return '';
    if (mode !== 'lan') return '';
    return summary.network.lanMobileUrl || '';
  }, [mode, summary]);

  const desktopUrl = useMemo(() => {
    if (!summary) return '';
    if (mode !== 'lan') return '';
    return summary.network.lanDesktopUrl || '';
  }, [mode, summary]);

  const qrUrl = useMemo(() => {
    if (mode !== 'lan' || !mobileUrl || summary?.network.restartRequired) return '';
    const query = summary?.network.actualPort
      ? `?port=${encodeURIComponent(String(summary.network.actualPort))}`
      : '';
    return hanaUrl(`/api/access/mobile-qr.svg${query}`);
  }, [mode, mobileUrl, summary?.network.actualPort, summary?.network.restartRequired]);

  const canCopyMobileUrl = mobileUrl.length > 0;
  const canCopyDesktopUrl = desktopUrl.length > 0;
  const canShowQr = mode === 'lan' && mobileUrl.length > 0 && !summary?.network.restartRequired;
  const runtimeEndpoint = summary ? `${summary.network.runtimeHost}:${summary.network.actualPort}` : '';
  const effectiveMobileUrl = summary?.network.lanMobileUrl || summary?.network.localMobileUrl || '';
  const effectiveDesktopUrl = summary?.network.lanDesktopUrl || summary?.network.localDesktopUrl || '';
  const lanAddressText = summary?.network.lanAddresses.length
    ? summary.network.lanAddresses.join(', ')
    : t('settings.access.noLanAddresses');
  const activeDevices = (summary?.devices || []).filter(device => device.status === 'active');
  const activeCredentials = (summary?.credentials || []).filter(credential => credential.status === 'active');
  const activeCredentialDeviceIds = new Set(activeCredentials.map(credential => credential.deviceId));
  const activeDevicesWithoutCredentials = activeDevices.filter(device => !activeCredentialDeviceIds.has(device.deviceId));
  const deviceById = useMemo(() => new Map(activeDevices.map(device => [device.deviceId, device])), [activeDevices]);

  const copyText = useCallback(async (value: string) => {
    if (!value) return;
    await navigator.clipboard?.writeText(value);
    showToast(t('settings.access.copied'), 'success');
  }, [showToast]);

  const saveNetworkSettings = useCallback(async (nextMode: AccessMode, nextPort: string) => {
    const listenPort = Number(nextPort);
    if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
      showToast(t('settings.access.invalidPort'), 'error');
      return;
    }
    setSavingNetwork(true);
    try {
      const res = await hanaFetch('/api/access/network', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: nextMode, listenPort }),
      });
      const data = await res.json();
      setSummary(prev => prev ? { ...prev, network: data.network } : prev);
      setMode(data.network.mode);
      setPort(String(data.network.configuredPort));
      showToast(t('settings.access.saved'), 'success');
    } catch (err: any) {
      showToast(`${t('settings.saveFailed')}: ${err.message}`, 'error');
      setMode(summary?.network.mode || nextMode);
    } finally {
      setSavingNetwork(false);
    }
  }, [showToast, summary?.network.mode]);

  const saveNetwork = useCallback(async () => {
    if (!mode) return;
    await saveNetworkSettings(mode, port);
  }, [mode, port, saveNetworkSettings]);

  const handleLanToggle = useCallback((on: boolean) => {
    if (!summary || loadingSummary || savingNetwork) return;
    const nextMode = on ? 'lan' : 'loopback';
    setMode(nextMode);
    void saveNetworkSettings(nextMode, port);
  }, [loadingSummary, port, saveNetworkSettings, savingNetwork, summary]);

  const generateMobileKey = useCallback(async () => {
    setGeneratingMobileKey(true);
    try {
      const res = await hanaFetch('/api/access/mobile-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Mobile PWA',
          scopes: MOBILE_ACCESS_SCOPES,
        }),
      });
      const data = await res.json();
      setMobileKey(data.secret || '');
      await loadSummary();
      showToast(t('settings.access.mobileKeyCreated'), 'success');
    } catch (err: any) {
      showToast(`${t('settings.access.mobileKeyFailed')}: ${err.message}`, 'error');
    } finally {
      setGeneratingMobileKey(false);
    }
  }, [loadSummary, showToast]);

  const generateDesktopKey = useCallback(async () => {
    setGeneratingDesktopKey(true);
    try {
      const res = await hanaFetch('/api/access/desktop-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Desktop Frontend',
          scopes: DESKTOP_ACCESS_SCOPES,
        }),
      });
      const data = await res.json();
      setDesktopKey(data.secret || '');
      await loadSummary();
      showToast(t('settings.access.desktopKeyCreated'), 'success');
    } catch (err: any) {
      showToast(`${t('settings.access.desktopKeyFailed')}: ${err.message}`, 'error');
    } finally {
      setGeneratingDesktopKey(false);
    }
  }, [loadSummary, showToast]);

  const connectRemoteServer = useCallback(async () => {
    setConnectingRemoteServer(true);
    try {
      const connection = await connectDeviceServerConnection({
        baseUrl: remoteServerUrl,
        credential: remoteServerKey,
      });
      persistServerConnectionSelection(connection);
      const current = useSettingsStore.getState();
      current.set({
        serverConnections: upsertServerConnection(current.serverConnections, connection),
        activeServerConnectionId: connection.connectionId,
        activeServerConnection: connection,
      });
      setRemoteServerKey('');
      showToast(t('settings.access.remoteServerConnected'), 'success');
      window.hana?.reloadMainWindow?.();
    } catch (err: any) {
      showToast(`${t('settings.access.remoteServerFailed')}: ${err.message}`, 'error');
    } finally {
      setConnectingRemoteServer(false);
    }
  }, [remoteServerKey, remoteServerUrl, showToast]);

  const returnToLocalServer = useCallback(() => {
    const current = useSettingsStore.getState();
    const local = current.serverConnections[LOCAL_CONNECTION_ID];
    if (!isLocalOwnerConnection(local)) {
      showToast(t('settings.access.localConnectionUnavailable'), 'error');
      return;
    }
    current.set({
      activeServerConnectionId: local.connectionId,
      activeServerConnection: local,
    });
    writePersistedServerConnectionState({
      serverConnections: current.serverConnections,
      activeServerConnectionId: null,
    });
    showToast(t('settings.access.returnedToLocal'), 'success');
    window.hana?.reloadMainWindow?.();
  }, [showToast]);

  const saveAccount = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/access/account/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountDraft),
      });
      const data = await res.json();
      setSummary(prev => prev ? { ...prev, account: data.account } : prev);
      showToast(t('settings.access.accountSaved'), 'success');
    } catch (err: any) {
      showToast(`${t('settings.saveFailed')}: ${err.message}`, 'error');
    }
  }, [accountDraft, showToast]);

  const savePassword = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/access/account/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordDraft }),
      });
      const data = await res.json();
      setSummary(prev => prev ? { ...prev, account: data.account } : prev);
      setPasswordDraft('');
      showToast(t('settings.access.passwordSaved'), 'success');
    } catch (err: any) {
      showToast(`${t('settings.saveFailed')}: ${err.message}`, 'error');
    }
  }, [passwordDraft, showToast]);

  const clearPassword = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/access/account/password', { method: 'DELETE' });
      const data = await res.json();
      setSummary(prev => prev ? { ...prev, account: data.account } : prev);
      setPasswordDraft('');
      showToast(t('settings.access.passwordCleared'), 'success');
    } catch (err: any) {
      showToast(`${t('settings.saveFailed')}: ${err.message}`, 'error');
    }
  }, [showToast]);

  const revokeDevice = useCallback(async (deviceId: string) => {
    try {
      await hanaFetch(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, { method: 'POST' });
      await loadSummary();
      showToast(t('settings.access.deviceRevoked'), 'success');
    } catch (err: any) {
      showToast(`${t('settings.access.deviceRevokeFailed')}: ${err.message}`, 'error');
    }
  }, [loadSummary, showToast]);

  const revokeCredential = useCallback(async (credentialId: string) => {
    try {
      await hanaFetch(`/api/devices/credentials/${encodeURIComponent(credentialId)}/revoke`, { method: 'POST' });
      await loadSummary();
      showToast(t('settings.access.credentialRevoked'), 'success');
    } catch (err: any) {
      showToast(`${t('settings.access.credentialRevokeFailed')}: ${err.message}`, 'error');
    }
  }, [loadSummary, showToast]);

  if (!isLocalOwner) {
    const connectionLabel = effectiveConnection?.label || t('settings.access.remoteConnectionUnknown');
    const connectionUrl = effectiveConnection?.baseUrl || '';
    const remoteUnknown = t('settings.access.remoteConnectionUnknown');
    const remoteVersion = remoteValue(remoteIdentity?.version, effectiveConnection?.serverVersion, remoteUnknown);
    const remoteConnectionKind = remoteConnectionKindLabel(remoteIdentity?.connectionKind || effectiveConnection?.kind, remoteUnknown);
    const remoteTrustState = remoteTrustStateLabel(remoteIdentity?.trustState || effectiveConnection?.trustState, remoteUnknown);
    const remoteAuthState = remoteAuthStateLabel(remoteIdentity?.authState || effectiveConnection?.authState, remoteUnknown);
    const remoteCredentialKind = remoteCredentialKindLabel(remoteIdentity?.credentialKind || effectiveConnection?.credentialKind, remoteUnknown);
    const remoteCapabilities = remoteCapabilitySummary(remoteIdentity?.capabilities || effectiveConnection?.capabilities, remoteUnknown);
    const remoteStudioLabel = remoteValue(remoteIdentity?.studioLabel, effectiveConnection?.studioLabel, remoteIdentity?.studioId, effectiveConnection?.studioId, remoteUnknown);
    const remoteRuntime = remoteRuntimeLabel(remoteIdentity?.executionBoundary || effectiveConnection?.executionBoundary, remoteUnknown);
    return (
      <div className={`${styles['settings-tab-content']} ${styles.active}`} data-tab="access">
        <SettingsSection
          title={t('settings.access.remoteConnection')}
          description={t('settings.access.remoteConnectionDesc')}
        >
          <div className={styles['access-remote-panel']}>
            <div className={styles['access-status-grid']}>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteConnectionName')}</span>
                <strong>{connectionLabel}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteConnectionKind')}</span>
                <strong>{remoteConnectionKind}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteConnectionUrl')}</span>
                <strong>{connectionUrl || t('settings.access.remoteConnectionUnknown')}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteServerVersion')}</span>
                <strong>{remoteVersion}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteTrustState')}</span>
                <strong>{remoteTrustState}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteAuthState')}</span>
                <strong>{remoteAuthState}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteCredentialKind')}</span>
                <strong>{remoteCredentialKind}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteCapabilities')}</span>
                <strong>{remoteCapabilities}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteStudioLabel')}</span>
                <strong>{remoteStudioLabel}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.remoteRuntime')}</span>
                <strong>{remoteRuntime}</strong>
              </div>
            </div>
            <SettingsSection.Note>{t('settings.access.remoteLocalOnlyNote')}</SettingsSection.Note>
          </div>
          <SettingsSection.Footer>
            <button
              className={styles['settings-btn-secondary']}
              type="button"
              onClick={returnToLocalServer}
              disabled={!isLocalOwnerConnection(localConnection)}
            >
              {t('settings.access.returnToLocal')}
            </button>
          </SettingsSection.Footer>
        </SettingsSection>
      </div>
    );
  }

  return (
    <div className={`${styles['settings-tab-content']} ${styles.active}`} data-tab="access">
      <SettingsSection title={t('settings.access.networkAccess')}>
        <SettingsRow
          label={t('settings.access.lanToggle')}
          hint={t('settings.access.lanHint')}
          control={
            <Toggle
              label={t('settings.access.lanToggle')}
              on={summary ? mode === 'lan' : undefined}
              onChange={handleLanToggle}
              disabled={loadingSummary || savingNetwork}
            />
          }
        />
        <SettingsRow
          label={t('settings.access.port')}
          hint={t('settings.access.portHint')}
          control={
            <input
              className={`${styles['settings-input']} ${styles['settings-port-input']}`}
              value={port}
              inputMode="numeric"
              disabled={loadingSummary || !summary}
              onChange={(event) => setPort(event.target.value)}
            />
          }
        />
        <SettingsRow
          label={t('settings.access.status')}
          hint={summary?.network.restartRequired ? t('settings.access.restartRequired') : t('settings.access.statusHint')}
          layout="stacked"
          control={
            <div className={styles['access-status-grid']}>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.runtimeEndpoint')}</span>
                <strong>{runtimeEndpoint}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.effectiveMobileUrl')}</span>
                <strong>{effectiveMobileUrl}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.effectiveDesktopUrl')}</span>
                <strong>{effectiveDesktopUrl}</strong>
              </div>
              <div className={styles['access-status-item']}>
                <span>{t('settings.access.lanAddresses')}</span>
                <strong>{lanAddressText}</strong>
              </div>
            </div>
          }
        />
        {summary?.network.restartRequired && (
          <SettingsSection.Warning>{t('settings.access.restartRequired')}</SettingsSection.Warning>
        )}
        <SettingsSection.Footer>
          <button className={styles['settings-btn-primary']} type="button" onClick={saveNetwork} disabled={loadingSummary || savingNetwork || !summary}>
            {t('settings.access.saveNetwork')}
          </button>
        </SettingsSection.Footer>
      </SettingsSection>

      <SettingsSection title={t('settings.access.mobileAccess')}>
        <SettingsRow
          label={t('settings.access.mobileUrl')}
          hint={mode === 'lan' ? t('settings.access.mobileUrlLanHint') : t('settings.access.mobileUrlLocalHint')}
          layout="stacked"
          control={
            <div className={styles['access-url-row']}>
              <input className={styles['settings-input']} value={mobileUrl} readOnly />
              <button
                className={styles['settings-btn-secondary']}
                type="button"
                onClick={() => copyText(mobileUrl)}
                disabled={!canCopyMobileUrl}
              >
                {t('settings.access.copy')}
              </button>
            </div>
          }
        />
        {canShowQr && (
          <SettingsRow
            label={t('settings.access.qrCode')}
            hint={t('settings.access.qrCodeHint')}
            control={<img className={styles['access-qr']} src={qrUrl} alt={t('settings.access.qrCode')} />}
          />
        )}
        <SettingsRow
          label={t('settings.access.generateMobileKey')}
          hint={t('settings.access.mobileKeyHint')}
          control={
            <button className={styles['settings-btn-primary']} type="button" onClick={generateMobileKey} disabled={generatingMobileKey}>
              {t('settings.access.generateMobileKey')}
            </button>
          }
        />
        {mobileKey && (
          <SettingsRow
            label={t('settings.access.mobileKey')}
            hint={t('settings.access.mobileKeyOnce')}
            layout="stacked"
            control={
              <div className={styles['access-url-row']}>
                <input className={styles['settings-input']} value={mobileKey} readOnly />
                <button className={styles['settings-btn-secondary']} type="button" onClick={() => copyText(mobileKey)}>
                  {t('settings.access.copy')}
                </button>
              </div>
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.access.desktopAccess')}>
        <SettingsRow
          label={t('settings.access.desktopUrl')}
          hint={mode === 'lan' ? t('settings.access.desktopUrlLanHint') : t('settings.access.desktopUrlLocalHint')}
          layout="stacked"
          control={
            <div className={styles['access-url-row']}>
              <input className={styles['settings-input']} value={desktopUrl} readOnly />
              <button
                className={styles['settings-btn-secondary']}
                type="button"
                onClick={() => copyText(desktopUrl)}
                disabled={!canCopyDesktopUrl}
              >
                {t('settings.access.copy')}
              </button>
            </div>
          }
        />
        <SettingsRow
          label={t('settings.access.generateDesktopKey')}
          hint={t('settings.access.desktopKeyHint')}
          control={
            <button className={styles['settings-btn-primary']} type="button" onClick={generateDesktopKey} disabled={generatingDesktopKey}>
              {t('settings.access.generateDesktopKey')}
            </button>
          }
        />
        {desktopKey && (
          <SettingsRow
            label={t('settings.access.desktopKey')}
            hint={t('settings.access.desktopKeyOnce')}
            layout="stacked"
            control={
              <div className={styles['access-url-row']}>
                <input className={styles['settings-input']} value={desktopKey} readOnly />
                <button className={styles['settings-btn-secondary']} type="button" onClick={() => copyText(desktopKey)}>
                  {t('settings.access.copy')}
                </button>
              </div>
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.access.connectLanServer')}>
        <SettingsRow
          label={t('settings.access.remoteServerUrl')}
          hint={t('settings.access.remoteServerUrlHint')}
          layout="stacked"
          control={
            <label className={styles['access-field']}>
              <span>{t('settings.access.remoteServerUrl')}</span>
              <input
                aria-label={t('settings.access.remoteServerUrl')}
                className={styles['settings-input']}
                value={remoteServerUrl}
                placeholder="http://192.168.31.75:14500"
                onChange={(event) => setRemoteServerUrl(event.target.value)}
              />
            </label>
          }
        />
        <SettingsRow
          label={t('settings.access.remoteServerKey')}
          hint={t('settings.access.remoteServerKeyHint')}
          layout="stacked"
          control={
            <label className={styles['access-field']}>
              <span>{t('settings.access.remoteServerKey')}</span>
              <input
                aria-label={t('settings.access.remoteServerKey')}
                className={styles['settings-input']}
                value={remoteServerKey}
                type="password"
                placeholder="hana_dev_..."
                onChange={(event) => setRemoteServerKey(event.target.value)}
              />
            </label>
          }
        />
        <SettingsSection.Footer>
          <button
            className={styles['settings-btn-primary']}
            type="button"
            onClick={connectRemoteServer}
            disabled={connectingRemoteServer || !remoteServerUrl.trim() || !remoteServerKey.trim()}
          >
            {t('settings.access.connectLanServer')}
          </button>
        </SettingsSection.Footer>
      </SettingsSection>

      <SettingsSection title={t('settings.access.pairedDevices')}>
        <div className={styles['access-device-list']}>
          {activeDevicesWithoutCredentials.length === 0 && activeCredentials.length === 0 ? (
            <div className={styles['access-empty']}>{t('settings.access.noDevices')}</div>
          ) : (
            <>
              {activeCredentials.map(credential => {
                const device = deviceById.get(credential.deviceId);
                return (
                  <div className={styles['access-device-item']} key={credential.credentialId}>
                    <div className={styles['access-device-info']}>
                      <span className={styles['access-device-name']}>{device?.displayName || credential.deviceId}</span>
                      <span className={styles['access-device-meta']}>
                        {device?.deviceKind || 'device'} · {credential.secretPrefix || credential.credentialId} · {credential.scopes.join(', ')}
                      </span>
                    </div>
                    <button
                      className={styles['settings-btn-secondary']}
                      type="button"
                      onClick={() => revokeCredential(credential.credentialId)}
                    >
                      {t('settings.access.revokeCredential')}
                    </button>
                  </div>
                );
              })}
              {activeDevicesWithoutCredentials.map(device => (
                <div className={styles['access-device-item']} key={device.deviceId}>
                  <div className={styles['access-device-info']}>
                    <span className={styles['access-device-name']}>{device.displayName}</span>
                    <span className={styles['access-device-meta']}>{device.deviceKind || 'device'} · {device.trustState || 'lan'}</span>
                  </div>
                  <button className={styles['settings-btn-secondary']} type="button" onClick={() => revokeDevice(device.deviceId)}>
                    {t('settings.access.revoke')}
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.access.localAccount')}>
        <SettingsRow
          label={t('settings.access.username')}
          layout="stacked"
          control={
            <label className={styles['access-field']}>
              <span>{t('settings.access.username')}</span>
              <input
                aria-label={t('settings.access.username')}
                className={styles['settings-input']}
                value={accountDraft.username}
                disabled={loadingSummary || !summary}
                onChange={(event) => setAccountDraft(prev => ({ ...prev, username: event.target.value }))}
              />
            </label>
          }
        />
        <SettingsRow
          label={t('settings.access.displayName')}
          layout="stacked"
          control={
            <label className={styles['access-field']}>
              <span>{t('settings.access.displayName')}</span>
              <input
                aria-label={t('settings.access.displayName')}
                className={styles['settings-input']}
                value={accountDraft.displayName}
                disabled={loadingSummary || !summary}
                onChange={(event) => setAccountDraft(prev => ({ ...prev, displayName: event.target.value }))}
              />
            </label>
          }
        />
        <SettingsSection.Footer>
          <button className={styles['settings-btn-primary']} type="button" onClick={saveAccount} disabled={loadingSummary || !summary}>
            {t('settings.access.saveAccount')}
          </button>
        </SettingsSection.Footer>
      </SettingsSection>

      <SettingsSection title={t('settings.access.password')}>
        <SettingsRow
          label={summary?.account.passwordSet ? t('settings.access.passwordSet') : t('settings.access.passwordNotSet')}
          hint={t('settings.access.passwordHint')}
          layout="stacked"
          control={
            <label className={styles['access-field']}>
              <span>{t('settings.access.newPassword')}</span>
              <input
                aria-label={t('settings.access.newPassword')}
                className={styles['settings-input']}
                type="password"
                value={passwordDraft}
                onChange={(event) => setPasswordDraft(event.target.value)}
              />
            </label>
          }
        />
        <SettingsSection.Footer>
          {summary?.account.passwordSet && (
            <button className={styles['settings-btn-secondary']} type="button" onClick={clearPassword}>
              {t('settings.access.clearPassword')}
            </button>
          )}
          <button className={styles['settings-btn-primary']} type="button" onClick={savePassword} disabled={!passwordDraft}>
            {t('settings.access.savePassword')}
          </button>
        </SettingsSection.Footer>
      </SettingsSection>
    </div>
  );
}

function remoteValue(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function remoteList(values: string[] | null | undefined, fallback: string): string {
  const list = Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()) : [];
  return list.length ? list.join(', ') : fallback;
}

function remoteConnectionKindLabel(value: string | null | undefined, fallback: string): string {
  switch (value) {
    case 'local': return t('settings.access.remoteConnectionKindLocal');
    case 'lan': return t('settings.access.remoteConnectionKindLan');
    case 'custom_remote': return t('settings.access.remoteConnectionKindCustom');
    case 'relay': return t('settings.access.remoteConnectionKindRelay');
    case 'cloud': return t('settings.access.remoteConnectionKindCloud');
    default: return fallback;
  }
}

function remoteTrustStateLabel(value: string | null | undefined, fallback: string): string {
  switch (value) {
    case 'local': return t('settings.access.remoteTrustLocal');
    case 'lan': return t('settings.access.remoteTrustLan');
    case 'tunnel': return t('settings.access.remoteTrustTunnel');
    case 'cloud': return t('settings.access.remoteTrustCloud');
    default: return fallback;
  }
}

function remoteAuthStateLabel(value: string | null | undefined, fallback: string): string {
  switch (value) {
    case 'paired': return t('settings.access.remoteAuthPaired');
    case 'user': return t('settings.access.remoteAuthUser');
    case 'anonymous': return t('settings.access.remoteAuthAnonymous');
    case 'expired': return t('settings.access.remoteAuthExpired');
    default: return fallback;
  }
}

function remoteCredentialKindLabel(value: string | null | undefined, fallback: string): string {
  switch (value) {
    case 'loopback_token': return t('settings.access.remoteCredentialLoopback');
    case 'device_credential': return t('settings.access.remoteCredentialDevice');
    case 'user_session': return t('settings.access.remoteCredentialUserSession');
    case 'none': return t('settings.access.remoteCredentialNone');
    default: return fallback;
  }
}

function remoteCapabilitySummary(values: string[] | null | undefined, fallback: string): string {
  const list = Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()) : [];
  if (list.length === 0) return fallback;
  const out: string[] = [];
  const has = (name: string) => list.some(value => value === name || value.startsWith(`${name}.`));
  if (has('chat')) out.push(t('settings.access.remoteCapabilityChat'));
  if (has('files')) out.push(t('settings.access.remoteCapabilityFiles'));
  if (has('resources')) out.push(t('settings.access.remoteCapabilityResources'));
  if (has('settings')) out.push(t('settings.access.remoteCapabilitySettings'));
  if (has('tools')) out.push(t('settings.access.remoteCapabilityTools'));
  if (has('bridge')) out.push(t('settings.access.remoteCapabilityBridge'));
  if (list.some(value => value.startsWith('providers.'))) out.push(t('settings.access.remoteCapabilityProviders'));
  if (out.length === 0) return remoteList(list, fallback);
  return Array.from(new Set(out)).join(', ');
}

function remoteRuntimeLabel(boundary: RemoteServerIdentity['executionBoundary'] | undefined, fallback: string): string {
  const kind = remoteValue(boundary?.kind);
  if (!kind) return fallback;
  if (kind === 'local_process') return t('settings.access.remoteRuntimeServerProcess');
  return t('settings.access.remoteRuntimeServer');
}
