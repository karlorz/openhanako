export type RemoteFeatureContracts = {
  schemaVersion: 1;
  complete: true;
  entries: Readonly<Record<string, number>>;
};

export const CONTRACT_NAME_RE: RegExp;
export const SERVER_FEATURE_CONTRACTS: Readonly<RemoteFeatureContracts>;
export function normalizeFeatureContracts(value: unknown): Readonly<RemoteFeatureContracts> | null;
