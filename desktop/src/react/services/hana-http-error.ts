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
  readonly reason: string | null;

  constructor({
    status,
    statusText = '',
    path = null,
    detail = null,
    reason = null,
    message,
  }: {
    status: number;
    statusText?: string;
    path?: string | null;
    detail?: string | null;
    reason?: string | null;
    message?: string;
  }) {
    const normalizedStatusText = typeof statusText === 'string' ? statusText : '';
    const normalizedPath = typeof path === 'string' && path.trim() ? path.trim() : null;
    const normalizedDetail = typeof detail === 'string' && detail.trim() ? detail.trim() : null;
    const normalizedReason = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
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
    this.reason = normalizedReason;
  }
}

export type HanaHttpErrorListener = (error: HanaHttpError) => void;

const hanaHttpErrorListeners = new Set<HanaHttpErrorListener>();

export function subscribeHanaHttpErrors(listener: HanaHttpErrorListener): () => void {
  hanaHttpErrorListeners.add(listener);
  return () => {
    hanaHttpErrorListeners.delete(listener);
  };
}

export function publishHanaHttpError(error: HanaHttpError): void {
  for (const listener of [...hanaHttpErrorListeners]) {
    try {
      listener(error);
    } catch {
      // A diagnostic observer must never replace the originating HTTP error.
    }
  }
}

export function isHanaHttpError(err: unknown): err is HanaHttpError {
  return err instanceof HanaHttpError;
}

/** True when the failure is an HTTP auth rejection (401/403). */
export function isHttpAuthFailure(err: unknown): err is HanaHttpError {
  if (isHanaHttpError(err)) {
    return err.status === 401 || err.status === 403;
  }
  return false;
}
