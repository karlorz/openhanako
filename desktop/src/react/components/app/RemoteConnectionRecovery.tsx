import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { KeyInput } from '../../settings/widgets/KeyInput';
import {
  LOCAL_CONNECTION_ID,
  connectDeviceServerConnection,
  isLocalOwnerConnection,
  persistServerConnectionSelection,
  upsertServerConnection,
  writePersistedServerConnectionState,
} from '../../services/server-connection';
import { clearRemoteConnectionRecoveryState, remoteRecoveryCodesForConnection, remoteRecoveryForActiveConnection } from '../../services/remote-connection-recovery';
import settingsStyles from '../../settings/Settings.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

export function RemoteConnectionRecovery() {
  const activeConnection = useStore(s => s.activeServerConnection);
  const activeConnectionId = useStore(s => s.activeServerConnectionId);
  const serverConnections = useStore(s => s.serverConnections);
  const recovery = useStore(s => s.remoteConnectionRecovery);
  const [serverUrl, setServerUrl] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!recovery || !activeConnection) return;
    if (!remoteRecoveryForActiveConnection(recovery, activeConnection.connectionId)) return;
    setServerUrl(activeConnection.baseUrl || recovery.baseUrl || '');
    setAccessKey(activeConnection.token || '');
  }, [activeConnection, recovery]);

  const retryRemote = useCallback(async () => {
    if (!serverUrl.trim() || !accessKey.trim() || retrying) return;
    setRetrying(true);
    setError('');
    try {
      const connection = await connectDeviceServerConnection({
        baseUrl: serverUrl,
        credential: accessKey,
      });
      persistServerConnectionSelection(connection);
      useStore.setState({
        serverConnections: upsertServerConnection(useStore.getState().serverConnections, connection),
        activeServerConnectionId: connection.connectionId,
        activeServerConnection: connection,
        remoteConnectionRecovery: null,
      });
      clearRemoteConnectionRecoveryState();
      window.hana?.reloadMainWindow?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }, [accessKey, retrying, serverUrl]);

  const switchLocal = useCallback(() => {
    const current = useStore.getState();
    const local = current.serverConnections[LOCAL_CONNECTION_ID];
    if (!isLocalOwnerConnection(local)) {
      setError(t('app.remoteRecovery.localUnavailable'));
      return;
    }
    writePersistedServerConnectionState({
      serverConnections: current.serverConnections,
      activeServerConnectionId: null,
    });
    useStore.setState({
      activeServerConnectionId: local.connectionId,
      activeServerConnection: local,
      remoteConnectionRecovery: null,
    });
    clearRemoteConnectionRecoveryState();
    window.hana?.reloadMainWindow?.();
  }, []);

  if (!recovery || !activeConnection || !remoteRecoveryForActiveConnection(recovery, activeConnectionId)) {
    return null;
  }

  const { reasonCodes, warningCodes } = remoteRecoveryCodesForConnection(recovery, activeConnectionId);

  return (
    <div className="remote-recovery" role="region" aria-label={t('app.remoteRecovery.title')}>
      <div className="remote-recovery-header">
        <div>
          <h2>{t('app.remoteRecovery.title')}</h2>
          <p>{t('app.remoteRecovery.subtitle')}</p>
        </div>
        <span>{t(`app.remoteRecovery.status.${recovery.status}`)}</span>
      </div>
      <div className="remote-recovery-reasons">
        {reasonCodes.map(code => (
          <span key={`reason:${code}`}>{t(`settings.access.remoteReason.${code}`)}</span>
        ))}
        {warningCodes.map(code => (
          <span key={`warning:${code}`}>{t(`settings.access.remoteWarning.${code}`)}</span>
        ))}
      </div>
      <div className="remote-recovery-form">
        <label>
          <span>{t('app.remoteRecovery.serverUrl')}</span>
          <input
            aria-label={t('app.remoteRecovery.serverUrl')}
            className={settingsStyles['settings-input']}
            value={serverUrl}
            onChange={event => setServerUrl(event.target.value)}
          />
        </label>
        <label>
          <span>{t('app.remoteRecovery.accessKey')}</span>
          <KeyInput
            ariaLabel={t('app.remoteRecovery.accessKey')}
            value={accessKey}
            onChange={setAccessKey}
            placeholder="hana_dev_..."
          />
        </label>
      </div>
      {error && <div className="remote-recovery-error">{error}</div>}
      <div className="remote-recovery-actions">
        <button
          className={settingsStyles['settings-btn-primary']}
          type="button"
          onClick={() => { void retryRemote(); }}
          disabled={retrying || !serverUrl.trim() || !accessKey.trim()}
        >
          {retrying ? t('app.remoteRecovery.retrying') : t('app.remoteRecovery.retryRemote')}
        </button>
        <button
          className={settingsStyles['settings-btn-secondary']}
          type="button"
          onClick={switchLocal}
        >
          {t('app.remoteRecovery.switchLocal')}
        </button>
      </div>
    </div>
  );
}
