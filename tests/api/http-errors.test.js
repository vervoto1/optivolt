import { describe, it, expect } from 'vitest';
import { HttpError, toHttpError, assertCondition } from '../../api/http-errors.ts';

describe('HttpError', () => {
  it('defaults message from status code map', () => {
    const err = new HttpError(400);
    expect(err.message).toBe('Bad Request');
  });

  it('supports custom message overriding the default', () => {
    const err = new HttpError(404, 'custom not found');
    expect(err.message).toBe('custom not found');
  });

  it('defaults expose to true for status < 500', () => {
    const err = new HttpError(400);
    expect(err.expose).toBe(true);
  });

  it('defaults expose to false for status >= 500', () => {
    const err = new HttpError(500);
    expect(err.expose).toBe(false);
  });

  it('supports explicit expose override', () => {
    const err = new HttpError(500, 'error', { expose: true });
    expect(err.expose).toBe(true);
  });

  it('supports details option', () => {
    const err = new HttpError(422, 'validation failed', { details: { field: 'email' } });
    expect(err.details).toEqual({ field: 'email' });
  });

  it('has cause option for inner error', () => {
    const inner = new Error('original');
    const err = new HttpError(500, undefined, { cause: inner });
    expect(err.cause).toBe(inner);
  });

  it('has name set to HttpError', () => {
    const err = new HttpError(500);
    expect(err.name).toBe('HttpError');
  });
});

describe('HttpError status codes', () => {
  it('maps 401 to Unauthorized', () => {
    const err = new HttpError(401);
    expect(err.message).toBe('Unauthorized');
    expect(err.statusCode).toBe(401);
  });

  it('maps 403 to Forbidden', () => {
    const err = new HttpError(403);
    expect(err.message).toBe('Forbidden');
    expect(err.statusCode).toBe(403);
  });

  it('maps 422 to Unprocessable Entity', () => {
    const err = new HttpError(422);
    expect(err.message).toBe('Unprocessable Entity');
  });

  it('maps 429 to Too Many Requests', () => {
    const err = new HttpError(429);
    expect(err.message).toBe('Too Many Requests');
  });

  it('maps 502 to Bad Gateway', () => {
    const err = new HttpError(502);
    expect(err.message).toBe('Bad Gateway');
  });

  it('maps 503 to Service Unavailable', () => {
    const err = new HttpError(503);
    expect(err.message).toBe('Service Unavailable');
  });

  it('falls back to "HTTP Error" for unmapped status codes', () => {
    const err = new HttpError(418);
    expect(err.message).toBe('HTTP Error');
  });
});

describe('toHttpError', () => {
  it('passes through existing HttpError unchanged', () => {
    const inner = new HttpError(400, 'bad');
    const result = toHttpError(inner);
    expect(result).toBe(inner);
  });

  it('wraps a regular Error into HttpError with expose=true for status < 500', () => {
    const inner = new Error('something broke');
    const result = toHttpError(inner, 400);
    expect(result).toBeInstanceOf(HttpError);
    expect(result.statusCode).toBe(400);
    expect(result.message).toBe('something broke');
    expect(result.expose).toBe(true);
    expect(result.details).toBeUndefined();
  });

  it('wraps a regular Error into HttpError with details for status >= 500', () => {
    const inner = new Error('server crash');
    const result = toHttpError(inner, 500);
    expect(result).toBeInstanceOf(HttpError);
    expect(result.statusCode).toBe(500);
    // For non-expose errors, fallback uses defaultMessage(statusCode), not error.message
    expect(result.message).toBe('Internal Server Error');
    expect(result.expose).toBe(false);
    expect(result.details).toEqual({ message: 'server crash' });
  });

  it('uses custom message when provided', () => {
    const inner = new Error('original');
    const result = toHttpError(inner, 500, 'custom msg');
    expect(result.message).toBe('custom msg');
  });

  it('wraps a non-Error string into HttpError', () => {
    const result = toHttpError('a string error', 500);
    expect(result).toBeInstanceOf(HttpError);
    expect(result.message).toBe('Internal Server Error');
  });

  it('wraps null into HttpError', () => {
    const result = toHttpError(null, 500);
    expect(result).toBeInstanceOf(HttpError);
    expect(result.message).toBe('Internal Server Error');
  });

  it('wraps non-Error with expose status and preserves message from string', () => {
    const result = toHttpError('validation failed', 400);
    expect(result).toBeInstanceOf(HttpError);
    expect(result.statusCode).toBe(400);
    // For expose=true, error is not instanceof Error (string), so uses defaultMessage
    expect(result.message).toBe('Bad Request');
  });

  it('passes cause through for HttpError re-wraps', () => {
    const inner = new HttpError(400, 'bad', { cause: new Error('root') });
    const result = toHttpError(inner);
    expect(result.cause).toBe(inner.cause);
  });
});

describe('assertCondition', () => {
  it('does not throw when condition is true', () => {
    expect(() => assertCondition(true, 400, 'msg')).not.toThrow();
  });

  it('throws HttpError when condition is false', () => {
    expect(() => assertCondition(false, 404, 'not found')).toThrow(HttpError);
    const err = (() => {
      try { assertCondition(false, 403, 'forbidden'); } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('forbidden');
  });
});
