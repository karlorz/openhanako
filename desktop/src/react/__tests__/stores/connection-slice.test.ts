import { describe, expect, it } from 'vitest';
import { createConnectionSlice, type ConnectionSlice } from '../../stores/connection-slice';
import { mergeServerIdentity } from '../../services/server-connection';
import { assessRemoteServer } from '../../../../../shared/remote-server-assessment';

function assessment(connectionId: string) {
  return assessRemoteServer({
    connectionId,
    boundary: { status: 'assessed', ok: true, reasonCodes: [], warningCodes: [] },
    server: { connectionKind: 'lan', runtimeVersion: '0.346.18' },
  });
}

function remoteFrom(local: NonNullable<ConnectionSlice['activeServerConnection']>, connectionId: string) {
  return {
    ...local,
    connectionId,
    kind: 'lan' as const,
    baseUrl: `http://${connectionId.replace(':', '-')}.test:14500`,
    wsUrl: `ws://${connectionId.replace(':', '-')}.test:14500`,
    token: 'device-token',
    trustState: 'lan' as const,
    credentialKind: 'device_credential' as const,
  };
}

function createHarness() {
  let state: ConnectionSlice;
  const set = (partial: Partial<ConnectionSlice>) => {
    state = { ...state, ...partial };
  };
  const get = () => state;
  state = createConnectionSlice(set, get);
  return {
    get state() {
      return state;
    },
  };
}

describe('connection slice registry', () => {
  it('sets local server connection into the registry and active mirror together', () => {
    const h = createHarness();

    h.state.setLocalServerConnection(3210, 'local-token');

    expect(h.state.activeServerConnectionId).toBe('local');
    expect(h.state.serverConnections.local).toEqual(h.state.activeServerConnection);
    expect(h.state.activeServerConnection).toMatchObject({
      connectionId: 'local',
      kind: 'local',
      baseUrl: 'http://127.0.0.1:3210',
      token: 'local-token',
    });
  });

  it('refreshes local transport without losing stable identity in the registry', () => {
    const h = createHarness();
    h.state.setLocalServerConnection(3210, 'old-token');
    const stable = mergeServerIdentity(h.state.activeServerConnection!, {
      serverId: 'server_stable',
      userId: 'user_stable',
      studioId: 'studio_stable',
      label: 'Stable Studio',
    });
    h.state.setActiveServerConnection(stable);

    h.state.setLocalServerConnection(4222, 'new-token');

    expect(h.state.activeServerConnectionId).toBe('local');
    expect(h.state.activeServerConnection).toMatchObject({
      connectionId: 'local',
      serverId: 'server_stable',
      userId: 'user_stable',
      studioId: 'studio_stable',
      baseUrl: 'http://127.0.0.1:4222',
      token: 'new-token',
    });
    expect(h.state.serverConnections.local).toEqual(h.state.activeServerConnection);
  });

  it('can select a non-local connection from the registry without touching legacy port fields', () => {
    const h = createHarness();
    h.state.setLocalServerConnection(3210, 'local-token');
    const remote = {
      ...h.state.activeServerConnection!,
      connectionId: 'custom:remote',
      kind: 'custom_remote' as const,
      label: 'Remote Studio',
      baseUrl: 'https://hana.example',
      wsUrl: 'wss://hana.example',
      token: 'remote-token',
      trustState: 'tunnel' as const,
      credentialKind: 'device_credential' as const,
    };

    h.state.upsertServerConnection(remote);
    h.state.selectServerConnection('custom:remote');

    expect(h.state.serverPort).toBe('3210');
    expect(h.state.serverToken).toBe('local-token');
    expect(h.state.activeServerConnectionId).toBe('custom:remote');
    expect(h.state.activeServerConnection).toBe(remote);
  });

  it('clears an assessment when selecting another connection', () => {
    const h = createHarness();
    h.state.setLocalServerConnection(3210, 'local-token');
    const first = remoteFrom(h.state.activeServerConnection!, 'lan:first');
    const second = remoteFrom(h.state.activeServerConnection!, 'lan:second');
    h.state.upsertServerConnection(first);
    h.state.upsertServerConnection(second);
    h.state.selectServerConnection(first.connectionId);
    h.state.setRemoteServerAssessment(assessment(first.connectionId));

    h.state.selectServerConnection(second.connectionId);

    expect(h.state.remoteServerAssessment).toBeNull();
  });

  it('clears a remote assessment when switching to the local owner', () => {
    const h = createHarness();
    h.state.setLocalServerConnection(3210, 'local-token');
    const remote = remoteFrom(h.state.activeServerConnection!, 'lan:first');
    h.state.setActiveServerConnection(remote);
    h.state.setRemoteServerAssessment(assessment(remote.connectionId));

    h.state.setLocalServerConnection(3210, 'local-token');

    expect(h.state.remoteServerAssessment).toBeNull();
  });

  it('keeps the active assessment when upserting a non-active connection', () => {
    const h = createHarness();
    h.state.setLocalServerConnection(3210, 'local-token');
    const remote = remoteFrom(h.state.activeServerConnection!, 'lan:first');
    h.state.setActiveServerConnection(remote);
    const activeAssessment = assessment(remote.connectionId);
    h.state.setRemoteServerAssessment(activeAssessment);

    h.state.upsertServerConnection(remoteFrom(h.state.serverConnections.local, 'lan:second'));

    expect(h.state.remoteServerAssessment).toEqual(activeAssessment);
  });

  it('rejects an assessment for a connection other than the active one', () => {
    const h = createHarness();
    h.state.setLocalServerConnection(3210, 'local-token');
    const remote = remoteFrom(h.state.activeServerConnection!, 'lan:first');
    h.state.setActiveServerConnection(remote);

    h.state.setRemoteServerAssessment(assessment('lan:other'));

    expect(h.state.remoteServerAssessment).toBeNull();
  });
});
