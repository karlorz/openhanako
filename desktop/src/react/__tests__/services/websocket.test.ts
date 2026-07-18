import { describe, expect, it } from 'vitest';

import {
  buildAuthenticatedConnectionWsUrl,
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
