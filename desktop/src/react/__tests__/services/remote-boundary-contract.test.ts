import { describe, expect, it } from 'vitest';

import {
  validateRemoteBoundaryContract,
  type RemoteCompatibilityReasonCode,
} from '../../services/remote-boundary-contract';
import type {
  ExecutionBoundary,
  ServerConnection,
  ServerIdentity,
} from '../../services/server-connection';

const executionBoundary: ExecutionBoundary = {
  schemaVersion: 1,
  boundaryId: 'execb_node_lan_studio_lan',
  kind: 'remote_process',
  serverNodeId: 'node_lan',
  studioId: 'studio_lan',
  workbench: {
    kind: 'server_managed',
    root: null,
  },
};

const lanConnection: ServerConnection = {
  connectionId: 'lan:node_lan:studio_lan',
  kind: 'lan',
  serverId: 'server_lan',
  serverNodeId: 'node_lan',
  userId: 'user_lan',
  studioId: 'studio_lan',
  label: 'LAN Studio',
  baseUrl: 'http://100.125.173.118:14500',
  wsUrl: 'ws://100.125.173.118:14500',
  token: 'device-token',
  authState: 'paired',
  trustState: 'lan',
  credentialKind: 'device_credential',
  platformAccountId: null,
  officialServiceKind: null,
  executionBoundary,
  capabilities: ['chat', 'resources', 'files', 'tools', 'settings'],
};

const customRemoteConnection: ServerConnection = {
  ...lanConnection,
  connectionId: 'custom_remote:node_remote:studio_remote',
  kind: 'custom_remote',
  serverId: 'server_remote',
  serverNodeId: 'node_remote',
  studioId: 'studio_remote',
  label: 'Remote Studio',
  baseUrl: 'https://hana.example',
  wsUrl: 'wss://hana.example',
  trustState: 'tunnel',
  executionBoundary: {
    ...executionBoundary,
    boundaryId: 'execb_node_remote_studio_remote',
    serverNodeId: 'node_remote',
    studioId: 'studio_remote',
  },
};

function identity(patch: Partial<ServerIdentity> = {}): ServerIdentity {
  return {
    connectionKind: 'lan',
    serverId: lanConnection.serverId,
    serverNodeId: lanConnection.serverNodeId,
    userId: lanConnection.userId,
    studioId: lanConnection.studioId,
    label: lanConnection.label,
    authState: 'paired',
    trustState: 'lan',
    credentialKind: 'device_credential',
    platformAccountId: null,
    officialServiceKind: null,
    executionBoundary,
    capabilities: ['chat', 'resources', 'files', 'tools', 'settings'],
    version: '1.2.3',
    ...patch,
  };
}

function expectReasons(
  reasonCodes: RemoteCompatibilityReasonCode[],
  expected: RemoteCompatibilityReasonCode[],
): void {
  expect([...reasonCodes].sort()).toEqual([...expected].sort());
}

