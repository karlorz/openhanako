import {
  isLocalOwnerConnection,
  isLoopbackConnectionUrl,
  type ExecutionBoundary,
  type ServerConnection,
  type ServerIdentity,
} from './server-connection';

export type RemoteCompatibilityReasonCode =
  | 'invalid_identity'
  | 'auth_failed'
  | 'invalid_capabilities'
  | 'missing_core_capability'
  | 'missing_optional_capability'
  | 'invalid_execution_boundary'
  | 'identity_transport_contradiction';

export interface RemoteBoundaryCompatibility {
  ok: boolean;
  reasonCodes: RemoteCompatibilityReasonCode[];
  warningCodes: RemoteCompatibilityReasonCode[];
}

export class RemoteBoundaryContractError extends Error {
  readonly compatibility: RemoteBoundaryCompatibility;

  constructor(compatibility: RemoteBoundaryCompatibility) {
    super('remote boundary contract failed');
    this.name = 'RemoteBoundaryContractError';
    this.compatibility = compatibility;
  }
}

const CORE_BOOTSTRAP_CAPABILITIES = ['chat'];
const OPTIONAL_COMPATIBILITY_CAPABILITIES = ['resources', 'files', 'tools', 'settings'];

export function validateRemoteBoundaryContract(
  connection: ServerConnection | null | undefined,
  identity: ServerIdentity | null | undefined,
): RemoteBoundaryCompatibility {
  const reasonCodes = new Set<RemoteCompatibilityReasonCode>();
  const warningCodes = new Set<RemoteCompatibilityReasonCode>();

  if (!connection || !identity || typeof identity !== 'object') {
    reasonCodes.add('invalid_identity');
    return toCompatibility(reasonCodes, warningCodes);
  }

  if (!isNonEmptyString(identity.serverId) || !isNonEmptyString(identity.studioId)) {
    reasonCodes.add('invalid_identity');
  }

  if (hasIdentityTransportContradiction(connection, identity)) {
    reasonCodes.add('identity_transport_contradiction');
  }

  if (!Array.isArray(identity.capabilities) || !identity.capabilities.every(isNonEmptyString)) {
    reasonCodes.add('invalid_capabilities');
  } else {
    const capabilities = new Set(identity.capabilities);
    if (!CORE_BOOTSTRAP_CAPABILITIES.every(capability => capabilities.has(capability))) {
      reasonCodes.add('missing_core_capability');
    }
    if (!OPTIONAL_COMPATIBILITY_CAPABILITIES.every(capability => capabilities.has(capability))) {
      warningCodes.add('missing_optional_capability');
    }
  }

  if (!isValidExecutionBoundary(identity.executionBoundary)) {
    reasonCodes.add('invalid_execution_boundary');
  }

  return toCompatibility(reasonCodes, warningCodes);
}

export function assertRemoteBoundaryContract(
  connection: ServerConnection,
  identity: ServerIdentity,
): void {
  if (isLocalOwnerConnection(connection)) return;
  const compatibility = validateRemoteBoundaryContract(connection, identity);
  if (!compatibility.ok) {
    throw new RemoteBoundaryContractError(compatibility);
  }
}

function toCompatibility(
  reasonCodes: Set<RemoteCompatibilityReasonCode>,
  warningCodes: Set<RemoteCompatibilityReasonCode>,
): RemoteBoundaryCompatibility {
  return {
    ok: reasonCodes.size === 0,
    reasonCodes: [...reasonCodes],
    warningCodes: [...warningCodes],
  };
}

function hasIdentityTransportContradiction(
  connection: ServerConnection,
  identity: ServerIdentity,
): boolean {
  if (connection.kind === 'local' && !isLocalOwnerConnection(connection)) return true;
  if (connection.kind === 'local' && !isLoopbackConnectionUrl(connection.baseUrl)) return true;
  if (identity.connectionKind === 'local' && connection.kind !== 'local') return true;
  if (identity.credentialKind === 'device_credential' && connection.kind === 'local') return true;
  return false;
}

function isValidExecutionBoundary(boundary: ExecutionBoundary | null | undefined): boundary is ExecutionBoundary {
  return !!boundary
    && typeof boundary === 'object'
    && isNonEmptyString(boundary.kind)
    && isNonEmptyString(boundary.serverNodeId)
    && isNonEmptyString(boundary.studioId)
    && !!boundary.workbench
    && typeof boundary.workbench === 'object'
    && isNonEmptyString(boundary.workbench.kind);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
