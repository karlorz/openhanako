import { describe, expect, it } from 'vitest';
import { createRemoteFeatureSessionRegistry } from '../../services/remote-feature-session';

describe('remote feature session registry', () => {
  it('tracks supported and definitive unsupported probes per connection', () => {
    const registry = createRemoteFeatureSessionRegistry();
    expect(registry.read('a', 'input-drafts')).toEqual({ status: 'untried', retryAt: null, reasonCode: null });
    expect(registry.canProbe('a', 'input-drafts')).toBe(true);

    registry.recordSupported('a', 'input-drafts');
    expect(registry.read('a', 'input-drafts')).toEqual({ status: 'supported', retryAt: null, reasonCode: 'feature_probe_succeeded' });
    expect(registry.canProbe('a', 'input-drafts')).toBe(false);

    registry.recordHttpFailure('b', 'input-drafts', 404);
    expect(registry.read('b', 'input-drafts')).toMatchObject({ status: 'unsupported', reasonCode: 'feature_route_not_found' });
    registry.recordHttpFailure('c', 'input-drafts', 405);
    expect(registry.read('c', 'input-drafts')).toMatchObject({ status: 'unsupported', reasonCode: 'feature_method_not_allowed' });
  });

  it('backs off transient and authentication failures for sixty seconds', () => {
    let now = 1_000;
    const registry = createRemoteFeatureSessionRegistry({ now: () => now });
    registry.recordTransientFailure('a', 'input-drafts');
    expect(registry.read('a', 'input-drafts')).toEqual({ status: 'backoff', retryAt: 61_000, reasonCode: 'feature_probe_transient_failure' });
    expect(registry.canProbe('a', 'input-drafts')).toBe(false);
    now = 61_000;
    expect(registry.canProbe('a', 'input-drafts')).toBe(true);

    registry.recordHttpFailure('b', 'input-drafts', 401);
    expect(registry.read('b', 'input-drafts')).toEqual({ status: 'backoff', retryAt: 121_000, reasonCode: 'feature_probe_auth_failure' });
    registry.recordHttpFailure('c', 'input-drafts', 403);
    expect(registry.read('c', 'input-drafts').status).toBe('backoff');
    registry.recordHttpFailure('d', 'input-drafts', 500);
    expect(registry.read('d', 'input-drafts').reasonCode).toBe('feature_probe_transient_failure');
  });

  it('clears only the selected connection and never touches browser storage', () => {
    const registry = createRemoteFeatureSessionRegistry();
    registry.recordSupported('a', 'input-drafts');
    registry.recordSupported('b', 'input-drafts');
    registry.clearConnection('a');
    expect(registry.read('a', 'input-drafts').status).toBe('untried');
    expect(registry.read('b', 'input-drafts').status).toBe('supported');
    expect(Object.keys(registry)).not.toContain('storage');
  });
});
