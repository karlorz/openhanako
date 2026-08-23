import { describe, expect, it } from 'vitest';

import { HanaHttpError } from '../../services/hana-http-error';
import { remoteRecoveryCodesForConnection, remoteRecoveryForStartupFailure } from '../../services/remote-connection-recovery';
import { RemoteBoundaryContractError } from '../../services/remote-boundary-contract';

const lanConnection = {
  connectionId: 'lan:a',
  kind: 'lan' as const,
  serverId: 'server',
  studioId: 'studio',
  label: 'Remote',
  baseUrl: 'http://example',
  wsUrl: 'ws://example',
  token: 'hana_dev_bad',
  authState: 'paired' as const,
  trustState: 'lan' as const,
  credentialKind: 'device_credential' as const,
  platformAccountId: null,
  officialServiceKind: null,
  capabilities: ['chat'],
};

describe('remoteRecoveryCodesForConnection', () => {
  it('returns empty lists when recovery does not match the active connection', () => {
    expect(remoteRecoveryCodesForConnection({
      status: 'identity_failed',
      connectionId: 'lan:a',
      baseUrl: 'http://example',
      reasonCodes: ['invalid_identity'],
      warningCodes: [],
    }, 'lan:b')).toEqual({ reasonCodes: [], warningCodes: [] });
  });

  it('returns recovery codes when connection ids match', () => {
    expect(remoteRecoveryCodesForConnection({
      status: 'compatibility_failed',
      connectionId: 'lan:a',
      baseUrl: 'http://example',
      reasonCodes: ['missing_core_capability'],
      warningCodes: ['missing_optional_capability'],
    }, 'lan:a')).toEqual({
      reasonCodes: ['missing_core_capability'],
      warningCodes: ['missing_optional_capability'],
    });
  });
});

describe('remoteRecoveryForStartupFailure', () => {
  it('classifies structured HTTP 401/403 as auth_failed without parsing message text', () => {
    expect(remoteRecoveryForStartupFailure(
      lanConnection,
      new HanaHttpError({
        status: 401,
        statusText: 'Unauthorized',
        path: '/api/web-auth/login',
      }),
    )).toEqual({
      status: 'identity_failed',
      connectionId: 'lan:a',
      baseUrl: 'http://example',
      reasonCodes: ['auth_failed'],
      warningCodes: [],
    });

    expect(remoteRecoveryForStartupFailure(
      lanConnection,
      new HanaHttpError({
        status: 403,
        statusText: 'Forbidden',
        path: '/api/server/identity',
      })!,
    )!.reasonCodes).toEqual(['auth_failed']);
  });

  it('does not treat plain Error message text as auth_failed', () => {
    // Residual gap closed: recovery must not parse Error.message for auth classification.
    expect(remoteRecoveryForStartupFailure(
      lanConnection,
      new Error('hanaFetch /api/web-auth/login: 401 Unauthorized'),
    )!.reasonCodes).toEqual(['invalid_identity']);
  });

  it('preserves structured reason codes from RemoteBoundaryContractError', () => {
    expect(remoteRecoveryForStartupFailure(
      lanConnection,
      new RemoteBoundaryContractError({
        ok: false,
        reasonCodes: ['identity_transport_contradiction', 'missing_core_capability'],
        warningCodes: ['missing_optional_capability'],
      }),
    )).toEqual({
      status: 'compatibility_failed',
      connectionId: 'lan:a',
      baseUrl: 'http://example',
      reasonCodes: ['identity_transport_contradiction', 'missing_core_capability'],
      warningCodes: ['missing_optional_capability'],
    });
  });

  it('returns null for local-owner connections', () => {
    expect(remoteRecoveryForStartupFailure({
      ...lanConnection,
      connectionId: 'local',
      kind: 'local',
      trustState: 'local',
      credentialKind: 'loopback_token',
    }, new HanaHttpError({ status: 401, path: '/api/web-auth/login' }))).toBeNull();
  });
});
