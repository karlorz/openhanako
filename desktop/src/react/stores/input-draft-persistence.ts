/**
 * 输入框草稿持久化（前端侧）
 *
 * 内存 zustand 是运行时唯一权威，server 是落盘影子：
 * - hydrateInputDrafts()：启动/恢复归档后拉全量，只填内存中不存在的键
 * - initInputDraftPersistence()：注册 input-draft-sync 监听，把 setDraft/clearDraft
 *   变更按 key 独立 debounce 后 PUT 到 /api/input-drafts
 * - session 身份始终使用 sessionId；兼容入口收到 sessionPath 时由 server 边界解析
 * - 服务端是持久真相，hydrate 不覆盖 renderer 内已经更新过的草稿
 */
import type { JSONContent } from '@tiptap/core';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { hasServerConnection, isLocalOwnerConnection } from '../services/server-connection';
import { resolveRemoteFeatureDecision, type RemoteFeatureDecision } from '../services/remote-feature-gates';
import { createRemoteFeatureSessionRegistry } from '../services/remote-feature-session';
import { useStore } from './index';
import { resolveWorkspaceUiSurface } from './workspace-ui-state-actions';
import { registerDraftSyncListener } from './input-draft-sync';
import { HOME_DRAFT_KEY } from '../../../../shared/input-drafts.ts';

const PUSH_DEBOUNCE_MS = 500;
const featureSessions = createRemoteFeatureSessionRegistry();
const pushTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; connectionId: string }>();
let connectionSubscriptionInitialized = false;

type InputDraftRemoteMode = RemoteFeatureDecision & { connectionId: string | null };

export function inputDraftRemoteMode(state: ReturnType<typeof useStore.getState>): InputDraftRemoteMode {
  const connection = state.activeServerConnection;
  if (!connection || !hasServerConnection(state)) {
    return { featureId: 'input-drafts', mode: 'not-assessed', fallback: null, reasonCode: 'feature_not_assessed', connectionId: null };
  }
  if (isLocalOwnerConnection(connection)) {
    return { featureId: 'input-drafts', mode: 'remote', fallback: null, reasonCode: null, connectionId: connection.connectionId };
  }
  const decision = resolveRemoteFeatureDecision(state.remoteServerAssessment, 'input-drafts');
  const session = featureSessions.read(connection.connectionId, 'input-drafts');
  if (session.status === 'unsupported') {
    return { featureId: 'input-drafts', mode: 'fallback', fallback: 'memory-only', reasonCode: session.reasonCode, connectionId: connection.connectionId };
  }
  if (session.status === 'backoff' && !featureSessions.canProbe(connection.connectionId, 'input-drafts')) {
    return { featureId: 'input-drafts', mode: 'fallback', fallback: 'memory-only', reasonCode: session.reasonCode, connectionId: connection.connectionId };
  }
  if (decision.mode !== 'probe-once') return { ...decision, connectionId: connection.connectionId };
  if (session.status === 'supported') {
    return { featureId: 'input-drafts', mode: 'remote', fallback: null, reasonCode: null, connectionId: connection.connectionId };
  }
  if (!featureSessions.canProbe(connection.connectionId, 'input-drafts')) {
    return { featureId: 'input-drafts', mode: 'fallback', fallback: 'memory-only', reasonCode: session.reasonCode || decision.reasonCode, connectionId: connection.connectionId };
  }
  return { ...decision, connectionId: connection.connectionId };
}

export function clearInputDraftRemoteSession(connectionId: string): void {
  featureSessions.clearConnection(connectionId);
  for (const [key, pending] of pushTimers) {
    if (pending.connectionId !== connectionId) continue;
    clearTimeout(pending.timer);
    pushTimers.delete(key);
  }
}

function classifyInputDraftResponse(response: Response): 'supported' | 'unsupported' | 'auth' | 'transient' {
  if (response.ok || (response.status >= 200 && response.status < 300)) return 'supported';
  if (response.status === 404 || response.status === 405) return 'unsupported';
  if (response.status === 401 || response.status === 403) return 'auth';
  return 'transient';
}

function recordRemoteResponse(connectionId: string, response: Response): boolean {
  const classification = classifyInputDraftResponse(response);
  if (classification === 'supported') {
    featureSessions.recordSupported(connectionId, 'input-drafts');
    return true;
  }
  if (classification === 'unsupported' || classification === 'auth') {
    featureSessions.recordHttpFailure(connectionId, 'input-drafts', response.status);
  } else {
    featureSessions.recordTransientFailure(connectionId, 'input-drafts');
  }
  return false;
}

