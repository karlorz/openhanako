import featureContractsModule from "./remote-feature-contracts.cjs";

export const {
  CONTRACT_NAME_RE,
  SERVER_FEATURE_CONTRACTS,
  normalizeFeatureContracts,
} = featureContractsModule;

export type { RemoteFeatureContracts } from "./remote-feature-contracts.cjs";
