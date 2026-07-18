import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import {
  clearInputDraftRemoteSession,
  hydrateInputDrafts,
  inputDraftRemoteMode,
  initInputDraftPersistence,
} from '../../stores/input-draft-persistence';
import { registerDraftSyncListener } from '../../stores/input-draft-sync';
import type { ServerConnection } from '../../services/server-connection';
import { assessRemoteServer, REMOTE_INPUT_DRAFT_FEATURE_REQUIREMENTS } from '../../../../../shared/remote-server-assessment';
import type { RemoteServerAssessment } from '../../../../../shared/remote-server-assessment';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));
const mockFetch = vi.mocked(hanaFetch);
const remoteConnection: ServerConnection = {
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
const localConnection: ServerConnection = {
  ...remoteConnection,
  connectionId: 'local',
  kind: 'local' as const,
  baseUrl: 'http://127.0.0.1:14500',
  wsUrl: 'ws://127.0.0.1:14500',
  trustState: 'local' as const,
  credentialKind: 'loopback_token' as const,
};

function remoteAssessment(featureContracts: null | { schemaVersion: 1; complete: true; entries: Record<string, number> }) {
  return assessRemoteServer({
    connectionId: remoteConnection.connectionId,
    boundary: { status: 'assessed', ok: true, reasonCodes: [], warningCodes: [] },
    server: { connectionKind: 'lan', featureContracts },
    featureRequirements: REMOTE_INPUT_DRAFT_FEATURE_REQUIREMENTS,
  });
}

function useConnection(
  connection: ServerConnection = localConnection,
  assessment: RemoteServerAssessment | null = null,
) {
  useStore.setState({
    activeServerConnectionId: connection.connectionId,
    activeServerConnection: connection,
    remoteServerAssessment: assessment,
  });
}

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => data } as unknown as Response;
}

