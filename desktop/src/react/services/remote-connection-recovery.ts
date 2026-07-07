import type { RemoteConnectionRecoveryState } from '../stores/connection-slice';
import type { RemoteCompatibilityReasonCode } from './remote-boundary-contract';
import { RemoteBoundaryContractError } from './remote-boundary-contract';
import { LOCAL_CONNECTION_ID, isLocalOwnerConnection, type ServerConnection } from './server-connection';

export { RemoteBoundaryContractError } from './remote-boundary-contract';

export const REMOTE_CONNECTION_RECOVERY_STORAGE_KEY = 'hana-remote-connection-recovery-v1';

export function remoteRecoveryForActiveConnection(
  recovery: RemoteConnectionRecoveryState | null | undefined,
  activeConnectionId: string | null | undefined,
): boolean {
  return !!recovery && !!activeConnectionId && recovery.connectionId === activeConnectionId;
}

export function remoteRecoveryCodesForConnection(
  recovery: RemoteConnectionRecoveryState | null | undefined,
  connectionId: string | null | undefined,
): {
  reasonCodes: RemoteCompatibilityReasonCode[];
  warningCodes: RemoteCompatibilityReasonCode[];
} {
  if (!recovery || !connectionId || recovery.connectionId !== connectionId) {
    return { reasonCodes: [], warningCodes: [] };
  }
  return {
    reasonCodes: Array.isArray(recovery.reasonCodes) ? recovery.reasonCodes : [],
    warningCodes: Array.isArray(recovery.warningCodes) ? recovery.warningCodes : [],
  };
}

export function remoteRecoveryForStartupFailure(
  connection: ServerConnection,
  err: unknown,
): RemoteConnectionRecoveryState | null {
  if (connection.connectionId === LOCAL_CONNECTION_ID || isLocalOwnerConnection(connection)) return null;
  if (err instanceof RemoteBoundaryContractError) {
    return {
      status: 'compatibility_failed',
      connectionId: connection.connectionId,
      baseUrl: connection.baseUrl,
      reasonCodes: err.compatibility.reasonCodes,
      warningCodes: err.compatibility.warningCodes,
    };
  }
  return {
    status: 'identity_failed',
    connectionId: connection.connectionId,
    baseUrl: connection.baseUrl,
    reasonCodes: [isRemoteAuthFailure(err) ? 'auth_failed' : 'invalid_identity'],
    warningCodes: [],
  };
}

function isRemoteAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /\/api\/web-auth\/login: (401|403)\b/.test(message)
    || /server connection request failed: (401|403)\b/.test(message);
}

export function readRemoteConnectionRecoveryState(
  storage: Storage | null | undefined = getDefaultStorage(),
): RemoteConnectionRecoveryState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(REMOTE_CONNECTION_RECOVERY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      (parsed?.status !== 'identity_failed' && parsed?.status !== 'compatibility_failed')
      || typeof parsed?.connectionId !== 'string'
      || typeof parsed?.baseUrl !== 'string'
    ) {
      return null;
    }
    return {
      status: parsed.status,
      connectionId: parsed.connectionId,
      baseUrl: parsed.baseUrl,
      reasonCodes: Array.isArray(parsed.reasonCodes) ? parsed.reasonCodes : [],
      warningCodes: Array.isArray(parsed.warningCodes) ? parsed.warningCodes : [],
    };
  } catch {
    return null;
  }
}

export function writeRemoteConnectionRecoveryState(
  recovery: RemoteConnectionRecoveryState,
  storage: Storage | null | undefined = getDefaultStorage(),
): void {
  if (!storage) return;
  storage.setItem(REMOTE_CONNECTION_RECOVERY_STORAGE_KEY, JSON.stringify(recovery));
}

export function clearRemoteConnectionRecoveryState(
  storage: Storage | null | undefined = getDefaultStorage(),
): void {
  if (!storage) return;
  storage.removeItem(REMOTE_CONNECTION_RECOVERY_STORAGE_KEY);
}

function getDefaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
