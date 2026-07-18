import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConnection } from '../../services/server-connection';

const lifecycle = vi.hoisted(() => ({
  clearInputDraftRemoteSession: vi.fn(),
}));

const remoteConnection = {
  connectionId: 'lan:server:studio',
  kind: 'lan' as const,
  serverId: 'server',
  studioId: 'studio',
  label: 'Remote',
  baseUrl: 'http://192.168.1.20:14500',
  wsUrl: 'ws://192.168.1.20:14500',
  token: 'credential',
  authState: 'paired' as const,
  trustState: 'lan' as const,
  credentialKind: 'device_credential' as const,
  capabilities: ['chat'],
};
const localConnection = {
  ...remoteConnection,
  connectionId: 'local',
  kind: 'local' as const,
  baseUrl: 'http://127.0.0.1:14500',
  wsUrl: 'ws://127.0.0.1:14500',
  trustState: 'local' as const,
  credentialKind: 'loopback_token' as const,
};
let connectionForAttempt: ServerConnection = remoteConnection;

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => ({ activeServerConnection: remoteConnection }),
    setState: vi.fn(),
  },
}));
vi.mock('../../services/ws-message-handler', () => ({ handleServerMessage: vi.fn(), applyStreamingStatus: vi.fn() }));
vi.mock('../../services/stream-resume', () => ({ injectHandlers: vi.fn(), injectWebSocketGetter: vi.fn(), requestStreamResume: vi.fn() }));
vi.mock('../../services/resource-events', () => ({
  bindResourceEventForegroundCatchUp: () => () => undefined,
  catchUpResourceEventsAfterReconnect: vi.fn(),
  recordResourceEventCursor: vi.fn(),
}));
vi.mock('../../utils/ui-helpers', () => ({ setStatus: vi.fn() }));
vi.mock('../../services/server-connection', () => ({
  resolveServerConnection: () => connectionForAttempt,
  isLocalOwnerConnection: (connection: typeof remoteConnection | typeof localConnection) => connection.kind === 'local',
  requestConnectionWsTicket: () => new Promise(() => undefined),
}));
vi.mock('../../stores/input-draft-persistence', () => lifecycle);

import { connectWebSocket, manualReconnect } from '../../services/websocket';

describe('websocket input-draft lifecycle', () => {
  beforeEach(() => {
    connectionForAttempt = remoteConnection;
    lifecycle.clearInputDraftRemoteSession.mockClear();
  });

  it('clears active remote draft evidence for reconnect and manual retry attempts', () => {
    connectWebSocket();
    manualReconnect();

    expect(lifecycle.clearInputDraftRemoteSession).toHaveBeenNthCalledWith(1, remoteConnection.connectionId);
    expect(lifecycle.clearInputDraftRemoteSession).toHaveBeenNthCalledWith(2, remoteConnection.connectionId);
  });

  it('preserves local-owner draft persistence during a reconnect attempt', () => {
    connectionForAttempt = localConnection;

    connectWebSocket();

    expect(lifecycle.clearInputDraftRemoteSession).not.toHaveBeenCalled();
  });
});
