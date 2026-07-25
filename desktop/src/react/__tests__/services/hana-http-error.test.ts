import { describe, expect, it } from 'vitest';

import {
  HanaHttpError,
  isHanaHttpError,
  isHttpAuthFailure,
  publishHanaHttpError,
  subscribeHanaHttpErrors,
} from '../../services/hana-http-error';

describe('HanaHttpError', () => {
  it('exposes structured status for recovery classification', () => {
    const err = new HanaHttpError({
      status: 401,
      statusText: 'Unauthorized',
      path: '/api/web-auth/login',
      detail: 'invalid credential',
      reason: 'invalid_credential',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HanaHttpError);
    expect(err.status).toBe(401);
    expect(err.path).toBe('/api/web-auth/login');
    expect(err.detail).toBe('invalid credential');
    expect(err.reason).toBe('invalid_credential');
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

  it('normalizes an absent or blank structured reason without changing display detail', () => {
    const err = new HanaHttpError({
      status: 403,
      path: '/api/protected',
      detail: 'localized display text',
      reason: '   ',
    });

    expect(err.reason).toBeNull();
    expect(err.detail).toBe('localized display text');
    expect(err.message).toContain('localized display text');
  });

  it('publishes errors to active listeners and stops after unsubscribe', () => {
    const received: HanaHttpError[] = [];
    const unsubscribe = subscribeHanaHttpErrors(error => received.push(error));
    const error = new HanaHttpError({ status: 403, reason: 'missing_credential' });

    publishHanaHttpError(error);
    unsubscribe();
    publishHanaHttpError(new HanaHttpError({ status: 401 }));

    expect(received).toEqual([error]);
  });

  it('isolates listener failures so every active listener can observe an error', () => {
    const received: HanaHttpError[] = [];
    const unsubscribeThrowing = subscribeHanaHttpErrors(() => {
      throw new Error('listener failure');
    });
    const unsubscribeReceiving = subscribeHanaHttpErrors(error => received.push(error));
    const error = new HanaHttpError({ status: 401 });

    expect(() => publishHanaHttpError(error)).not.toThrow();
    expect(received).toEqual([error]);

    unsubscribeThrowing();
    unsubscribeReceiving();
  });
});
