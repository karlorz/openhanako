import {
  assessRemoteServer,
  type RemoteServerAssessment,
  type RemoteServerAssessmentInput,
} from '../../../../shared/remote-server-assessment';
import type { RemoteServerReleaseCheck } from '../../../../shared/remote-server-release-catalog.cjs';
import { removeRemoteServerAssessment } from './remote-server-assessment-cache';
import {
  validateRemoteBoundaryContract,
  type RemoteBoundaryCompatibility,
} from './remote-boundary-contract';
import {
  isLocalOwnerConnection,
  type ServerConnection,
  type ServerIdentity,
} from './server-connection';

type ExtendedServerIdentity = ServerIdentity & {
  runtimeBuild?: RemoteServerAssessmentInput['server'] extends infer Server
    ? Server extends { runtimeBuild?: infer Build } ? Build : never
    : never;
  featureContracts?: RemoteServerAssessmentInput['server'] extends infer Server
    ? Server extends { featureContracts?: infer Contracts } ? Contracts : never
    : never;
  runtimeFacts?: RemoteServerAssessmentInput['server'] extends infer Server
    ? Server extends { runtimeFacts?: infer Facts } ? Facts : never
    : never;
};

export type CoordinatorDependencies = {
  getActiveConnectionId: () => string | null;
  fetchIdentity: (connection: ServerConnection) => Promise<ServerIdentity>;
  loadRelease: (options?: { force?: boolean }) => Promise<RemoteServerReleaseCheck>;
  evaluate: typeof assessRemoteServer;
  applyAssessment: (assessment: RemoteServerAssessment | null) => void;
  persistAssessment: (assessment: RemoteServerAssessment) => void;
  now: () => Date;
};

export type AssessConnectionOptions = {
  force?: boolean;
  initialIdentity?: ServerIdentity;
  initialBoundary?: RemoteBoundaryCompatibility;
};

export type RemoteServerAssessmentCoordinator = {
  assessConnection(connection: ServerConnection, options?: AssessConnectionOptions): Promise<RemoteServerAssessment | null>;
  invalidate(connectionId?: string): void;
};

const FEATURE_REQUIREMENTS = [{
  id: 'input-drafts',
  contract: 'input.drafts',
  minVersion: 1,
  unknownPolicy: 'fallback',
  fallback: 'memory-only',
}] as const;

export function createRemoteServerAssessmentCoordinator(
  dependencies: CoordinatorDependencies,
): RemoteServerAssessmentCoordinator {
  let generation = 0;

  function isCurrent(connectionId: string, capturedGeneration: number): boolean {
    return generation === capturedGeneration
      && dependencies.getActiveConnectionId() === connectionId;
  }

  function evaluate(
    connection: ServerConnection,
    identity: ExtendedServerIdentity,
    boundary: RemoteBoundaryCompatibility,
    releaseCheck?: RemoteServerReleaseCheck,
  ): RemoteServerAssessment {
    return dependencies.evaluate({
      connectionId: connection.connectionId,
      assessedAt: dependencies.now().toISOString(),
      evidenceSource: 'desktop',
      boundary: {
        status: 'assessed',
        ok: boundary.ok,
        reasonCodes: boundary.reasonCodes,
        warningCodes: boundary.warningCodes,
      },
      server: {
        connectionKind: connection.kind,
        runtimeVersion: identity.version ?? null,
        serverProtocol: identity.serverProtocol ?? null,
        runtimeBuild: identity.runtimeBuild ?? null,
        featureContracts: identity.featureContracts ?? null,
        runtimeFacts: identity.runtimeFacts ?? null,
      },
      releaseCheck,
      featureRequirements: FEATURE_REQUIREMENTS,
    });
  }

  function publish(
    connectionId: string,
    capturedGeneration: number,
    assessment: RemoteServerAssessment,
  ): boolean {
    if (!isCurrent(connectionId, capturedGeneration)) return false;
    dependencies.applyAssessment(assessment);
    dependencies.persistAssessment(assessment);
    return true;
  }

  return {
    async assessConnection(connection, options = {}) {
      const capturedGeneration = ++generation;
      const connectionId = connection.connectionId;
      if (isLocalOwnerConnection(connection)) {
        if (isCurrent(connectionId, capturedGeneration)) dependencies.applyAssessment(null);
        return null;
      }

      let identity: ExtendedServerIdentity;
      try {
        identity = (!options.force && options.initialIdentity
          ? options.initialIdentity
          : await dependencies.fetchIdentity(connection)) as ExtendedServerIdentity;
      } catch {
        return null;
      }
      if (!isCurrent(connectionId, capturedGeneration)) return null;

      const boundary = !options.force && options.initialBoundary
        ? options.initialBoundary
        : validateRemoteBoundaryContract(connection, identity);
      let assessment = evaluate(connection, identity, boundary);
      if (!publish(connectionId, capturedGeneration, assessment)) return null;

      let releaseCheck: RemoteServerReleaseCheck;
      try {
        releaseCheck = await dependencies.loadRelease(options.force ? { force: true } : undefined);
      } catch {
        releaseCheck = {
          status: 'unavailable',
          checkedAt: dependencies.now().toISOString(),
          source: 'none',
          stale: false,
          release: null,
          errorCode: 'server_release_lookup_failed',
          reasonCodes: ['server_release_lookup_failed'],
        };
      }
      if (!isCurrent(connectionId, capturedGeneration)) return null;
      assessment = evaluate(connection, identity, boundary, releaseCheck);
      if (!publish(connectionId, capturedGeneration, assessment)) return null;
      return assessment;
    },

    invalidate(connectionId) {
      generation += 1;
      if (connectionId) removeRemoteServerAssessment(connectionId);
    },
  };
}
