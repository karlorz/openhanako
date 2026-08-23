/**
 * Shared foreground session convergence for Desktop and Mobile.
 *
 * When the renderer becomes visible (focus / visibility / online), refresh the
 * session list projection then revision-reconcile the open session. Concurrent
 * signals collapse into one in-flight run and are throttled.
 *
 * Resource event catch-up remains in `bindResourceEventForegroundCatchUp`
 * (wired from websocket setup). Context usage refresh runs on WS open.
 */

export interface SessionForegroundConvergenceOptions {
  /** Refresh session list projections (Desktop loadSessions / Mobile loadMobileSessions). */
  /**
   * Return false to stop the run before reconcile (for example when an auth
   * validity gate moved the renderer out of its authenticated shell).
   */
  refreshSessions: () => Promise<boolean | void> | boolean | void;
  /**
   * After the list is fresh, reconcile the open session by revision.
   * Defaults to a no-op when omitted (tests may inject).
   */
  reconcile?: (reason: string) => Promise<unknown> | unknown;
  reason?: string;
  minIntervalMs?: number;
  now?: () => number;
  windowObj?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  documentObj?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | null;
}

export function bindSessionForegroundConvergence(
  options: SessionForegroundConvergenceOptions,
): () => void {
  const windowObj = options.windowObj ?? (typeof window !== 'undefined' ? window : null);
  const documentObj = options.documentObj ?? (typeof document !== 'undefined' ? document : null);
  if (!windowObj || !documentObj) return () => {};

  const minIntervalMs = Math.max(0, Math.floor(Number(options.minIntervalMs ?? 1000) || 0));
  const now = options.now ?? (() => Date.now());
  const reason = options.reason || 'foreground_refresh';
  const reconcile = options.reconcile;
  let inFlight = false;
  let lastStartedAt = 0;

  const run = () => {
    if (documentObj.visibilityState === 'hidden') return;
    const startedAt = now();
    if (inFlight || (lastStartedAt && startedAt - lastStartedAt < minIntervalMs)) return;
    inFlight = true;
    lastStartedAt = startedAt;
    Promise.resolve(options.refreshSessions())
      .then((shouldContinue) => {
        if (shouldContinue === false) return undefined;
        if (!reconcile) return undefined;
        return reconcile(reason);
      })
      .catch((err) => {
        console.warn(`[session] foreground convergence failed (${reason}):`, err);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const onVisibilityChange = () => {
    if (documentObj.visibilityState === 'visible') run();
  };

  windowObj.addEventListener('focus', run);
  windowObj.addEventListener('online', run);
  documentObj.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    windowObj.removeEventListener('focus', run);
    windowObj.removeEventListener('online', run);
    documentObj.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
