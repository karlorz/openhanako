import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock useStore before importing hanaFetch
vi.mock('../../stores', () => ({
  useStore: {
    getState: () => ({
      serverPort: '3210',
      serverToken: 'test-token-123',
      activeServerConnection: {
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
        capabilities: ['chat', 'resources', 'tools'],
      },
    }),
  },
}));

import {
  abortPendingHanaFetches,
  hanaUrl,
  hanaFetch,
} from '../../hooks/use-hana-fetch';
import {
  HanaHttpError,
  subscribeHanaHttpErrors,
} from '../../services/hana-http-error';

describe('hanaUrl', () => {
  it('构建带 token 的 URL', () => {
    const url = hanaUrl('/api/health');
    expect(url).toBe('http://127.0.0.1:3210/api/health?token=test-token-123');
  });

  it('路径已有 query param 时用 & 连接', () => {
    const url = hanaUrl('/api/sessions?limit=10');
    expect(url).toBe('http://127.0.0.1:3210/api/sessions?limit=10&token=test-token-123');
  });
});

describe('hanaFetch', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('发送带 Authorization header 的请求', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok' }),
    });

    await hanaFetch('/api/health');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3210/api/health');
    expect(opts.headers.Authorization).toBe('Bearer test-token-123');
  });

  it('can abort all pending authenticated requests at an auth-lifecycle boundary', async () => {
    mockFetch.mockImplementationOnce((_url: string, options: RequestInit) => (
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      })
    ));

    const request = hanaFetch('/api/sessions');
    abortPendingHanaFetches();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockFetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it('非 2xx 状态码抛出错误', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(hanaFetch('/api/missing')).rejects.toThrow('404');
  });

  it('非 2xx 状态码错误包含 JSON 响应体里的 error 字段', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: 'provider rejected image_url' }),
    });

    await expect(hanaFetch('/api/sessions/latest-user-message/replay'))
      .rejects.toThrow('provider rejected image_url');
  });

  it('保留 JSON reason 并向监听器发布同一个结构化错误', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'credential is no longer valid',
      reason: 'invalid_credential',
    }), {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'Content-Type': 'application/json' },
    }));
    const observed: HanaHttpError[] = [];
    const unsubscribe = subscribeHanaHttpErrors(error => observed.push(error));

    let thrown: unknown;
    try {
      await hanaFetch('/api/sessions');
    } catch (error) {
      thrown = error;
    } finally {
      unsubscribe();
    }

    expect(thrown).toBeInstanceOf(HanaHttpError);
    expect(thrown).toMatchObject({
      status: 403,
      reason: 'invalid_credential',
      detail: 'credential is no longer valid',
    });
    expect(observed).toEqual([thrown]);
  });

  it('preserves unrelated structured reasons for callers without treating them as display text', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      message: 'You do not have this scope',
      reason: 'insufficient_scope',
    }), {
      status: 403,
      statusText: 'Forbidden',
    }));

    await expect(hanaFetch('/api/admin'))
      .rejects.toMatchObject({
        reason: 'insufficient_scope',
        detail: 'You do not have this scope',
      });
  });

  it('keeps the prior raw JSON display detail when a body has reason but no error/message', async () => {
    const body = JSON.stringify({ reason: 'missing_credential' });
    mockFetch.mockResolvedValueOnce(new Response(body, {
      status: 403,
      statusText: 'Forbidden',
    }));

    await expect(hanaFetch('/api/sessions'))
      .rejects.toMatchObject({
        reason: 'missing_credential',
        detail: body,
      });
  });

  it('非 2xx 状态码错误包含纯文本响应体', async () => {
    mockFetch.mockResolvedValueOnce(new Response('provider rejected image_url', {
      status: 400,
      statusText: 'Bad Request',
    }));

    await expect(hanaFetch('/api/sessions/latest-user-message/replay'))
      .rejects.toThrow('provider rejected image_url');
  });

  it('允许调用方显式读取非 2xx 响应体', async () => {
    const response = {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: '日记材料准备失败: simulated summary failure' }),
    };
    mockFetch.mockResolvedValueOnce(response);

    const res = await hanaFetch('/api/diary/write', { throwOnHttpError: false });

    expect(res).toBe(response);
    expect(mockFetch.mock.calls[0][1]).not.toHaveProperty('throwOnHttpError');
  });

  it('传递自定义 method 和 headers', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await hanaFetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const call = mockFetch.mock.calls[0];
    const url = call[0];
    const opts = call[1];
    expect(url).toBe('http://127.0.0.1:3210/api/test');
    // headers 被合并，Authorization 被注入
    expect(opts.headers).toHaveProperty('Authorization', 'Bearer test-token-123');
  });

  it('传递 AbortSignal 用于超时', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await hanaFetch('/api/test');

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});