describe('validateRemoteBoundaryContract', () => {
  it('accepts a valid LAN device-credential identity', () => {
    expect(validateRemoteBoundaryContract(lanConnection, identity())).toEqual({
      ok: true,
      reasonCodes: [],
      warningCodes: [],
    });
  });

  it('accepts a valid custom Remote Server identity without enabling query-token auth', () => {
    expect(validateRemoteBoundaryContract(customRemoteConnection, identity({
      connectionKind: 'custom_remote',
      serverId: customRemoteConnection.serverId,
      serverNodeId: customRemoteConnection.serverNodeId,
      studioId: customRemoteConnection.studioId,
      trustState: 'tunnel',
      executionBoundary: customRemoteConnection.executionBoundary,
    }))).toEqual({
      ok: true,
      reasonCodes: [],
      warningCodes: [],
    });
  });

  it('rejects missing capabilities', () => {
    const result = validateRemoteBoundaryContract(lanConnection, identity({ capabilities: undefined }));

    expect(result.ok).toBe(false);
    expectReasons(result.reasonCodes, ['invalid_capabilities']);
    expect(result.warningCodes).toEqual([]);
  });

  it('rejects non-array capabilities', () => {
    const result = validateRemoteBoundaryContract(lanConnection, {
      ...identity(),
      capabilities: 'chat' as unknown as string[],
    });

    expect(result.ok).toBe(false);
    expectReasons(result.reasonCodes, ['invalid_capabilities']);
    expect(result.warningCodes).toEqual([]);
  });

  it('rejects a missing core bootstrap capability', () => {
    const result = validateRemoteBoundaryContract(lanConnection, identity({
      capabilities: ['resources', 'files', 'tools', 'settings'],
    }));

    expect(result.ok).toBe(false);
    expectReasons(result.reasonCodes, ['missing_core_capability']);
    expect(result.warningCodes).toEqual([]);
  });

  it('warns for missing optional capabilities without blocking bootstrap', () => {
    const result = validateRemoteBoundaryContract(lanConnection, identity({
      capabilities: ['chat', 'resources'],
    }));

    expect(result.ok).toBe(true);
    expect(result.reasonCodes).toEqual([]);
    expectReasons(result.warningCodes, ['missing_optional_capability']);
  });

  it('rejects an execution boundary without a kind', () => {
    const result = validateRemoteBoundaryContract(lanConnection, identity({
      executionBoundary: {
        ...executionBoundary,
        kind: '',
      },
    }));

    expect(result.ok).toBe(false);
    expectReasons(result.reasonCodes, ['invalid_execution_boundary']);
  });

  it('rejects an execution boundary without a server node id', () => {
    const result = validateRemoteBoundaryContract(lanConnection, identity({
      executionBoundary: {
        ...executionBoundary,
        serverNodeId: '',
      },
    }));

    expect(result.ok).toBe(false);
    expectReasons(result.reasonCodes, ['invalid_execution_boundary']);
  });

  it('rejects an execution boundary without a studio id', () => {
    const result = validateRemoteBoundaryContract(lanConnection, identity({
      executionBoundary: {
        ...executionBoundary,
        studioId: '',
      },
    }));

    expect(result.ok).toBe(false);
    expectReasons(result.reasonCodes, ['invalid_execution_boundary']);
  });

  it('rejects an execution boundary without a workbench kind', () => {
    const result = validateRemoteBoundaryContract(lanConnection, identity({
      executionBoundary: {
        ...executionBoundary,
        workbench: {
          root: null,
        } as ExecutionBoundary['workbench'],
      },
    }));

    expect(result.ok).toBe(false);
    expectReasons(result.reasonCodes, ['invalid_execution_boundary']);
  });

  it('rejects local transport with device credentials', () => {
    const result = validateRemoteBoundaryContract({
      ...lanConnection,
      connectionId: 'local',
      kind: 'local',
      credentialKind: 'device_credential',
      baseUrl: 'http://127.0.0.1:14500',
      wsUrl: 'ws://127.0.0.1:14500',
      trustState: 'local',
    }, identity({ connectionKind: 'local', trustState: 'local' }));

    expect(result.ok).toBe(false);
    expectReasons(result.reasonCodes, ['identity_transport_contradiction']);
  });

  it('rejects local transport with a non-loopback base URL', () => {
    const result = validateRemoteBoundaryContract({
      ...lanConnection,
      connectionId: 'local',
      kind: 'local',
      credentialKind: 'loopback_token',
      baseUrl: 'http://100.125.173.118:14500',
      wsUrl: 'ws://100.125.173.118:14500',
      trustState: 'local',
    }, identity({ connectionKind: 'local', credentialKind: 'loopback_token', trustState: 'local' }));

    expect(result.ok).toBe(false);
    expectReasons(result.reasonCodes, ['identity_transport_contradiction']);
  });

  it('rejects a missing identity', () => {
    const result = validateRemoteBoundaryContract(lanConnection, null);

    expect(result.ok).toBe(false);
    expectReasons(result.reasonCodes, ['invalid_identity']);
    expect(result.warningCodes).toEqual([]);
  });
});
