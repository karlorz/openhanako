import knownModelFallbacks from '../../../../lib/known-model-fallbacks.json';
import knownModels from '../../../../lib/known-models.json';

export interface ModelReferenceMeta {
  name?: string;
  displayName?: string;
  context?: number;
  maxOutput?: number;
  image?: boolean;
  vision?: boolean;
  video?: boolean;
  audio?: boolean;
  reasoning?: boolean;
  xhigh?: boolean;
  _source?: 'reference';
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeMeta(value: unknown): ModelReferenceMeta | null {
  if (!isRecord(value)) return null;
  return { ...value, _source: 'reference' } as ModelReferenceMeta;
}

function lookupInProviderPartition(
  dict: Record<string, unknown>,
  provider: string,
  modelId: string,
  bare: string,
): ModelReferenceMeta | null {
  const providerModels = dict[provider];
  if (!isRecord(providerModels)) return null;
  const exact = normalizeMeta(providerModels[modelId]);
  if (exact) return exact;
  if (bare) {
    const bareHit = normalizeMeta(providerModels[bare]);
    if (bareHit) return bareHit;
  }
  return null;
}

function lookupInFallbacks(
  fallbacks: Record<string, unknown>,
  modelId: string,
  bare: string,
): ModelReferenceMeta | null {
  const fallback = normalizeMeta(fallbacks[modelId]);
  if (fallback) return fallback;
  if (bare) {
    const bareFallback = normalizeMeta(fallbacks[bare]);
    if (bareFallback) return bareFallback;
  }
  return null;
}

/**
 * Reference metadata for settings UI.
 *
 * Lookup order when `provider` is set (same layers as server `lookupKnown`):
 *   1. provider-specific known-models partition
 *   2. generic known-model-fallbacks
 * Note: server also does case-insensitive key match; this client path is exact-key.
 *
 * Do **not** borrow from other providers' partitions when provider is known —
 * that made the edit panel show Vision ON while model-sync left runtime
 * image capability off (e.g. custom-provider/grok-4.3 only listed under xai).
 *
 * When provider is omitted (display-only), allow a best-effort scan of all
 * partitions so bare-id UI can still show a name.
 */
export function lookupReferenceModelMeta(modelId: string, provider?: string): ModelReferenceMeta | null {
  if (!modelId) return null;
  const dict = knownModels as Record<string, unknown>;
  const fallbacks = knownModelFallbacks as Record<string, unknown>;
  const bare = modelId.includes('/') ? modelId.split('/').pop() || '' : '';

  if (provider) {
    const providerHit = lookupInProviderPartition(dict, provider, modelId, bare);
    if (providerHit) return providerHit;
    return lookupInFallbacks(fallbacks, modelId, bare);
  }

  const fallback = lookupInFallbacks(fallbacks, modelId, bare);
  if (fallback) return fallback;

  for (const [key, value] of Object.entries(dict)) {
    if (key === '_comment' || !isRecord(value)) continue;
    const hit = normalizeMeta(value[modelId]);
    if (hit) return hit;
    if (bare) {
      const bareHit = normalizeMeta(value[bare]);
      if (bareHit) return bareHit;
    }
  }
  return null;
}
