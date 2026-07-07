import { describe, expect, it } from 'vitest';

import { remoteRecoveryCodesForConnection, remoteRecoveryForStartupFailure } from '../../services/remote-connection-recovery';

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

  it('classifies web-auth credential rejection separately from invalid identity', () => {
    expect(remoteRecoveryForStartupFailure({
      connectionId: 'lan:a',
      kind: 'lan',
      serverId: 'server',
      studioId: 'studio',
      label: 'Remote',
      baseUrl: 'http://example',
      wsUrl: 'ws://example',
      token: 'hana_dev_bad',
      authState: 'paired',
      trustState: 'lan',
      credentialKind: 'device_credential',
      platformAccountId: null,
      officialServiceKind: null,
      capabilities: ['chat'],
    }, new Error('hanaFetch /api/web-auth/login: 401 Unauthorized'))).toEqual({
      status: 'identity_failed',
      connectionId: 'lan:a',
      baseUrl: 'http://example',
      reasonCodes: ['auth_failed'],
      warningCodes: [],
    });
  });
});
