import { useStore } from '../stores';
import {
  HanaHttpError,
  publishHanaHttpError,
} from '../services/hana-http-error';
import {
  appendConnectionAuth,
  buildConnectionUrl,
  requireServerConnection,
} from '../services/server-connection';

const DEFAULT_TIMEOUT = 30_000;
const MAX_HTTP_ERROR_DETAIL_LENGTH = 1000;
const pendingHanaFetchControllers = new Set<AbortController>();

export function abortPendingHanaFetches(): void {
  for (const controller of [...pendingHanaFetchControllers]) {
    controller.abort();
  }
}

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
  const abortFromCaller = () => controller.abort();
  pendingHanaFetchControllers.add(controller);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }

  try {
    const res = await fetch(buildConnectionUrl(connection, path), {
      ...fetchOpts,
      headers,
      signal: controller.signal,
    });
    if (throwOnHttpError && !res.ok) {
      const { detail, reason } = await readHttpErrorBody(res);
      const error = new HanaHttpError({
        status: res.status,
        statusText: res.statusText,
        path,
        detail: detail || null,
        reason,
      });
      publishHanaHttpError(error);
      throw error;
    }
    return res;
  } finally {
    clearTimeout(timer);
    pendingHanaFetchControllers.delete(controller);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

async function readHttpErrorBody(res: Response): Promise<{
  detail: string;
  reason: string | null;
}> {
  const cloned = typeof res.clone === 'function' ? res.clone() : res;
  try {
    const text = (await cloned.text()).trim();
    if (!text) return { detail: '', reason: null };
    try {
      const body = JSON.parse(text);
      const detail = typeof body?.error === 'string' && body.error.trim()
        ? body.error.trim()
        : typeof body?.message === 'string' && body.message.trim()
          ? body.message.trim()
          : '';
      const reason = typeof body?.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, MAX_HTTP_ERROR_DETAIL_LENGTH)
        : null;
      return {
        detail: (detail || text).slice(0, MAX_HTTP_ERROR_DETAIL_LENGTH),
        reason,
      };
    } catch {}
    return {
      detail: text.slice(0, MAX_HTTP_ERROR_DETAIL_LENGTH),
      reason: null,
    };
  } catch {
    return { detail: '', reason: null };
  }
}
