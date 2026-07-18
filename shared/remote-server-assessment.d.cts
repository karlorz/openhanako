export type RemoteFeatureAssessment = {
  id: string;
  contract: string;
  requiredVersion: number;
  reportedVersion: number | null;
  status: "supported" | "unavailable" | "unknown" | "not-assessed";
  fallback: "memory-only" | null;
  evidenceSource: "declared" | "probe" | "legacy" | "none";
  reasonCode: string | null;
  upgradeEvidence: {
    targetTag: string;
    targetContractVersion: number;
    manifestGitSha: string;
  } | null;
};

export type RemoteServerAssessment = {
  schemaVersion: 1;
  connectionId: string;
  assessedAt: string;
  summary: "ready" | "attention" | "blocked" | "not-assessed";
  core: {
    status: "ready" | "degraded" | "blocked" | "not-assessed";
    evidenceSource: "remote-boundary" | "smoke" | "installer" | "none";
    reasonCodes: string[];
    warningCodes: string[];
  };
  transport: {
    status: "ticket-ready" | "legacy-query-token" | "unknown" | "not-assessed";
    reportedTicketContractVersion: number | null;
    reasonCodes: string[];
  };
  features: {
    summary: "full" | "limited" | "legacy" | "not-assessed";
    items: RemoteFeatureAssessment[];
  };
  build: {
    runtimeVersion: string | null;
    releaseTag: string | null;
    gitSha: string | null;
    sourceRepository: string | null;
  };
  freshness: {
    status: "current" | "update-recommended" | "ahead-or-custom" | "unknown";
    runtimeVersion: string | null;
    installedReleaseTag: string | null;
    recommendedRuntimeVersion: string | null;
    recommendedReleaseTag: string | null;
    baseVersionMatch: boolean;
    exactReleaseMatch: boolean;
    checkedAt: string | null;
    source: "online" | "cached" | "none";
    stale: boolean;
    reasonCodes: string[];
  };
  deployability: {
    status: "eligible" | "release-only" | "unavailable" | "unknown" | "not-assessed";
    platform: "linux" | "mac" | "win" | null;
    arch: "arm64" | "x64" | null;
    targetTag: string | null;
    assetName: string | null;
    checksumName: string | null;
    reasonCodes: string[];
  };
  releasePolicy: {
    expectedPrerelease: boolean;
    actualPrerelease: boolean | null;
    drift: boolean;
  };
  reasonCodes: string[];
};

export type RemoteFeatureRequirement = {
  id: string;
  contract: string;
  minVersion: number;
  unknownPolicy: "disable" | "fallback";
  fallback: "memory-only" | null;
};

export type RemoteFeatureContracts = {
  schemaVersion: number;
  complete: boolean;
  entries: Record<string, number>;
} | null;

export type RemoteCoreRequirement = {
  contract: "chat.core";
  minVersion: 1;
};

export type RemoteBoundaryEvidence =
  | {
      status: "assessed";
      ok: boolean;
      reasonCodes: string[];
      warningCodes: string[];
    }
  | {
      status: "not-assessed";
      reasonCode: string;
    }
  | null;

export type RemoteServerAssessmentInput = {
  connectionId: string;
  assessedAt?: string;
  evidenceSource?: "desktop" | "smoke" | "installer";
  boundary?: RemoteBoundaryEvidence;
  client?: {
    runtimeVersion?: string | null;
    serverProtocol?: number | null;
  };
  server?: {
    connectionKind?: "local" | "lan" | "custom_remote" | "relay" | "cloud" | null;
    runtimeVersion?: string | null;
    serverProtocol?: number | null;
    runtimeBuild?: {
      schemaVersion?: number;
      runtimeVersion?: string;
      releaseTag?: string | null;
      gitSha?: string | null;
      sourceRepository?: string | null;
    } | null;
    featureContracts?: RemoteFeatureContracts;
    runtimeFacts?: {
      platform?: string | null;
      arch?: string | null;
    } | null;
  } | null;
  releaseCheck?: import("./remote-server-release-catalog.cjs").RemoteServerReleaseCheck | null;
  coreRequirement?: RemoteCoreRequirement;
  featureRequirements?: readonly RemoteFeatureRequirement[];
};

export const REMOTE_INPUT_DRAFT_FEATURE_REQUIREMENTS: readonly [{
  readonly id: "input-drafts";
  readonly contract: "input.drafts";
  readonly minVersion: 1;
  readonly unknownPolicy: "fallback";
  readonly fallback: "memory-only";
}];

export function parseCanonicalRuntimeVersion(value: unknown): [number, number, number] | null;
export function compareCanonicalRuntimeVersions(left: unknown, right: unknown): number | null;
export function assessRemoteServer(input: RemoteServerAssessmentInput): RemoteServerAssessment;
export function applyRemoteFeatureObservation(
  assessment: RemoteServerAssessment,
  observation: {
    featureId: string;
    status: "supported" | "unavailable";
    reasonCode: string;
  },
): RemoteServerAssessment;