function isInputDraftHydratePayload(data: unknown): data is { home?: unknown; sessions: Record<string, unknown> } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const sessions = (data as { sessions?: unknown }).sessions;
  return !!sessions && typeof sessions === 'object' && !Array.isArray(sessions);
}

/** 内存 map 的键要么是 sessionId，要么是老数据兜底的 sessionPath（含路径分隔符），要么是 __home__ */
function isPathLikeKey(key: string): boolean {
  return key.includes('/') || key.includes('\\');
}

async function pushDraft(connectionId: string, key: string, text: string, doc: JSONContent | null): Promise<void> {
  const body: Record<string, unknown> = {
    surface: resolveWorkspaceUiSurface(),
    text,
    ...(doc ? { doc } : {}),
  };
  if (key === HOME_DRAFT_KEY) body.scope = 'home';
  else if (isPathLikeKey(key)) body.sessionPath = key;
  else body.sessionId = key;
  try {
    const response = await hanaFetch('/api/input-drafts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(connectionId !== 'local' ? { throwOnHttpError: false } : {}),
    });
    if (connectionId !== 'local') recordRemoteResponse(connectionId, response);
  } catch (err) {
    if (connectionId !== 'local') featureSessions.recordTransientFailure(connectionId, 'input-drafts');
    // 尽力而为的影子：失败不打断输入，下一次变更自然重试
    console.warn('[input-drafts] draft push failed:', err);
  }
}

function schedulePush(key: string, text: string, doc: JSONContent | null): void {
  const mode = inputDraftRemoteMode(useStore.getState());
  if (mode.mode !== 'remote' || !mode.connectionId) return;
  const connectionId = mode.connectionId;
  const existing = pushTimers.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pushTimers.delete(key);
    const current = inputDraftRemoteMode(useStore.getState());
    if (current.mode !== 'remote' || current.connectionId !== connectionId) return;
    void pushDraft(connectionId, key, text, doc);
  }, PUSH_DEBOUNCE_MS);
  pushTimers.set(key, { timer, connectionId });
}

/** 拉全量草稿填充内存；内存已有的键以内存为准（用户可能已开始打字） */
export async function hydrateInputDrafts(): Promise<void> {
  const mode = inputDraftRemoteMode(useStore.getState());
  if ((mode.mode !== 'remote' && mode.mode !== 'probe-once') || !mode.connectionId) return;
  let data: any = null;
  try {
    const res = await hanaFetch(`/api/input-drafts?surface=${resolveWorkspaceUiSurface()}`, {
      ...(mode.connectionId !== 'local' ? { throwOnHttpError: false } : {}),
    });
    if (mode.connectionId !== 'local' && classifyInputDraftResponse(res) !== 'supported') {
      recordRemoteResponse(mode.connectionId, res);
      return;
    }
    data = await res.json().catch(() => null);
  } catch (err) {
    if (mode.connectionId !== 'local') featureSessions.recordTransientFailure(mode.connectionId, 'input-drafts');
    console.warn('[input-drafts] hydrate failed:', err);
    return;
  }
  if (!isInputDraftHydratePayload(data)) {
    if (mode.connectionId !== 'local') featureSessions.recordTransientFailure(mode.connectionId, 'input-drafts');
    return;
  }
  if (mode.connectionId !== 'local') featureSessions.recordSupported(mode.connectionId, 'input-drafts');
  const current = useStore.getState();
  const drafts = { ...current.drafts };
  const draftDocs = { ...current.draftDocs };
  const applyEntry = (key: string, entry: any) => {
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return;
    if (Object.prototype.hasOwnProperty.call(drafts, key)) return;
    drafts[key] = entry.text;
    if (entry.doc && typeof entry.doc === 'object' && !Array.isArray(entry.doc)) {
      draftDocs[key] = entry.doc;
    }
  };
  if (data.home) applyEntry(HOME_DRAFT_KEY, data.home);
  for (const [sessionId, entry] of Object.entries(data.sessions || {})) {
    applyEntry(sessionId, entry);
  }
  useStore.setState({ drafts, draftDocs, draftsHydratedAt: Date.now() });
}

/** 注册草稿变更监听；在 app-init 早期调用一次 */
export function initInputDraftPersistence(): void {
  registerDraftSyncListener({
    onSet: (key, text, doc) => schedulePush(key, text, doc),
    onClear: (key) => schedulePush(key, '', null),
  });
  if (!connectionSubscriptionInitialized) {
    connectionSubscriptionInitialized = true;
    useStore.subscribe((state, previous) => {
      const previousId = previous.activeServerConnectionId;
      if (previousId && previousId !== state.activeServerConnectionId) {
        clearInputDraftRemoteSession(previousId);
      }
    });
  }
}
