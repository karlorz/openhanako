import { describe, expect, it } from 'vitest';

import { remoteRecoveryCodesForConnection } from '../../services/remote-connection-recovery';

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