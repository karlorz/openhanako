/**
 * Structured HTTP failure for remote control-plane paths.
 * Callers (startup recovery, connection bootstrap) classify auth vs identity
 * via `status`, not by parsing `Error.message`.
 */
export class HanaHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly path: string | null;
  readonly detail: string | null;

  constructor({
    status,
    statusText = '',
    path = null,
    detail = null,
    message,
  }: {
    status: number;
    statusText?: string;
    path?: string | null;
    detail?: string | null;
    message?: string;
  }) {
    const normalizedStatusText = typeof statusText === 'string' ? statusText : '';
    const normalizedPath = typeof path === 'string' && path.trim() ? path.trim() : null;
    const normalizedDetail = typeof detail === 'string' && detail.trim() ? detail.trim() : null;
    super(
      message
        || (normalizedPath
          ? `hanaFetch ${normalizedPath}: ${status} ${normalizedStatusText}${normalizedDetail ? ` - ${normalizedDetail}` : ''}`
          : `server connection request failed: ${status} ${normalizedStatusText}`),
    );
    this.name = 'HanaHttpError';
    this.status = status;
    this.statusText = normalizedStatusText;
    this.path = normalizedPath;
    this.detail = normalizedDetail;
  }
}

export function isHanaHttpError(err: unknown): err is HanaHttpError {
  return err instanceof HanaHttpError;
}

/** True when the failure is an HTTP auth rejection (401/403). */
export function isHttpAuthFailure(err: unknown): boolean {
  if (isHanaHttpError(err)) {
    return err.status === 401 || err.status === 403;
  }
  return false;
}
