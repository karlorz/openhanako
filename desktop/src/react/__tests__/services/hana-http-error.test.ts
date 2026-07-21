import { describe, expect, it } from 'vitest';

import { HanaHttpError, isHanaHttpError, isHttpAuthFailure } from '../../services/hana-http-error';

describe('HanaHttpError', () => {
  it('exposes structured status for recovery classification', () => {
    const err = new HanaHttpError({
      status: 401,
      statusText: 'Unauthorized',
      path: '/api/web-auth/login',
      detail: 'invalid credential',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HanaHttpError);
    expect(err.status).toBe(401);
    expect(err.path).toBe('/api/web-auth/login');
    expect(err.detail).toBe('invalid credential');
    expect(err.message).toContain('401');
    expect(err.message).toContain('/api/web-auth/login');
  });

  it('classifies only 401/403 as auth failures via status', () => {
    expect(isHttpAuthFailure(new HanaHttpError({ status: 401 }))).toBe(true);
    expect(isHttpAuthFailure(new HanaHttpError({ status: 403 }))).toBe(true);
    expect(isHttpAuthFailure(new HanaHttpError({ status: 500 }))).toBe(false);
    expect(isHttpAuthFailure(new Error('hanaFetch /api/web-auth/login: 401 Unauthorized'))).toBe(false);
    expect(isHttpAuthFailure(null)).toBe(false);
  });

  it('type-guards HanaHttpError instances', () => {
    const err = new HanaHttpError({ status: 404, path: '/api/missing' });
    expect(isHanaHttpError(err)).toBe(true);
    expect(isHanaHttpError(new Error('nope'))).toBe(false);
  });
});
