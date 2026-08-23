import { describe, expect, it } from 'vitest';
import type { RemoteServerAssessment } from '../../../../../shared/remote-server-assessment';
import { resolveRemoteFeatureDecision } from '../../services/remote-feature-gates';

function assessment(status: 'supported' | 'unavailable' | 'unknown'): RemoteServerAssessment {
  return {
    schemaVersion: 1,
    connectionId: 'lan:test:default',
    assessedAt: '2026-07-19T00:00:00.000Z',
    summary: 'attention',
    core: { status: 'ready', evidenceSource: 'remote-boundary', reasonCodes: [], warningCodes: [] },
    transport: { status: 'legacy-query-token', reportedTicketContractVersion: null, reasonCodes: [] },
    features: {
      summary: status === 'supported' ? 'full' : status === 'unavailable' ? 'limited' : 'legacy',
      items: [{
        id: 'input-drafts',
        contract: 'input.drafts',
        requiredVersion: 1,
        reportedVersion: status === 'supported' ? 1 : null,
        status,
        fallback: status === 'supported' ? null : 'memory-only',
        evidenceSource: status === 'unknown' ? 'legacy' : 'declared',
        reasonCode: status === 'unavailable' ? 'feature_contract_missing' : status === 'unknown' ? 'feature_contract_unknown' : null,
        upgradeEvidence: null,
      }],
    },
    build: { runtimeVersion: null, releaseTag: null, gitSha: null, sourceRepository: null },
    freshness: { status: 'unknown', runtimeVersion: null, installedReleaseTag: null, recommendedRuntimeVersion: null, recommendedReleaseTag: null, baseVersionMatch: false, exactReleaseMatch: false, checkedAt: null, source: 'none', stale: false, reasonCodes: [] },
    deployability: { status: 'unknown', platform: null, arch: null, targetTag: null, assetName: null, checksumName: null, reasonCodes: [] },
    releasePolicy: { expectedPrerelease: true, actualPrerelease: null, drift: false },
    reasonCodes: [],
  };
}

describe('remote feature decisions', () => {
  it('uses the remote route only for declared support', () => {
    expect(resolveRemoteFeatureDecision(assessment('supported'), 'input-drafts')).toEqual({
      featureId: 'input-drafts', mode: 'remote', fallback: null, reasonCode: null,
    });
  });

  it('uses memory-only for declared unavailability', () => {
    expect(resolveRemoteFeatureDecision(assessment('unavailable'), 'input-drafts')).toEqual({
      featureId: 'input-drafts', mode: 'fallback', fallback: 'memory-only', reasonCode: 'feature_contract_missing',
    });
  });

  it('permits one bounded probe for a legacy server', () => {
    expect(resolveRemoteFeatureDecision(assessment('unknown'), 'input-drafts')).toEqual({
      featureId: 'input-drafts', mode: 'probe-once', fallback: 'memory-only', reasonCode: 'feature_contracts_missing',
    });
  });

  it('does not invent a fallback for missing or malformed evidence', () => {
    expect(resolveRemoteFeatureDecision(null, 'unknown-feature')).toEqual({
      featureId: 'unknown-feature', mode: 'not-assessed', fallback: null, reasonCode: 'feature_not_assessed',
    });
    expect(resolveRemoteFeatureDecision({ features: { items: [{ id: 'input-drafts', status: 'unknown', fallback: 'other' }] } } as never, 'input-drafts'))
      .toEqual({ featureId: 'input-drafts', mode: 'not-assessed', fallback: null, reasonCode: 'feature_not_assessed' });
  });
});
