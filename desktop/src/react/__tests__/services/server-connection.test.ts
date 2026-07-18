import { describe, expect, it, vi } from 'vitest';

import {
  appendConnectionAuth,
  buildScopedConnectSources,
  buildConnectionUrl,
  buildConnectionWsUrl,
  canUseQueryToken,
  connectDeviceServerConnection,
  createDeviceServerConnection,
  createLocalServerConnection,
  hasServerConnection,
  isLocalOwnerConnection,
  mergeServerIdentity,
  persistServerConnectionSelection,
  readPersistedServerConnectionState,
  refreshLocalServerConnection,
  refreshLocalServerConnectionState,
  requestConnectionWsTicket,
  resolveServerConnection,
  upsertServerConnection,
  warnIfServerProtocolMismatch,
  writePersistedServerConnectionState,
} from '../../services/server-connection';
import { SERVER_PROTOCOL_VERSION } from '../../../../../shared/contract-versions.ts';

type WsAuthCapability = 'loopback-owner' | 'ticket' | 'legacy-query-token' | 'unsupported';

/**
 * Read-only capability probe for migration characterization.
 * Classifies a server by probing POST /api/ws-ticket.
 * Kept in test/support code; does not change runtime selection.
 */
async function probeWsAuthCapability(
  baseUrl: string,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WsAuthCapability> {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (!trimmed) return 'unsupported';
  try {
    const loopback = new URL(trimmed);
    if (loopback.hostname === '127.0.0.1' || loopback.hostname === 'localhost') {
      return 'loopback-owner';
    }
  } catch {
    return 'unsupported';
  }

  let response: Response;
  try {
    response = await fetchImpl(`${trimmed}/api/ws-ticket`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
    });
  } catch {
    return 'unsupported';
  }

  if (response.status === 200) return 'ticket';
  if (response.status === 404) return 'legacy-query-token';
  // Authenticated principal missing/forbidden still means the ticket surface exists.
  if (response.status === 401 || response.status === 403) return 'ticket';
  return 'unsupported';
}

/**
 * Inventory-driven probe: preferred post-migration ticket path for LAN is
 * active only when the websocket-ticket-auth contract is retained/adapted
 * AND the client no longer embeds long-lived LAN credentials in WS URLs.
 * Uses canUseQueryToken as the runtime signal of current fork selection.
 */
function preferredLanTicketPathActive(connection: {
  kind: string;
  credentialKind: string;
}): boolean {
  // Preferred migration shape: LAN device credentials request a ticket and
  // do not put the long-lived credential into the websocket URL.
  return !canUseQueryToken(connection as any);
}

const remoteExecutionBoundary = {
  kind: 'remote_process',
  serverNodeId: 'node_lan',
  studioId: 'studio_lan',
  workbench: { kind: 'legacy_agent_workbench', root: null },
};

