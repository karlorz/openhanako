import { loadServerIdentity } from "./server-identity.ts";
import { createRuntimeExecutionBoundary } from "./execution-boundary.ts";
import { normalizeFeatureContracts } from "../shared/remote-feature-contracts.ts";
import { normalizeServerBuildInfo } from "../shared/server-build-info.ts";
import { normalizeServerPlatformArch } from "../shared/remote-server-release-catalog.ts";

const LOCAL_CAPABILITIES = ["chat", "resources", "tools"];

function clonePlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createServerRuntimeContext({
  hanakoHome,
  appVersion = "?",
  runtimeBuild = null,
  featureContracts = null,
  runtimeFacts = null,
}) {
  const identity = loadServerIdentity(hanakoHome);
  const normalizedRuntimeBuild = runtimeBuild ? normalizeServerBuildInfo(runtimeBuild) : null;
  const normalizedFeatureContracts = featureContracts ? normalizeFeatureContracts(featureContracts) : null;
  const normalizedRuntimeFacts = runtimeFacts
    ? normalizeServerPlatformArch(runtimeFacts.platform, runtimeFacts.arch)
    : null;
  if (runtimeBuild && !normalizedRuntimeBuild) throw new TypeError("Invalid server runtime build evidence");
  if (featureContracts && !normalizedFeatureContracts) throw new TypeError("Invalid server feature-contract evidence");
  if (runtimeFacts && !normalizedRuntimeFacts) throw new TypeError("Invalid server runtime facts");
  const runtimeContext = {
    schemaVersion: 1,
    serverId: identity.serverId,
    serverNodeId: identity.serverNodeId,
    serverNodeKind: identity.serverNodeKind,
    serverNodeTransport: identity.serverNodeTransport,
    userId: identity.userId,
    studioId: identity.studioId,
    label: identity.label,
    userLabel: identity.userLabel,
    studioLabel: identity.studioLabel,
    userKind: identity.userKind,
    studioKind: identity.studioKind,
    membershipModel: identity.membershipModel,
    storage: clonePlain(identity.storage),
    connectionKind: "local",
    authState: "paired",
    trustState: "local",
    credentialKind: "loopback_token",
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: [...LOCAL_CAPABILITIES],
    appVersion,
    ...(normalizedRuntimeBuild ? { runtimeBuild: clonePlain(normalizedRuntimeBuild) } : {}),
    ...(normalizedFeatureContracts ? { featureContracts: clonePlain(normalizedFeatureContracts) } : {}),
    ...(normalizedRuntimeFacts ? { runtimeFacts: clonePlain(normalizedRuntimeFacts) } : {}),
    executionBoundary: null as any,
  };
  runtimeContext.executionBoundary = createRuntimeExecutionBoundary(runtimeContext);
  return deepFreeze(runtimeContext);
}

export function toServerIdentityResponse(runtimeContext, { appVersion }: { appVersion?: string } = {}) {
  const runtimeBuild = runtimeContext.runtimeBuild
    ? {
        schemaVersion: runtimeContext.runtimeBuild.schemaVersion,
        runtimeVersion: runtimeContext.runtimeBuild.runtimeVersion,
        releaseTag: runtimeContext.runtimeBuild.releaseTag,
        gitSha: runtimeContext.runtimeBuild.gitSha,
        sourceRepository: runtimeContext.runtimeBuild.sourceRepository,
      }
    : null;
  const featureContracts = normalizeFeatureContracts(runtimeContext.featureContracts);
  const runtimeFacts = normalizeServerPlatformArch(
    runtimeContext.runtimeFacts?.platform,
    runtimeContext.runtimeFacts?.arch,
  );
  return {
    connectionKind: runtimeContext.connectionKind,
    serverId: runtimeContext.serverId,
    serverNodeId: runtimeContext.serverNodeId ?? runtimeContext.serverId,
    serverNodeKind: runtimeContext.serverNodeKind ?? "local",
    serverNodeTransport: runtimeContext.serverNodeTransport ?? "loopback",
    userId: runtimeContext.userId,
    studioId: runtimeContext.studioId,
    label: runtimeContext.label,
    userLabel: runtimeContext.userLabel,
    studioLabel: runtimeContext.studioLabel,
    trustState: runtimeContext.trustState,
    authState: runtimeContext.authState,
    credentialKind: runtimeContext.credentialKind,
    platformAccountId: runtimeContext.platformAccountId ?? null,
    officialServiceKind: runtimeContext.officialServiceKind ?? null,
    executionBoundary: clonePlain(runtimeContext.executionBoundary),
    capabilities: [...runtimeContext.capabilities],
    version: appVersion || runtimeContext.appVersion || "?",
    ...(runtimeBuild ? { runtimeBuild: clonePlain(runtimeBuild) } : {}),
    ...(featureContracts ? { featureContracts: clonePlain(featureContracts) } : {}),
    ...(runtimeFacts ? { runtimeFacts: clonePlain(runtimeFacts) } : {}),
  };
}
