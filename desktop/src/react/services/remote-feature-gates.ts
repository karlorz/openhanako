import type { RemoteServerAssessment } from '../../../../shared/remote-server-assessment';

export {
  resolveConnectionWsAuth,
  type ConnectionWsAuth,
} from './server-connection';

export type RemoteFeatureDecision =
  | { featureId: string; mode: 'remote'; fallback: null; reasonCode: null }
  | { featureId: string; mode: 'fallback'; fallback: 'memory-only'; reasonCode: string }
  | { featureId: string; mode: 'probe-once'; fallback: 'memory-only'; reasonCode: string }
  | { featureId: string; mode: 'not-assessed'; fallback: null; reasonCode: string };

const NOT_ASSESSED = (featureId: string): RemoteFeatureDecision => ({
  featureId,
  mode: 'not-assessed',
  fallback: null,
  reasonCode: 'feature_not_assessed',
});

export function resolveRemoteFeatureDecision(
  assessment: RemoteServerAssessment | null | undefined,
  featureId: string,
): RemoteFeatureDecision {
  if (!assessment || assessment.schemaVersion !== 1 || !Array.isArray(assessment.features?.items)) {
    return NOT_ASSESSED(featureId);
  }
  const feature = assessment.features.items.find((item) => item.id === featureId);
  if (!feature) return NOT_ASSESSED(featureId);
  if (feature.status === 'supported') {
    return { featureId, mode: 'remote', fallback: null, reasonCode: null };
  }
  if (featureId !== 'input-drafts' || feature.fallback !== 'memory-only') {
    return NOT_ASSESSED(featureId);
  }
  if (feature.status === 'unavailable') {
    return {
      featureId,
      mode: 'fallback',
      fallback: 'memory-only',
      reasonCode: feature.reasonCode || 'feature_unavailable',
    };
  }
  if (feature.status === 'unknown') {
    return {
      featureId,
      mode: 'probe-once',
      fallback: 'memory-only',
      reasonCode: 'feature_contracts_missing',
    };
  }
  return NOT_ASSESSED(featureId);
}
