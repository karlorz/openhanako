import type {
  RemoteFeatureAssessment,
  RemoteServerAssessment,
} from '../../../../shared/remote-server-assessment';

const STORAGE_KEY = 'hana-remote-server-assessments-v1';
const SCHEMA_VERSION = 1;
const STALE_AFTER_MS = 600_000;

interface AssessmentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CacheOptions {
  storage?: AssessmentStorage | null;
  now?: () => number;
}

type PersistedAssessmentEnvelope = {
  schemaVersion: 1;
  byConnectionId: Record<string, RemoteServerAssessment>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value)) ? value : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : undefined;
}

function sanitizeFeature(value: unknown): RemoteFeatureAssessment | null {
  if (!isRecord(value)) return null;
  const status = enumValue(value.status, ['supported', 'unavailable', 'unknown', 'not-assessed'] as const);
  const fallback = value.fallback === null || value.fallback === 'memory-only' ? value.fallback : undefined;
  const evidenceSource = enumValue(value.evidenceSource, ['declared', 'probe', 'legacy', 'none'] as const);
  const reasonCode = nullableString(value.reasonCode);
  const reportedVersion = nullableNumber(value.reportedVersion);
  if (typeof value.id !== 'string' || typeof value.contract !== 'string'
      || typeof value.requiredVersion !== 'number'
      || !Number.isSafeInteger(value.requiredVersion) || value.requiredVersion < 0
      || reportedVersion === undefined || !status || fallback === undefined
      || !evidenceSource || reasonCode === undefined) return null;

  let upgradeEvidence: RemoteFeatureAssessment['upgradeEvidence'] = null;
  if (value.upgradeEvidence !== null) {
    if (!isRecord(value.upgradeEvidence)
        || typeof value.upgradeEvidence.targetTag !== 'string'
        || typeof value.upgradeEvidence.targetContractVersion !== 'number'
        || !Number.isSafeInteger(value.upgradeEvidence.targetContractVersion)
        || typeof value.upgradeEvidence.manifestGitSha !== 'string') return null;
    upgradeEvidence = {
      targetTag: value.upgradeEvidence.targetTag,
      targetContractVersion: value.upgradeEvidence.targetContractVersion as number,
      manifestGitSha: value.upgradeEvidence.manifestGitSha,
    };
  }

  return {
    id: value.id,
    contract: value.contract,
    requiredVersion: value.requiredVersion as number,
    reportedVersion,
    status,
    fallback,
    evidenceSource,
    reasonCode,
    upgradeEvidence,
  };
}

