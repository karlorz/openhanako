import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '../../stores';
import {
  buildAuthenticatedConnectionWsUrl,
  connectWebSocket,
  disconnectWebSocket,
  resolveStreamingSessionResumeTargets,
} from '../../services/websocket';

const remoteConnection = {
  connectionId: 'custom:remote',
  kind: 'custom_remote' as const,
  serverId: 'remote',
  studioId: 'default',
  label: 'Remote',
  baseUrl: 'https://hana.example',
  wsUrl: 'wss://hana.example',
  token: 'long-lived-secret',
  authState: 'paired' as const,
  trustState: 'tunnel' as const,
  credentialKind: 'device_credential' as const,
  capabilities: ['chat'],
};

describe('websocket session resume targets', () => {
  it('resolves sessionId-keyed streaming state back to current locators', () => {
    expect(resolveStreamingSessionResumeTargets({
      streamingSessions: ['sess_a', '/legacy.jsonl', 'sess_missing'],
      sessionLocatorsById: {
        sess_a: { path: '/sessions/a.jsonl' },
        sess_missing: { path: null },
      },
    } as never)).toEqual(['/sessions/a.jsonl', '/legacy.jsonl']);
  });
});

describe('websocket authenticated URL setup', () => {
  it('uses only the one-time ticket in a custom remote websocket URL', () => {
    const url = buildAuthenticatedConnectionWsUrl(remoteConnection, {
      mode: 'ticket',
      ticket: 'hana_ws_once',
      warningCode: null,
    });
    expect(url).toBe('wss://hana.example/ws?wsTicket=hana_ws_once');
    expect(url).not.toContain(remoteConnection.token);
  });

  it('routes unsupported custom remotes through the existing setup failure path', () => {
    expect(() => buildAuthenticatedConnectionWsUrl(remoteConnection, {
      mode: 'unsupported',
      ticket: null,
      warningCode: 'websocket_ticket_required',
    })).toThrow('websocket_ticket_required');
  });
});

describe('websocket explicit disconnect', () => {
  class TestWebSocket {
    static OPEN = 1;
    static instances: TestWebSocket[] = [];
    readyState = TestWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn(() => this.onclose?.());
    send = vi.fn();

    constructor(public readonly url: string) {
      TestWebSocket.instances.push(this);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    TestWebSocket.instances = [];
    vi.stubGlobal('WebSocket', TestWebSocket);
    useStore.setState({
      serverConnections: { [remoteConnection.connectionId]: remoteConnection },
      activeServerConnectionId: remoteConnection.connectionId,
      activeServerConnection: remoteConnection,
      remoteServerAssessment: null,
      wsState: 'disconnected',
      wsReconnectAttempt: 0,
    });
  });

  afterEach(() => {
    disconnectWebSocket();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('invalidates an asynchronous ticket setup before it can create a socket', async () => {
    let resolveTicket!: (response: Response) => void;
    const ticketResponse = new Promise<Response>((resolve) => {
      resolveTicket = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(() => ticketResponse));

    connectWebSocket();
    disconnectWebSocket();
    resolveTicket(jsonResponse({ ticket: 'hana_ws_after_logout' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(TestWebSocket.instances).toHaveLength(0);
    expect(useStore.getState().wsState).toBe('disconnected');
  });

  it('closes the current socket without scheduling an automatic reconnect', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ticket: 'hana_ws_once' })));

    connectWebSocket();
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
    const socket = TestWebSocket.instances[0];
    socket.onopen?.();

    disconnectWebSocket();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(TestWebSocket.instances).toHaveLength(1);
    expect(useStore.getState()).toMatchObject({
      wsState: 'disconnected',
      wsReconnectAttempt: 0,
    });
  });
});

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
  } as Response;
}
