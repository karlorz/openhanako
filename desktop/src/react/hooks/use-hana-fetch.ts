import { useStore } from '../stores';
import {
  appendConnectionAuth,
  buildConnectionUrl,
  requireServerConnection,
} from '../services/server-connection';

const DEFAULT_TIMEOUT = 30_000;
const MAX_HTTP_ERROR_DETAIL_LENGTH = 1000;

/**
 * 构建带认证的 HanaAgent Server URL
 */
export function hanaUrl(path: string): string {
  const connection = requireServerConnection(
    useStore.getState(),
    `hanaUrl ${path}: server connection not ready`,
  );
  return buildConnectionUrl(connection, path, { includeTokenQuery: true });
}

/**
 * 带认证的 fetch 封装
 * - 默认 30s 超时
 * - 自动校验 res.ok，非 2xx 抛错
 */
export async function hanaFetch(
  path: string,
  opts: RequestInit & { timeout?: number; throwOnHttpError?: boolean } = {},
): Promise<Response> {
  const connection = requireServerConnection(
    useStore.getState(),
    `hanaFetch ${path}: server connection not ready`,
  );
  const headers = appendConnectionAuth(connection, opts.headers);

  const {
    timeout = DEFAULT_TIMEOUT,
    signal: callerSignal,
    throwOnHttpError = true,
    ...fetchOpts
  } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(buildConnectionUrl(connection, path), {
      ...fetchOpts,
      headers,
      signal: controller.signal,
    });
    if (throwOnHttpError && !res.ok) {
      const detail = await readHttpErrorDetail(res);
      throw new Error(`hanaFetch ${path}: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ''}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function readHttpErrorDetail(res: Response): Promise<string> {
  const cloned = typeof res.clone === 'function' ? res.clone() : res;
  try {
    const body = await cloned.json();
    const detail = typeof body?.error === 'string' && body.error.trim()
      ? body.error.trim()
      : typeof body?.message === 'string' && body.message.trim()
        ? body.message.trim()
        : '';
    if (detail) return detail.slice(0, MAX_HTTP_ERROR_DETAIL_LENGTH);
  } catch {}

  try {
    const text = (await cloned.text()).trim();
    return text.slice(0, MAX_HTTP_ERROR_DETAIL_LENGTH);
  } catch {
    return '';
  }
}