export function sanitizeRemoteServerAssessment(value: unknown): RemoteServerAssessment | null {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION
      || typeof value.connectionId !== 'string' || typeof value.assessedAt !== 'string'
      || !isRecord(value.core) || !isRecord(value.transport) || !isRecord(value.features)
      || !isRecord(value.build) || !isRecord(value.freshness) || !isRecord(value.deployability)
      || !isRecord(value.releasePolicy) || !isStringArray(value.reasonCodes)) return null;

  const summary = enumValue(value.summary, ['ready', 'attention', 'blocked', 'not-assessed'] as const);
  const coreStatus = enumValue(value.core.status, ['ready', 'degraded', 'blocked', 'not-assessed'] as const);
  const coreSource = enumValue(value.core.evidenceSource, ['remote-boundary', 'smoke', 'installer', 'none'] as const);
  const transportStatus = enumValue(value.transport.status, ['ticket-ready', 'legacy-query-token', 'unknown', 'not-assessed'] as const);
  const ticketVersion = nullableNumber(value.transport.reportedTicketContractVersion);
  const featureSummary = enumValue(value.features.summary, ['full', 'limited', 'legacy', 'not-assessed'] as const);
  const featureItems = Array.isArray(value.features.items) ? value.features.items.map(sanitizeFeature) : [];
  const runtimeVersion = nullableString(value.build.runtimeVersion);
  const releaseTag = nullableString(value.build.releaseTag);
  const gitSha = nullableString(value.build.gitSha);
  const sourceRepository = nullableString(value.build.sourceRepository);
  const freshnessStatus = enumValue(value.freshness.status, ['current', 'update-recommended', 'ahead-or-custom', 'unknown'] as const);
  const freshnessRuntime = nullableString(value.freshness.runtimeVersion);
  const installedTag = nullableString(value.freshness.installedReleaseTag);
  const recommendedRuntime = nullableString(value.freshness.recommendedRuntimeVersion);
  const recommendedTag = nullableString(value.freshness.recommendedReleaseTag);
  const checkedAt = nullableString(value.freshness.checkedAt);
  const freshnessSource = enumValue(value.freshness.source, ['online', 'cached', 'none'] as const);
  const deployabilityStatus = enumValue(value.deployability.status, ['eligible', 'release-only', 'unavailable', 'unknown', 'not-assessed'] as const);
  const platform = value.deployability.platform === null
    ? null : enumValue(value.deployability.platform, ['linux', 'mac', 'win'] as const);
  const arch = value.deployability.arch === null
    ? null : enumValue(value.deployability.arch, ['arm64', 'x64'] as const);
  const targetTag = nullableString(value.deployability.targetTag);
  const assetName = nullableString(value.deployability.assetName);
  const checksumName = nullableString(value.deployability.checksumName);

  if (!summary || !coreStatus || !coreSource || !isStringArray(value.core.reasonCodes)
      || !isStringArray(value.core.warningCodes) || !transportStatus || ticketVersion === undefined
      || !isStringArray(value.transport.reasonCodes) || !featureSummary
      || featureItems.some(item => item === null) || runtimeVersion === undefined
      || releaseTag === undefined || gitSha === undefined || sourceRepository === undefined
      || !freshnessStatus || freshnessRuntime === undefined || installedTag === undefined
      || recommendedRuntime === undefined || recommendedTag === undefined || checkedAt === undefined
      || !freshnessSource || typeof value.freshness.baseVersionMatch !== 'boolean'
      || typeof value.freshness.exactReleaseMatch !== 'boolean' || typeof value.freshness.stale !== 'boolean'
      || !isStringArray(value.freshness.reasonCodes) || !deployabilityStatus
      || platform === undefined || arch === undefined || targetTag === undefined
      || assetName === undefined || checksumName === undefined
      || !isStringArray(value.deployability.reasonCodes)
      || typeof value.releasePolicy.expectedPrerelease !== 'boolean'
      || !(value.releasePolicy.actualPrerelease === null || typeof value.releasePolicy.actualPrerelease === 'boolean')
      || typeof value.releasePolicy.drift !== 'boolean') return null;

  return {
    schemaVersion: 1,
    connectionId: value.connectionId,
    assessedAt: value.assessedAt,
    summary,
    core: { status: coreStatus, evidenceSource: coreSource, reasonCodes: [...value.core.reasonCodes], warningCodes: [...value.core.warningCodes] },
    transport: { status: transportStatus, reportedTicketContractVersion: ticketVersion, reasonCodes: [...value.transport.reasonCodes] },
    features: { summary: featureSummary, items: featureItems as RemoteFeatureAssessment[] },
    build: { runtimeVersion, releaseTag, gitSha, sourceRepository },
    freshness: {
      status: freshnessStatus,
      runtimeVersion: freshnessRuntime,
      installedReleaseTag: installedTag,
      recommendedRuntimeVersion: recommendedRuntime,
      recommendedReleaseTag: recommendedTag,
      baseVersionMatch: value.freshness.baseVersionMatch,
      exactReleaseMatch: value.freshness.exactReleaseMatch,
      checkedAt,
      source: freshnessSource,
      stale: value.freshness.stale,
      reasonCodes: [...value.freshness.reasonCodes],
    },
    deployability: { status: deployabilityStatus, platform, arch, targetTag, assetName, checksumName, reasonCodes: [...value.deployability.reasonCodes] },
    releasePolicy: {
      expectedPrerelease: value.releasePolicy.expectedPrerelease,
      actualPrerelease: value.releasePolicy.actualPrerelease,
      drift: value.releasePolicy.drift,
    },
    reasonCodes: [...value.reasonCodes],
  };
}

function defaultStorage(): AssessmentStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readEnvelope(storage: AssessmentStorage | null): PersistedAssessmentEnvelope {
  if (!storage) return { schemaVersion: 1, byConnectionId: {} };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { schemaVersion: 1, byConnectionId: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.byConnectionId)) {
      return { schemaVersion: 1, byConnectionId: {} };
    }
    const byConnectionId: Record<string, RemoteServerAssessment> = {};
    for (const [connectionId, candidate] of Object.entries(parsed.byConnectionId)) {
      const assessment = sanitizeRemoteServerAssessment(candidate);
      if (assessment?.connectionId === connectionId) byConnectionId[connectionId] = assessment;
    }
    return { schemaVersion: 1, byConnectionId };
  } catch {
    return { schemaVersion: 1, byConnectionId: {} };
  }
}

export function readRemoteServerAssessment(connectionId: string, options: CacheOptions = {}): RemoteServerAssessment | null {
  const assessment = readEnvelope(options.storage ?? defaultStorage()).byConnectionId[connectionId] ?? null;
  if (!assessment) return null;
  const assessedAt = Date.parse(assessment.assessedAt);
  const now = options.now?.() ?? Date.now();
  if (Number.isFinite(assessedAt) && now - assessedAt > STALE_AFTER_MS && !assessment.freshness.stale) {
    return { ...assessment, freshness: { ...assessment.freshness, stale: true } };
  }
  return assessment;
}

export function writeRemoteServerAssessment(assessment: RemoteServerAssessment, options: CacheOptions = {}): void {
  const storage = options.storage ?? defaultStorage();
  const sanitized = sanitizeRemoteServerAssessment(assessment);
  if (!storage || !sanitized) return;
  try {
    const envelope = readEnvelope(storage);
    envelope.byConnectionId[sanitized.connectionId] = sanitized;
    storage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Assessment persistence is best-effort and must never block core chat.
  }
}

export function removeRemoteServerAssessment(connectionId: string, options: CacheOptions = {}): void {
  const storage = options.storage ?? defaultStorage();
  if (!storage) return;
  try {
    const envelope = readEnvelope(storage);
    if (!(connectionId in envelope.byConnectionId)) return;
    delete envelope.byConnectionId[connectionId];
    if (Object.keys(envelope.byConnectionId).length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Assessment persistence is best-effort and must never block core chat.
  }
}
