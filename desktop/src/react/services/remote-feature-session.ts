export type RemoteFeatureSessionState =
  | { status: 'untried'; retryAt: null; reasonCode: null }
  | { status: 'supported'; retryAt: null; reasonCode: 'feature_probe_succeeded' }
  | { status: 'unsupported'; retryAt: null; reasonCode: 'feature_route_not_found' | 'feature_method_not_allowed' }
  | { status: 'backoff'; retryAt: number; reasonCode: 'feature_probe_transient_failure' | 'feature_probe_auth_failure' };

const UNTRIED: RemoteFeatureSessionState = Object.freeze({ status: 'untried', retryAt: null, reasonCode: null });

export function createRemoteFeatureSessionRegistry({
  now = Date.now,
  retryDelayMs = 60_000,
}: {
  now?: () => number;
  retryDelayMs?: number;
} = {}) {
  const connections = new Map<string, Map<string, RemoteFeatureSessionState>>();
  const read = (connectionId: string, featureId: string): RemoteFeatureSessionState =>
    connections.get(connectionId)?.get(featureId) ?? UNTRIED;
  const write = (connectionId: string, featureId: string, state: RemoteFeatureSessionState) => {
    let features = connections.get(connectionId);
    if (!features) {
      features = new Map();
      connections.set(connectionId, features);
    }
    features.set(featureId, Object.freeze(state));
  };
  const backoff = (
    connectionId: string,
    featureId: string,
    reasonCode: 'feature_probe_transient_failure' | 'feature_probe_auth_failure',
  ) => write(connectionId, featureId, { status: 'backoff', retryAt: now() + retryDelayMs, reasonCode });

  return {
    read,
    canProbe(connectionId: string, featureId: string) {
      const state = read(connectionId, featureId);
      return state.status === 'untried' || (state.status === 'backoff' && now() >= state.retryAt);
    },
    recordSupported(connectionId: string, featureId: string) {
      write(connectionId, featureId, { status: 'supported', retryAt: null, reasonCode: 'feature_probe_succeeded' });
    },
    recordHttpFailure(connectionId: string, featureId: string, status: number) {
      if (status === 404 || status === 405) {
        write(connectionId, featureId, {
          status: 'unsupported',
          retryAt: null,
          reasonCode: status === 404 ? 'feature_route_not_found' : 'feature_method_not_allowed',
        });
      } else {
        backoff(connectionId, featureId, status === 401 || status === 403
          ? 'feature_probe_auth_failure'
          : 'feature_probe_transient_failure');
      }
    },
    recordTransientFailure(connectionId: string, featureId: string) {
      backoff(connectionId, featureId, 'feature_probe_transient_failure');
    },
    clearConnection(connectionId: string) {
      connections.delete(connectionId);
    },
  };
}
