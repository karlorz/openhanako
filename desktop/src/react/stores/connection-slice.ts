import type { RemoteCompatibilityReasonCode } from '../services/remote-boundary-contract';
import type { RemoteServerAssessment } from '../../../../shared/remote-server-assessment';
import type { ServerConnection, ServerConnectionRegistry } from '../services/server-connection';
import { LOCAL_CONNECTION_ID, isLocalOwnerConnection, refreshLocalServerConnection, upsertServerConnection } from '../services/server-connection';

export interface RemoteConnectionRecoveryState {
  status: 'identity_failed' | 'compatibility_failed';
  connectionId: string;
  baseUrl: string;
  reasonCodes: RemoteCompatibilityReasonCode[];
  warningCodes: RemoteCompatibilityReasonCode[];
}

export interface ConnectionSlice {
  serverPort: string | null;
  serverToken: string | null;
  serverConnections: ServerConnectionRegistry;
  activeServerConnectionId: string | null;
  activeServerConnection: ServerConnection | null;
  remoteConnectionRecovery: RemoteConnectionRecoveryState | null;
  remoteServerAssessment: RemoteServerAssessment | null;
  connected: boolean;
  statusKey: string;
  statusVars: Record<string, string | number>;
  /** Bridge dot: at least one platform connected */
  bridgeDotConnected: boolean;
  wsState: 'connected' | 'reconnecting' | 'disconnected';
  wsReconnectAttempt: number;
  setServerPort: (port: string | number | null) => void;
  setServerToken: (token: string | null) => void;
  setActiveServerConnection: (connection: ServerConnection | null) => void;
  setLocalServerConnection: (port: string | number | null, token: string | null) => void;
  upsertServerConnection: (connection: ServerConnection) => void;
  selectServerConnection: (connectionId: string) => void;
  setRemoteServerAssessment: (assessment: RemoteServerAssessment | null) => void;
  setConnected: (connected: boolean) => void;
  oauthSessionId: string | null;
  setOauthSessionId: (id: string | null) => void;
}

export const createConnectionSlice = (
  set: (partial: Partial<ConnectionSlice>) => void,
  get?: () => Pick<ConnectionSlice, 'serverPort' | 'serverToken' | 'serverConnections' | 'activeServerConnectionId' | 'activeServerConnection' | 'remoteServerAssessment' | 'oauthSessionId'>,
): ConnectionSlice => ({
  serverPort: null,
  serverToken: null,
  serverConnections: {},
  activeServerConnectionId: null,
  activeServerConnection: null,
  remoteConnectionRecovery: null,
  remoteServerAssessment: null,
  connected: false,
  statusKey: 'status.connecting',
  statusVars: {},
  bridgeDotConnected: false,
  wsState: 'disconnected',
  wsReconnectAttempt: 0,
  oauthSessionId: null,
  setServerPort: (port) => {
    const serverPort = port === null || port === undefined ? null : String(port);
    const serverToken = get?.().serverToken ?? null;
    const existingConnection = get?.().serverConnections?.[LOCAL_CONNECTION_ID]
      ?? get?.().activeServerConnection;
    const activeServerConnection = refreshLocalServerConnection({
      existingConnection,
      serverPort,
      serverToken,
    });
    set({
      serverPort,
      ...(activeServerConnection
        ? {
            serverConnections: upsertServerConnection(get?.().serverConnections, activeServerConnection),
            activeServerConnectionId: activeServerConnection.connectionId,
            activeServerConnection,
            remoteConnectionRecovery: null,
            remoteServerAssessment: null,
          }
        : {
            activeServerConnectionId: null,
            activeServerConnection: null,
            remoteConnectionRecovery: null,
            remoteServerAssessment: null,
          }),
    });
  },
  setServerToken: (token) => {
    const serverPort = get?.().serverPort ?? null;
    const existingConnection = get?.().serverConnections?.[LOCAL_CONNECTION_ID]
      ?? get?.().activeServerConnection;
    const activeServerConnection = refreshLocalServerConnection({
      existingConnection,
      serverPort,
      serverToken: token,
    });
    set({
      serverToken: token,
      ...(activeServerConnection
        ? {
            serverConnections: upsertServerConnection(get?.().serverConnections, activeServerConnection),
            activeServerConnectionId: activeServerConnection.connectionId,
            activeServerConnection,
            remoteConnectionRecovery: null,
            remoteServerAssessment: null,
          }
        : {
            activeServerConnectionId: null,
            activeServerConnection: null,
            remoteConnectionRecovery: null,
            remoteServerAssessment: null,
          }),
    });
  },
  setActiveServerConnection: (connection) => set(connection
    ? {
        serverConnections: upsertServerConnection(get?.().serverConnections, connection),
        activeServerConnectionId: connection.connectionId,
        activeServerConnection: connection,
        remoteConnectionRecovery: null,
        remoteServerAssessment: isLocalOwnerConnection(connection)
          || get?.().remoteServerAssessment?.connectionId !== connection.connectionId
          ? null
          : get?.().remoteServerAssessment ?? null,
      }
    : {
        activeServerConnectionId: null,
        activeServerConnection: null,
        remoteConnectionRecovery: null,
        remoteServerAssessment: null,
      }),
  setLocalServerConnection: (port, token) => {
    const serverPort = port === null || port === undefined ? null : String(port);
    const existingConnection = get?.().serverConnections?.[LOCAL_CONNECTION_ID]
      ?? get?.().activeServerConnection;
    const activeServerConnection = refreshLocalServerConnection({
      existingConnection,
      serverPort,
      serverToken: token,
    });
    set({
      serverPort,
      serverToken: token,
      ...(activeServerConnection
        ? {
            serverConnections: upsertServerConnection(get?.().serverConnections, activeServerConnection),
            activeServerConnectionId: activeServerConnection.connectionId,
            activeServerConnection,
            remoteConnectionRecovery: null,
            remoteServerAssessment: null,
          }
        : {
            activeServerConnectionId: null,
            activeServerConnection: null,
            remoteConnectionRecovery: null,
            remoteServerAssessment: null,
          }),
    });
  },
  upsertServerConnection: (connection) => set({
    serverConnections: upsertServerConnection(get?.().serverConnections, connection),
  }),
  selectServerConnection: (connectionId) => {
    const connection = get?.().serverConnections?.[connectionId];
    if (!connection) throw new Error(`server connection not found: ${connectionId}`);
    set({
      activeServerConnectionId: connectionId,
      activeServerConnection: connection,
      remoteConnectionRecovery: null,
      remoteServerAssessment: isLocalOwnerConnection(connection)
        || get?.().remoteServerAssessment?.connectionId !== connectionId
        ? null
        : get?.().remoteServerAssessment ?? null,
    });
  },
  setRemoteServerAssessment: (assessment) => {
    const state = get?.();
    const active = state?.activeServerConnection;
    set({
      remoteServerAssessment: assessment
        && active
        && !isLocalOwnerConnection(active)
        && assessment.connectionId === state?.activeServerConnectionId
        ? assessment
        : null,
    });
  },
  setConnected: (connected) => set({ connected }),
  setOauthSessionId: (id) => set({ oauthSessionId: id }),
});