describe('server connection helpers', () => {
  it('creates the local default ServerConnection from port and token', () => {
    expect(createLocalServerConnection({
      serverPort: 3210,
      serverToken: 'test-token-123',
    })).toEqual({
      connectionId: 'local',
      kind: 'local',
      serverId: 'local',
      studioId: 'local',
      label: 'Local Hana',
      baseUrl: 'http://127.0.0.1:3210',
      wsUrl: 'ws://127.0.0.1:3210',
      token: 'test-token-123',
      authState: 'paired',
      trustState: 'local',
      credentialKind: 'loopback_token',
      platformAccountId: null,
      officialServiceKind: null,
      capabilities: ['chat', 'resources', 'files', 'tools'],
    });
  });

  it('returns null when local server port is not ready', () => {
    expect(createLocalServerConnection({
      serverPort: null,
      serverToken: 'test-token-123',
    })).toBeNull();
  });

  it('reports readiness from active connection while preserving legacy compatibility', () => {
    const active = createLocalServerConnection({
      serverPort: 4242,
      serverToken: 'active-token',
    });

    expect(hasServerConnection({ activeServerConnection: active })).toBe(true);
    expect(hasServerConnection({ serverPort: 3210, serverToken: 'legacy-token' })).toBe(true);
    expect(hasServerConnection({ serverPort: null, serverToken: 'legacy-token' })).toBe(false);
  });

  it('prefers the active connection over legacy port and token fields', () => {
    const active = createLocalServerConnection({
      serverPort: 4242,
      serverToken: 'active-token',
    });

    expect(resolveServerConnection({
      activeServerConnection: active,
      serverPort: 3210,
      serverToken: 'legacy-token',
    })).toBe(active);
  });

  it('resolves the active connection from the StudioConnection registry before legacy mirror fields', () => {
    const registryConnection = mergeServerIdentity(createLocalServerConnection({
      serverPort: 4242,
      serverToken: 'registry-token',
    })!, {
      serverId: 'server_registry',
      userId: 'user_registry',
      studioId: 'studio_registry',
      label: 'Registry Studio',
    });
    const staleMirror = createLocalServerConnection({
      serverPort: 3210,
      serverToken: 'stale-token',
    });

    expect(resolveServerConnection({
      activeServerConnectionId: 'local',
      serverConnections: { local: registryConnection },
      activeServerConnection: staleMirror,
      serverPort: 3210,
      serverToken: 'legacy-token',
    })).toBe(registryConnection);
  });

  it('upserts connections by connectionId without mutating the previous registry', () => {
    const local = createLocalServerConnection({
      serverPort: 3210,
      serverToken: 'local-token',
    })!;
    const remote = {
      ...local,
      connectionId: 'custom:remote',
      kind: 'custom_remote' as const,
      label: 'Remote Studio',
      baseUrl: 'https://hana.example',
      wsUrl: 'wss://hana.example',
      token: 'remote-token',
      trustState: 'tunnel' as const,
      credentialKind: 'device_credential' as const,
    };
    const previousRegistry = { local };
    const registry = upsertServerConnection(previousRegistry, remote);

    expect(Object.keys(registry)).toEqual(['local', 'custom:remote']);
    expect(registry['custom:remote']).toBe(remote);
    expect(registry).not.toBe(previousRegistry);
    expect(previousRegistry).toEqual({ local });
  });

  it('rejects registry entries that violate the trusted access contract', () => {
    const local = createLocalServerConnection({
      serverPort: 3210,
      serverToken: 'local-token',
    })!;
    const invalidRemote = {
      ...local,
      connectionId: 'lan:bad',
      kind: 'lan' as const,
      label: 'Bad LAN Studio',
      baseUrl: 'http://192.168.1.20:14500',
      wsUrl: 'ws://192.168.1.20:14500',
      trustState: 'lan' as const,
      credentialKind: 'loopback_token' as const,
    };

    expect(() => upsertServerConnection({ local }, invalidRemote))
      .toThrow('lan connection must not use loopback_token');
  });

  it('builds browser-loadable URLs with query token while preserving existing query params', () => {
    const connection = createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'test-token-123',
    });
    expect(connection).not.toBeNull();

    expect(buildConnectionUrl(connection!, '/api/agents/hana/avatar', { includeTokenQuery: true }))
      .toBe('http://127.0.0.1:3210/api/agents/hana/avatar?token=test-token-123');
    expect(buildConnectionUrl(connection!, '/api/sessions?limit=10', { includeTokenQuery: true }))
      .toBe('http://127.0.0.1:3210/api/sessions?limit=10&token=test-token-123');
  });

  it('does not put remote device credentials into browser-loadable URL query strings', () => {
    const local = createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'local-token',
    })!;
    const remote = {
      ...local,
      connectionId: 'custom:remote',
      kind: 'custom_remote' as const,
      label: 'Remote Studio',
      baseUrl: 'https://hana.example',
      wsUrl: 'wss://hana.example',
      token: 'remote-token',
      trustState: 'tunnel' as const,
      credentialKind: 'device_credential' as const,
    };

    expect(buildConnectionUrl(remote, '/api/resources/res_1/content', { includeTokenQuery: true }))
      .toBe('https://hana.example/api/resources/res_1/content');
    expect(buildConnectionWsUrl(remote, '/ws')).toBe('wss://hana.example/ws');
  });

  it('keeps additive server assessment evidence out of persisted connection state', () => {
    const connection = createDeviceServerConnection({
      baseUrl: 'http://192.168.1.20:14500',
      credential: 'device-secret',
      identity: {
        connectionKind: 'lan',
        serverId: 'server_evidence',
        serverNodeId: 'node_evidence',
        studioId: 'studio_evidence',
        label: 'Evidence Server',
        runtimeBuild: {
          schemaVersion: 1,
          runtimeVersion: '0.407.15',
          releaseTag: 'v0.407.15-karlorz.1',
          gitSha: '0123456789abcdef0123456789abcdef01234567',
          sourceRepository: 'karlorz/openhanako',
        },
        featureContracts: {
          schemaVersion: 1,
          complete: true,
          entries: { 'chat.core': 1, 'input.drafts': 1, 'websocket.ticket': 1 },
        },
        runtimeFacts: { platform: 'linux', arch: 'arm64' },
      },
    });

    expect(connection).not.toHaveProperty('runtimeBuild');
    expect(connection).not.toHaveProperty('featureContracts');
    expect(connection).not.toHaveProperty('runtimeFacts');
  });

  it('identifies the local owner connection by the same contract as server route security', () => {
    const local = createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'local-token',
    })!;
    const remote = {
      ...local,
      connectionId: 'lan:node_lan:studio_lan',
      kind: 'lan' as const,
      label: 'LAN Studio',
      baseUrl: 'http://192.168.31.75:14500',
      wsUrl: 'ws://192.168.31.75:14500',
      token: 'remote-token',
      trustState: 'lan' as const,
      credentialKind: 'device_credential' as const,
    };

    expect(isLocalOwnerConnection(local)).toBe(true);
    expect(isLocalOwnerConnection(remote)).toBe(false);
    expect(isLocalOwnerConnection(null)).toBe(false);
  });

  it('does not treat malformed local-ish persisted state as a local owner', () => {
    const local = createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'local-token',
    })!;

    expect(isLocalOwnerConnection({
      ...local,
      credentialKind: 'device_credential',
    })).toBe(false);
    expect(isLocalOwnerConnection({
      ...local,
      baseUrl: 'http://100.125.173.118:14500',
      wsUrl: 'ws://100.125.173.118:14500',
    })).toBe(false);
  });

  it('builds scoped CSP connect sources for only the active configured remote origin', () => {
    const local = createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'local-token',
    })!;
    const remote = {
      ...local,
      connectionId: 'lan:node_lan:studio_lan',
      kind: 'lan' as const,
      label: 'LAN Studio',
      baseUrl: 'http://192.168.31.75:14500',
      wsUrl: 'ws://192.168.31.75:14500',
      token: 'remote-token',
      trustState: 'lan' as const,
      credentialKind: 'device_credential' as const,
    };

    expect(buildScopedConnectSources(remote)).toEqual([
      'http://192.168.31.75:14500',
      'ws://192.168.31.75:14500',
    ]);
    expect(buildScopedConnectSources(remote)).not.toContain('http:');
    expect(buildScopedConnectSources(remote)).not.toContain('ws:');
  });

  it('updates the local restart token without stealing an active remote connection', () => {
    const local = createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'old-local-token',
    })!;
    const remote = {
      ...local,
      connectionId: 'lan:node_lan:studio_lan',
      kind: 'lan' as const,
      label: 'LAN Studio',
      baseUrl: 'http://192.168.31.75:14500',
      wsUrl: 'ws://192.168.31.75:14500',
      token: 'remote-token',
      trustState: 'lan' as const,
      credentialKind: 'device_credential' as const,
    };

    const next = refreshLocalServerConnectionState({
      serverConnections: { local, [remote.connectionId]: remote },
      activeServerConnectionId: remote.connectionId,
      activeServerConnection: remote,
      serverPort: '63001',
      serverToken: 'new-local-token',
    });

    expect(next.serverConnections.local).toEqual(expect.objectContaining({
      baseUrl: 'http://127.0.0.1:63001',
      wsUrl: 'ws://127.0.0.1:63001',
      token: 'new-local-token',
    }));
    expect(next.activeServerConnectionId).toBe(remote.connectionId);
    expect(next.activeServerConnection).toBe(next.serverConnections[remote.connectionId]);
  });

  it('creates a LAN device ServerConnection from manual URL, credential, and server identity', () => {
    const connection = createDeviceServerConnection({
      baseUrl: '192.168.31.75:14500/mobile/',
      credential: 'fixture-key',
      identity: {
        connectionKind: 'lan',
        serverId: 'server_lan',
        serverNodeId: 'node_lan',
        userId: 'user_lan',
        studioId: 'studio_lan',
        label: 'LAN Server',
        studioLabel: 'Personal Studio',
        trustState: 'lan',
        authState: 'paired',
        credentialKind: 'device_credential',
        capabilities: ['chat', 'resources', 'files'],
      },
    });

    expect(connection).toMatchObject({
      connectionId: 'lan:node_lan:studio_lan',
      kind: 'lan',
      serverId: 'server_lan',
      serverNodeId: 'node_lan',
      studioId: 'studio_lan',
      label: 'Personal Studio',
      baseUrl: 'http://192.168.31.75:14500',
      wsUrl: 'ws://192.168.31.75:14500',
      token: 'fixture-key',
      trustState: 'lan',
      credentialKind: 'device_credential',
      capabilities: ['chat', 'resources', 'files'],
    });
  });

  it('preserves fine-grained desktop owner scopes as browser capabilities', async () => {
    const { createBrowserServerConnection } = await import('../../services/server-connection');

    const connection = createBrowserServerConnection({
      origin: 'http://192.168.31.75:14500/desktop/',
      identity: {
        connectionKind: 'lan',
        serverId: 'server_lan',
        serverNodeId: 'node_lan',
        userId: 'user_lan',
        studioId: 'studio_lan',
        label: 'LAN Server',
        trustState: 'lan',
        authState: 'paired',
        credentialKind: 'user_session',
        capabilities: ['chat'],
      },
      principal: {
        kind: 'account_user',
        credentialKind: 'user_session',
        connectionKind: 'lan',
        trustState: 'lan',
        scopes: [
          'chat',
          'resources.read',
          'files.read',
          'files.write',
          'studio.owner',
          'settings.read',
          'settings.write',
          'providers.manage',
          'secrets.write',
          'bridge.manage',
        ],
      },
    });

    expect(connection.capabilities).toEqual(expect.arrayContaining([
      'chat',
      'resources',
      'resources.read',
      'files',
      'files.read',
      'files.write',
      'studio.owner',
      'settings',
      'settings.read',
      'settings.write',
      'providers.manage',
      'secrets.write',
      'bridge.manage',
    ]));
  });

  it('normalizes the browser desktop PWA URL when creating a manual LAN connection', () => {
    const connection = createDeviceServerConnection({
      baseUrl: '192.168.31.75:14500/desktop/',
      credential: 'fixture-key',
      identity: {
        connectionKind: 'lan',
        serverId: 'server_lan',
        serverNodeId: 'node_lan',
        userId: 'user_lan',
        studioId: 'studio_lan',
        label: 'LAN Server',
        trustState: 'lan',
        authState: 'paired',
        credentialKind: 'device_credential',
        capabilities: ['chat', 'resources', 'files'],
      },
    });

    expect(connection).toMatchObject({
      baseUrl: 'http://192.168.31.75:14500',
      wsUrl: 'ws://192.168.31.75:14500',
    });
  });

  it('logs in once before creating a manual LAN connection so WebSocket can use the web session cookie', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'http://192.168.31.75:14500/api/web-auth/login') {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url === 'http://192.168.31.75:14500/api/server/identity') {
        return {
          ok: true,
          json: async () => ({
            connectionKind: 'lan',
            serverId: 'server_lan',
            serverNodeId: 'node_lan',
            userId: 'user_lan',
            studioId: 'studio_lan',
            label: 'LAN Server',
            trustState: 'lan',
            authState: 'paired',
            credentialKind: 'device_credential',
            capabilities: ['chat', 'resources', 'files', 'tools', 'settings'],
            executionBoundary: remoteExecutionBoundary,
          }),
        } as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const connection = await connectDeviceServerConnection({
      baseUrl: 'http://192.168.31.75:14500/',
      credential: 'fixture-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://192.168.31.75:14500/api/web-auth/login', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ credential: 'fixture-key' }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://192.168.31.75:14500/api/server/identity', expect.objectContaining({
      headers: { Authorization: 'Bearer fixture-key' },
      credentials: 'include',
    }));
    expect(connection.connectionId).toBe('lan:node_lan:studio_lan');
  });

  it('rejects manual Remote Server connect before persistence when the boundary contract fails', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'http://192.168.31.75:14500/api/web-auth/login') {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url === 'http://192.168.31.75:14500/api/server/identity') {
        return {
          ok: true,
          json: async () => ({
            connectionKind: 'lan',
            serverId: 'server_lan',
            serverNodeId: 'node_lan',
            userId: 'user_lan',
            studioId: 'studio_lan',
            label: 'LAN Server',
            trustState: 'lan',
            authState: 'paired',
            credentialKind: 'device_credential',
            capabilities: ['resources', 'files', 'tools', 'settings'],
            executionBoundary: remoteExecutionBoundary,
          }),
        } as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    });

    await expect(connectDeviceServerConnection({
      baseUrl: 'http://192.168.31.75:14500',
      credential: 'fixture-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({
      name: 'RemoteBoundaryContractError',
      compatibility: {
        ok: false,
        reasonCodes: ['missing_core_capability'],
      },
    });
  });

  it('uses main-process probeConnection when available and persists+reloads on success (CSP bootstrapping fix)', async () => {
    const storageData = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageData.get(key) ?? null,
      setItem: (key: string, value: string) => { storageData.set(key, value); },
      removeItem: (key: string) => { storageData.delete(key); },
    };
    const originalWindow = globalThis.window;
    const originalLocation = globalThis.location;
    const reloadSpy = vi.fn();
    const probeSpy = vi.fn().mockResolvedValue({
      ok: true,
      identity: {
        connectionKind: 'lan',
        serverId: 'server_lan',
        serverNodeId: 'node_lan',
        userId: 'user_lan',
        studioId: 'studio_lan',
        label: 'LAN Server',
        trustState: 'lan',
        capabilities: ['chat', 'resources', 'files', 'tools', 'settings'],
        executionBoundary: remoteExecutionBoundary,
      },
    });
    try {
      // persistServerConnectionSelection reads via getDefaultStorage() which
      // returns window.localStorage — so the mock must live on window.
      (globalThis as any).window = { hana: { probeConnection: probeSpy }, localStorage: storage };
      (globalThis as any).location = { reload: reloadSpy };

      const connection = await connectDeviceServerConnection({
        baseUrl: 'http://100.125.173.118:14500',
        credential: 'hana_dev_test_key',
      });

      expect(probeSpy).toHaveBeenCalledWith({
        baseUrl: 'http://100.125.173.118:14500',
        credential: 'hana_dev_test_key',
      });
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      expect(connection.connectionId).toBe('lan:node_lan:studio_lan');
      // Connection persisted as active so CSP picks up the origin on reload.
      const stored = JSON.parse(storage.getItem('hana-server-connections-v1') || '{}');
      expect(stored.activeServerConnectionId).toBe('lan:node_lan:studio_lan');
      expect(stored.serverConnections['lan:node_lan:studio_lan'].baseUrl).toBe('http://100.125.173.118:14500');
    } finally {
      (globalThis as any).window = originalWindow;
      (globalThis as any).location = originalLocation;
    }
  });

  it('throws when probe fails and does NOT persist or reload', async () => {
    const storageData = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageData.get(key) ?? null,
      setItem: (key: string, value: string) => { storageData.set(key, value); },
      removeItem: (key: string) => { storageData.delete(key); },
    };
    const originalWindow = globalThis.window;
    const originalLocation = globalThis.location;
    const reloadSpy = vi.fn();
    const probeSpy = vi.fn().mockResolvedValue({ ok: false, error: 'login HTTP 401' });
    try {
      (globalThis as any).window = { hana: { probeConnection: probeSpy }, localStorage: storage };
      (globalThis as any).location = { reload: reloadSpy };

      await expect(
        connectDeviceServerConnection({
          baseUrl: 'http://100.125.173.118:14500',
          credential: 'wrong-key',
        }),
      ).rejects.toThrow(/connect probe failed: login HTTP 401/);

      expect(reloadSpy).not.toHaveBeenCalled();
      expect(storage.getItem('hana-server-connections-v1')).toBeNull();
    } finally {
      (globalThis as any).window = originalWindow;
      (globalThis as any).location = originalLocation;
    }
  });

  it('persists only non-local ServerConnections and the active remote selection', () => {
    const storageData = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageData.get(key) ?? null,
      setItem: (key: string, value: string) => { storageData.set(key, value); },
      removeItem: (key: string) => { storageData.delete(key); },
    };
    const local = createLocalServerConnection({
      serverPort: 3210,
      serverToken: 'local-token',
    })!;
    const remote = createDeviceServerConnection({
      baseUrl: 'http://192.168.31.75:14500',
      credential: 'fixture-key',
      identity: {
        connectionKind: 'lan',
        serverId: 'server_lan',
        serverNodeId: 'node_lan',
        userId: 'user_lan',
        studioId: 'studio_lan',
        label: 'LAN Server',
        trustState: 'lan',
        authState: 'paired',
        credentialKind: 'device_credential',
        capabilities: ['chat'],
      },
    });

    writePersistedServerConnectionState({
      serverConnections: { local, [remote.connectionId]: remote },
      activeServerConnectionId: remote.connectionId,
    }, storage);

    const loaded = readPersistedServerConnectionState(storage);
    expect(Object.keys(loaded.serverConnections)).toEqual([remote.connectionId]);
    expect(loaded.activeServerConnectionId).toBe(remote.connectionId);

    const selected = persistServerConnectionSelection(remote, storage);
    expect(selected.activeServerConnectionId).toBe(remote.connectionId);
  });

  it('builds fetch URLs without leaking token into the query string', () => {
    const connection = createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'test-token-123',
    });
    expect(connection).not.toBeNull();

    expect(buildConnectionUrl(connection!, '/api/health')).toBe('http://127.0.0.1:3210/api/health');
  });

  it('injects Authorization while preserving caller headers', () => {
    const connection = createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'test-token-123',
    });
    expect(connection).not.toBeNull();

    expect(appendConnectionAuth(connection!, { 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token-123',
    });
  });

  it('builds WebSocket URLs with query token for browser WebSocket auth', () => {
    const connection = createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'test-token-123',
    });
    expect(connection).not.toBeNull();

    expect(buildConnectionWsUrl(connection!, '/ws')).toBe('ws://127.0.0.1:3210/ws?token=test-token-123');
  });

  it('appends query token to WebSocket URL for LAN device-credential connections (B1 fix)', () => {
    const local = createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'local-token',
    })!;
    const lan = {
      ...local,
      connectionId: 'lan:node_lan:studio_lan',
      kind: 'lan' as const,
      baseUrl: 'http://100.125.173.118:14500',
      wsUrl: 'ws://100.125.173.118:14500',
      token: 'hana_dev_test-key',
      credentialKind: 'device_credential' as const,
    };

    expect(buildConnectionWsUrl(lan, '/ws')).toBe('ws://100.125.173.118:14500/ws?token=hana_dev_test-key');
  });

  it('merges stable server identity without changing transport details', () => {
    const connection = createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'test-token-123',
    });
    expect(connection).not.toBeNull();

    expect(mergeServerIdentity(connection!, {
      connectionKind: 'local',
      serverId: 'server_stable',
      userId: 'user_stable',
      studioId: 'studio_stable',
      label: 'Stable Server',
      userLabel: 'Stable User',
      studioLabel: 'Stable Studio',
      authState: 'paired',
      trustState: 'local',
      capabilities: ['chat', 'resources', 'tools', 'identity'],
      version: '1.2.3',
    })).toEqual({
      connectionId: 'local',
      serverId: 'server_stable',
      userId: 'user_stable',
      studioId: 'studio_stable',
      label: 'Stable Server',
      userLabel: 'Stable User',
      studioLabel: 'Stable Studio',
      serverVersion: '1.2.3',
      kind: 'local',
      baseUrl: 'http://127.0.0.1:3210',
      wsUrl: 'ws://127.0.0.1:3210',
      token: 'test-token-123',
      authState: 'paired',
      trustState: 'local',
      credentialKind: 'loopback_token',
      platformAccountId: null,
      officialServiceKind: null,
      capabilities: ['chat', 'resources', 'tools', 'identity'],
    });
  });

  it('keeps ServerNode execution scope from identity metadata', () => {
    const connection = createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'test-token-123',
    });
    expect(connection).not.toBeNull();

    expect(mergeServerIdentity(connection!, {
      connectionKind: 'local',
      serverId: 'server_stable',
      serverNodeId: 'node_stable',
      serverNodeKind: 'local',
      serverNodeTransport: 'loopback',
      userId: 'user_stable',
      studioId: 'studio_stable',
      label: 'Stable Server',
      executionBoundary: {
        schemaVersion: 1,
        boundaryId: 'execb_node_stable_studio_stable',
        kind: 'local_process',
        serverNodeId: 'node_stable',
        studioId: 'studio_stable',
      },
    })).toMatchObject({
      serverId: 'server_stable',
      serverNodeId: 'node_stable',
      serverNodeKind: 'local',
      serverNodeTransport: 'loopback',
      executionBoundary: {
        boundaryId: 'execb_node_stable_studio_stable',
        serverNodeId: 'node_stable',
        studioId: 'studio_stable',
      },
    });
  });

  it('warnIfServerProtocolMismatch: stays silent when serverProtocol matches this build', () => {
    const log = vi.fn();
    warnIfServerProtocolMismatch({ serverId: 's', studioId: 'st', label: 'L', serverProtocol: SERVER_PROTOCOL_VERSION } as any, log);
    expect(log).not.toHaveBeenCalled();
  });

  it('warnIfServerProtocolMismatch: stays silent when the server predates this field entirely (read-time compat, not a mismatch)', () => {
    const log = vi.fn();
    warnIfServerProtocolMismatch({ serverId: 's', studioId: 'st', label: 'L' } as any, log);
    expect(log).not.toHaveBeenCalled();
  });

  it('warnIfServerProtocolMismatch: logs a diagnostic (does not throw) when serverProtocol disagrees with this build', () => {
    const log = vi.fn();
    warnIfServerProtocolMismatch({ serverId: 's', studioId: 'st', label: 'L', serverProtocol: SERVER_PROTOCOL_VERSION + 1 } as any, log);
    expect(log).toHaveBeenCalledTimes(1);
    const [message] = log.mock.calls[0];
    expect(message).toContain(String(SERVER_PROTOCOL_VERSION));
    expect(message).toContain(String(SERVER_PROTOCOL_VERSION + 1));
  });

  it('preserves remote identity metadata when merging a refreshed server identity', () => {
    const connection = createDeviceServerConnection({
      baseUrl: 'https://hana.example',
      credential: 'remote-token',
      identity: {
        connectionKind: 'custom_remote',
        serverId: 'server_remote',
        serverNodeId: 'node_remote',
        userId: 'user_remote',
        studioId: 'studio_remote',
        label: 'Remote Studio',
        trustState: 'tunnel',
        capabilities: ['chat'],
      },
    });

    const merged = mergeServerIdentity(connection, {
      connectionKind: 'custom_remote',
      serverId: 'server_remote',
      serverNodeId: 'node_remote_refresh',
      userId: 'user_remote',
      studioId: 'studio_remote',
      label: 'Remote Studio',
      trustState: 'tunnel',
      credentialKind: 'device_credential',
      capabilities: ['chat', 'resources', 'tools', 'identity'],
      executionBoundary: {
        schemaVersion: 1,
        boundaryId: 'execb_node_remote_refresh_studio_remote',
        kind: 'remote_process',
        serverNodeId: 'node_remote_refresh',
        studioId: 'studio_remote',
        workbench: {
          kind: 'server_managed',
          root: null,
        },
      },
    });

    expect(merged).toMatchObject({
      kind: 'custom_remote',
      trustState: 'tunnel',
      credentialKind: 'device_credential',
      serverNodeId: 'node_remote_refresh',
      capabilities: ['chat', 'resources', 'tools', 'identity'],
      executionBoundary: {
        boundaryId: 'execb_node_remote_refresh_studio_remote',
        kind: 'remote_process',
        serverNodeId: 'node_remote_refresh',
        studioId: 'studio_remote',
        workbench: {
          kind: 'server_managed',
        },
      },
    });
  });

  it('refreshes local transport without drifting stable server/user/space identity', () => {
    const connection = mergeServerIdentity(createLocalServerConnection({
      serverPort: '3210',
      serverToken: 'old-token',
    })!, {
      serverId: 'server_stable',
      userId: 'user_stable',
      studioId: 'studio_stable',
      label: 'Stable Server',
      userLabel: 'Stable User',
      studioLabel: 'Stable Studio',
      capabilities: ['chat', 'resources', 'tools', 'identity'],
    });

    expect(refreshLocalServerConnection({
      existingConnection: connection,
      serverPort: '4222',
      serverToken: 'new-token',
    })).toEqual({
      ...connection,
      connectionId: 'local',
      baseUrl: 'http://127.0.0.1:4222',
      wsUrl: 'ws://127.0.0.1:4222',
      token: 'new-token',
      authState: 'paired',
      trustState: 'local',
      credentialKind: 'loopback_token',
      platformAccountId: null,
      officialServiceKind: null,
    });
  });
});