describe('input draft persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    // 重置 store drafts（沿用本目录测试重置惯例）
    useStore.setState({ drafts: {}, draftDocs: {}, draftsHydratedAt: 0 });
    useConnection();
    clearInputDraftRemoteSession(remoteConnection.connectionId);
  });
  afterEach(() => {
    vi.useRealTimers();
    registerDraftSyncListener(null);
  });

  it('hydrates server drafts into memory without overwriting existing keys', async () => {
    useStore.setState({ drafts: { 'sess-typed': 'user already typing' } });
    mockFetch.mockResolvedValueOnce(jsonResponse({
      home: { text: 'home draft', doc: { type: 'doc' }, updatedAt: 1 },
      sessions: {
        'sess-typed': { text: 'stale server copy', updatedAt: 1 },
        'sess-cold': { text: 'cold draft', updatedAt: 1 },
      },
    }));

    await hydrateInputDrafts();

    const s = useStore.getState();
    expect(s.drafts['__home__']).toBe('home draft');
    expect(s.draftDocs['__home__']).toEqual({ type: 'doc' });
    expect(s.drafts['sess-typed']).toBe('user already typing'); // 内存优先
    expect(s.drafts['sess-cold']).toBe('cold draft');
    expect(s.draftsHydratedAt).toBeGreaterThan(0);
  });

  it('debounces pushes and sends home scope / sessionId / sessionPath correctly', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));
    initInputDraftPersistence();
    const { notifyDraftSet, notifyDraftCleared } = await import('../../stores/input-draft-sync');

    notifyDraftSet('__home__', 'h1', null);
    notifyDraftSet('__home__', 'h2', null); // 同 key 重置 debounce，只发一次
    notifyDraftSet('sess-1', 'session text', { type: 'doc' } as any);
    notifyDraftSet('/agents/a/sessions/legacy.jsonl', 'legacy', null);

    await vi.advanceTimersByTimeAsync(600);

    const bodies = mockFetch.mock.calls
      .filter(([url]) => url === '/api/input-drafts')
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies).toHaveLength(3);
    expect(bodies.find(b => b.scope === 'home')).toMatchObject({ text: 'h2' });
    expect(bodies.find(b => b.sessionId === 'sess-1')).toMatchObject({ text: 'session text', doc: { type: 'doc' } });
    expect(bodies.find(b => b.sessionPath === '/agents/a/sessions/legacy.jsonl')).toMatchObject({ text: 'legacy' });

    mockFetch.mockClear();
    notifyDraftCleared('sess-1');
    await vi.advanceTimersByTimeAsync(600);
    const clearBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(clearBody).toMatchObject({ sessionId: 'sess-1', text: '' });
  });

  it('uses declared support for remote hydrate and push', async () => {
    useConnection(remoteConnection, remoteAssessment({
      schemaVersion: 1,
      complete: true,
      entries: { 'chat.core': 1, 'input.drafts': 1 },
    }));
    mockFetch.mockResolvedValue(jsonResponse({ sessions: {} }));

    expect(inputDraftRemoteMode(useStore.getState()).mode).toBe('remote');
    await hydrateInputDrafts();
    initInputDraftPersistence();
    const { notifyDraftSet } = await import('../../stores/input-draft-sync');
    notifyDraftSet('sess-1', 'remote text', null);
    await vi.advanceTimersByTimeAsync(600);

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining('/api/input-drafts?surface='),
      '/api/input-drafts',
    ]);
  });

  it('uses memory-only without GET or PUT when the complete declaration lacks input drafts', async () => {
    useConnection(remoteConnection, remoteAssessment({
      schemaVersion: 1,
      complete: true,
      entries: { 'chat.core': 1 },
    }));
    expect(inputDraftRemoteMode(useStore.getState())).toMatchObject({ mode: 'fallback', fallback: 'memory-only' });

    await hydrateInputDrafts();
    initInputDraftPersistence();
    const { notifyDraftSet } = await import('../../stores/input-draft-sync');
    notifyDraftSet('sess-1', 'memory text', null);
    await vi.advanceTimersByTimeAsync(600);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('probes a legacy server once and enables PUT only after a successful GET', async () => {
    useConnection(remoteConnection, remoteAssessment(null));
    mockFetch.mockResolvedValue(jsonResponse({ sessions: {} }));

    expect(inputDraftRemoteMode(useStore.getState()).mode).toBe('probe-once');
    await hydrateInputDrafts();
    expect(inputDraftRemoteMode(useStore.getState()).mode).toBe('remote');
    initInputDraftPersistence();
    const { notifyDraftSet } = await import('../../stores/input-draft-sync');
    notifyDraftSet('sess-1', 'after probe', null);
    await vi.advanceTimersByTimeAsync(600);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each([404, 405])('treats HTTP %s as unsupported and suppresses later calls', async (status) => {
    useConnection(remoteConnection, remoteAssessment(null));
    mockFetch.mockResolvedValueOnce({ ok: false, status, json: async () => ({}) } as Response);
    await hydrateInputDrafts();
    expect(inputDraftRemoteMode(useStore.getState()).mode).toBe('fallback');
    await hydrateInputDrafts();

    initInputDraftPersistence();
    const { notifyDraftSet } = await import('../../stores/input-draft-sync');
    notifyDraftSet('sess-1', 'memory only', null);
    await vi.advanceTimersByTimeAsync(600);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 500])('backs off HTTP %s without claiming unsupported', async (status) => {
    useConnection(remoteConnection, remoteAssessment(null));
    mockFetch.mockResolvedValueOnce({ ok: false, status, json: async () => ({}) } as Response);
    await hydrateInputDrafts();
    expect(inputDraftRemoteMode(useStore.getState()).mode).toBe('fallback');
    await hydrateInputDrafts();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('backs off network failures and reconnect clearing permits a new probe', async () => {
    useConnection(remoteConnection, remoteAssessment(null));
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    await hydrateInputDrafts();
    await hydrateInputDrafts();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    clearInputDraftRemoteSession(remoteConnection.connectionId);
    mockFetch.mockResolvedValueOnce(jsonResponse({ sessions: {} }));
    await hydrateInputDrafts();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(inputDraftRemoteMode(useStore.getState()).mode).toBe('remote');
  });
});
