import { hanaFetch } from './api';

export interface MarketplaceRegistryPrecondition {
  revision?: number;
  digest?: string;
}

export interface MarketplaceActivationSnapshot {
  registry: MarketplaceRegistryPrecondition | null;
  activations: Record<string, unknown> | null;
}

export function buildMarketplaceSkillPackageActivationPayload(
  snapshot: MarketplaceActivationSnapshot,
  identity: string,
  enabled: boolean,
): Record<string, unknown> | null {
  if (!snapshot.activations || typeof snapshot.activations !== 'object') return null;

  const activations = structuredClone(snapshot.activations) as Record<string, unknown> & {
    marketplaceSkillPackages?: Record<string, { enabled: boolean }>;
  };
  activations.marketplaceSkillPackages ||= {};
  activations.marketplaceSkillPackages[identity] = { enabled };

  const body: Record<string, unknown> = { activations };
  if (typeof snapshot.registry?.revision === 'number') {
    body.expectedRevision = snapshot.registry.revision;
  }
  if (snapshot.registry?.digest) {
    body.expectedDigest = snapshot.registry.digest;
  }
  return body;
}

export type MarketplaceSkillPackageToggleResult = 'saved' | 'stale';

export async function writeMarketplaceSkillPackageToggle(
  snapshot: MarketplaceActivationSnapshot,
  identity: string,
  enabled: boolean,
): Promise<MarketplaceSkillPackageToggleResult> {
  const body = buildMarketplaceSkillPackageActivationPayload(snapshot, identity, enabled);
  if (!body) throw new Error('missing activations snapshot');

  try {
    const res = await hanaFetch('/api/plugins/marketplace/config/activations', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      if (isMarketplaceRegistryStaleConflict(data)) return 'stale';
      throw new Error(data.error || 'Skill package toggle failed');
    }
    return 'saved';
  } catch (err) {
    if (isMarketplaceRegistryStaleConflict(err)) return 'stale';
    throw err;
  }
}

/**
 * hanaFetch currently surfaces non-2xx responses as Error instances, whereas
 * component tests can return an unthrown Response. Support both forms without
 * treating unrelated failures as retryable.
 */
export function isMarketplaceRegistryStaleConflict(value: unknown): boolean {
  if (value && typeof value === 'object') {
    const code = (value as { code?: unknown }).code;
    if (code === 'PLUGIN_MARKETPLACE_REGISTRY_STALE') return true;
  }
  const message = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? String((value as { error?: unknown; message?: unknown }).error
          || (value as { message?: unknown }).message
          || '')
        : '';
  return /Marketplace registry (?:revision|digest) conflict/i.test(message);
}