describe('websocket auth migration characterization', () => {
  const localOwnerConnection = createLocalServerConnection({
    serverPort: '3210',
    serverToken: 'local-token',
  })!;

  const lanConnection = {
    ...localOwnerConnection,
    connectionId: 'lan:node_lan:studio_lan',
    kind: 'lan' as const,
    label: 'LAN Studio',
    baseUrl: 'http://192.168.31.75:14500',
    wsUrl: 'ws://192.168.31.75:14500',
    token: 'hana_dev_test-key',
    trustState: 'lan' as const,
    credentialKind: 'device_credential' as const,
  };

  const tunnelConnection = {
    ...localOwnerConnection,
    connectionId: 'custom:remote',
    kind: 'custom_remote' as const,
    label: 'Remote Studio',
    baseUrl: 'https://hana.example',
    wsUrl: 'wss://hana.example',
    token: 'remote-token',
    trustState: 'tunnel' as const,
    credentialKind: 'device_credential' as const,
  };

  it('does not request a ws ticket for loopback local-owner connections', async () => {
    const fetchImpl = vi.fn();
    await expect(requestConnectionWsTicket(localOwnerConnection, fetchImpl as unknown as typeof fetch))
      .resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(canUseQueryToken(localOwnerConnection)).toBe(true);
  });

  it('characterizes current fork LAN query-token selection while preserving ticket URL builder', async () => {
    // Current fork reality: LAN device credentials still use canUseQueryToken,
    // so requestConnectionWsTicket short-circuits and WS URLs embed the token.
    const fetchImpl = vi.fn();
    await expect(requestConnectionWsTicket(lanConnection, fetchImpl as unknown as typeof fetch))
      .resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(canUseQueryToken(lanConnection)).toBe(true);
    expect(buildConnectionWsUrl(lanConnection, '/ws')).toContain(lanConnection.token!);
    expect(buildConnectionWsUrl(lanConnection, '/ws')).toBe(
      'ws://192.168.31.75:14500/ws?token=hana_dev_test-key',
    );

    // Preferred post-migration shape (ticket in URL, credential absent) is
    // already supported by buildConnectionWsUrl when a ticket is supplied.
    const ticketed = buildConnectionWsUrl(lanConnection, '/ws', { wsTicket: 'ticket-1' });
    expect(ticketed).toBe('ws://192.168.31.75:14500/ws?wsTicket=ticket-1');
    expect(ticketed).not.toContain(lanConnection.token!);
  });

  it('requests a ws ticket for tunnel device credentials without putting the credential in the ws URL', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ticket: 'ticket-1', expiresAt: '2026-06-20T00:00:30.000Z' }),
    }));

    const ticket = await requestConnectionWsTicket(
      tunnelConnection,
      fetchImpl as unknown as typeof fetch,
    );
    expect(ticket).toBe('ticket-1');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hana.example/api/ws-ticket',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer remote-token',
        }),
      }),
    );
    expect(buildConnectionWsUrl(tunnelConnection, '/ws', { wsTicket: ticket }))
      .toBe('wss://hana.example/ws?wsTicket=ticket-1');
    expect(buildConnectionWsUrl(tunnelConnection, '/ws', { wsTicket: ticket }))
      .not.toContain(tunnelConnection.token!);
  });

  it('classifies servers with a read-only ws auth capability probe', async () => {
    await expect(probeWsAuthCapability('http://127.0.0.1:3210', 'local-token', vi.fn() as any))
      .resolves.toBe('loopback-owner');

    const ticketFetch = vi.fn(async () => ({ status: 200 })) as unknown as typeof fetch;
    await expect(probeWsAuthCapability('http://192.168.1.9:14500', 'device-key', ticketFetch))
      .resolves.toBe('ticket');

    const forbiddenTicketFetch = vi.fn(async () => ({ status: 403 })) as unknown as typeof fetch;
    await expect(probeWsAuthCapability('http://192.168.1.9:14500', 'device-key', forbiddenTicketFetch))
      .resolves.toBe('ticket');

    const legacyFetch = vi.fn(async () => ({ status: 404 })) as unknown as typeof fetch;
    await expect(probeWsAuthCapability('http://192.168.1.9:14500', 'device-key', legacyFetch))
      .resolves.toBe('legacy-query-token');

    const unsupportedFetch = vi.fn(async () => ({ status: 500 })) as unknown as typeof fetch;
    await expect(probeWsAuthCapability('http://192.168.1.9:14500', 'device-key', unsupportedFetch))
      .resolves.toBe('unsupported');
  });

  it('uses an inventory-driven probe for preferred LAN ticket path instead of it.skip', async () => {
    // Current fork: preferred LAN ticket path is not active (query-token remains).
    expect(preferredLanTicketPathActive(lanConnection)).toBe(false);

    // When the preferred path is inactive, characterize the current behavior
    // and only assert ticket-first LAN URL shape through the explicit ticket builder.
    if (!preferredLanTicketPathActive(lanConnection)) {
      expect(canUseQueryToken(lanConnection)).toBe(true);
      expect(buildConnectionWsUrl(lanConnection, '/ws')).toContain('token=');
      expect(buildConnectionWsUrl(lanConnection, '/ws', { wsTicket: 'ticket-1' }))
        .not.toContain(lanConnection.token!);
      return;
    }

    // Candidate/post-migration expectation path (inventory-driven; not it.skip).
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ticket: 'ticket-1' }),
    }));
    const ticket = await requestConnectionWsTicket(
      lanConnection,
      fetchImpl as unknown as typeof fetch,
    );
    expect(ticket).toBe('ticket-1');
    expect(buildConnectionWsUrl(lanConnection, '/ws', { wsTicket: ticket }))
      .not.toContain(lanConnection.token!);
  });
});
