import type { RemoteConnectionRecoveryState } from '../stores/connection-slice';
import type { RemoteBoundaryCompatibility, RemoteCompatibilityReasonCode } from './remote-boundary-contract';
import { LOCAL_CONNECTION_ID, isLocalOwnerConnection, type ServerConnection } from './server-connection';

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

export class RemoteBoundaryContractError extends Error {
  readonly compatibility: RemoteBoundaryCompatibility;

  constructor(compatibility: RemoteBoundaryCompatibility) {
    super('remote boundary contract failed');
    this.name = 'RemoteBoundaryContractError';
    this.compatibility = compatibility;
  }
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
    reasonCodes: ['invalid_identity'],
    warningCodes: [],
  };
}