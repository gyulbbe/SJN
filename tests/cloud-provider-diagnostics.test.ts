import { describe, expect, it } from 'vitest';
import { cloudProviderException } from '../src/lib/reconstruction/cloud-gemma-errors';

describe('bounded Cloudflare provider exception diagnostics', () => {
  it('retains actionable exception details while excluding nested request and stack data', () => {
    const failure = Object.assign(new TypeError('AI binding cannot serialize AbortSignal'), {
      status: 502,
      stack: 'private filesystem path and request context',
      cause: { message: 'private nested cause' },
      request: { authorization: 'private credential', photo: 'private photo bytes' },
    });
    expect(cloudProviderException(failure)).toEqual({
      name: 'TypeError',
      message: 'AI binding cannot serialize AbortSignal',
      status: 502,
    });
  });
  it.each([
    'Bearer private-token',
    'bEaReR private-token',
    'api_key=private-token',
    'api-key: "private-token"',
    'apiToken=private-token',
    'access_token: private-token',
    'oauth-token="private-token"',
    'Authorization: Bearer private-token',
    'authorization="private-token"',
    'secret=private-token',
    '"api_key":"private-token"',
  ])('redacts credential values in provider messages: %s', (credential) => {
    const result = cloudProviderException(
      new Error('Binding rejected request; ' + credential + ' ; retry configuration'),
    );
    expect(result.message).not.toContain('private-token');
    expect(result.message).toContain('[redacted]');
    expect(result.message).toContain('Binding rejected request;');
    expect(result.message).toContain('retry configuration');
  });
  it.each([
    ['Authorization: Basic cHJpdmF0ZTpwYXNzd29yZA==', 'cHJpdmF0ZTpwYXNzd29yZA=='],
    ['Basic cHJpdmF0ZTpwYXNzd29yZA==', 'cHJpdmF0ZTpwYXNzd29yZA=='],
    ['"Authorization":"Basic cHJpdmF0ZTpwYXNzd29yZA=="', 'cHJpdmF0ZTpwYXNzd29yZA=='],
    ['Proxy-Authorization: Basic cHJpdmF0ZTpwYXNzd29yZA==', 'cHJpdmF0ZTpwYXNzd29yZA=='],
    ['X-Auth-Key: private-key-value', 'private-key-value'],
    ['"X-Auth-Key":"private-key-value"', 'private-key-value'],
    ['Cookie: session=private-cookie-value', 'private-cookie-value'],
    ['Cookie: session="private-cookie-value"', 'private-cookie-value'],
    ['Set-Cookie: session="private-cookie-value"; HttpOnly', 'private-cookie-value'],
    ['Set-Cookie: session=private-cookie-value; HttpOnly', 'private-cookie-value'],
    ['"Cookie":"session=private-cookie-value; theme=dark"', 'private-cookie-value'],
    ['secret="private secret with spaces"', 'private secret with spaces'],
    ['Bearer "private-bearer-token"', 'private-bearer-token'],
  ])('redacts %s in both exception names and messages', (credential, secret) => {
    for (const field of ['name', 'message'] as const) {
      const result = cloudProviderException({
        name: 'ProviderError',
        message: 'Binding failed',
        [field]: 'failed; ' + credential + '; retry',
      });
      expect(result[field]).not.toContain(secret);
      expect(result[field]).toContain('[redacted]');
      expect(result[field]).toContain('failed;');
      expect(result[field]).toContain('; retry');
    }
  });
  it('removes every unquoted cookie pair while retaining following failure details', () => {
    const result = cloudProviderException(
      new Error(
        'Binding failed; Cookie: session=private-session; refresh=private-refresh; transport unavailable\nRetry later',
      ),
    );
    expect(result.message).toBe('Binding failed; Cookie: [redacted]; transport unavailable\nRetry later');
  });
  it('redacts mixed quoted and unquoted cookie pairs without removing following prose', () => {
    const result = cloudProviderException(
      new Error(
        'Cookie: session="private first"; refresh=private-second; third="private third"; transport unavailable',
      ),
    );
    expect(result.message).toBe('Cookie: [redacted]; transport unavailable');
  });
  it('preserves ordinary Basic authentication prose and unrelated exception context', () => {
    const message = 'Basic authentication is unsupported; binding.run failed at transport setup.';
    expect(cloudProviderException(new Error(message)).message).toBe(message);
  });
  it('sanitizes inline image bytes in exception names before the name cap', () => {
    expect(
      cloudProviderException({
        name: 'Invalid data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==',
        message: 'Input rejected',
      }),
    ).toEqual({
      name: 'Invalid [image redacted]',
      message: 'Input rejected',
    });
  });
  it('redacts each inline image before capping so useful trailing errors survive large input echoes', () => {
    const firstImage = 'data:image/jpeg;base64,' + 'abcd'.repeat(1500);
    const secondImage = 'DATA:IMAGE/PNG;BASE64,c2Vjb25kcGhvdG8=';
    const result = cloudProviderException(
      new Error('Invalid model input ' + firstImage + ' ' + secondImage + ' : dimension mismatch'),
    );
    expect(result.message).toBe('Invalid model input [image redacted] [image redacted] : dimension mismatch');
    expect(JSON.stringify(result)).not.toContain(firstImage);
    expect(JSON.stringify(result)).not.toContain('c2Vjb25kcGhvdG8');
  });
  it('caps name and message without copying arbitrary exception properties', () => {
    const result = cloudProviderException({
      name: 'N'.repeat(500),
      message: 'M'.repeat(5000),
      extra: 'private attachment',
    });
    expect(result).toEqual({ name: 'N'.repeat(100), message: 'M'.repeat(2000) });
  });
  it.each([400, 401, 429, 503])('retains a finite numeric upstream status %s', (status) => {
    expect(
      cloudProviderException({ name: 'ProviderError', message: 'Provider rejected request', status }),
    ).toEqual({
      name: 'ProviderError',
      message: 'Provider rejected request',
      status,
    });
  });
  it.each(['503', NaN, Infinity, -Infinity, undefined, null])(
    'does not coerce invalid status %s into diagnostics',
    (status) => {
      const result = cloudProviderException({ message: 'Provider rejected request', status });
      expect(result).toEqual({ name: 'Error', message: 'Provider rejected request' });
      expect(() => JSON.stringify(result)).not.toThrow();
    },
  );
  it.each([undefined, null, 'opaque exception', 503, { message: { private: 'payload' }, name: 123 }])(
    'uses safe defaults for unknown exception shapes %j',
    (failure) => {
      expect(cloudProviderException(failure)).toEqual({
        name: 'Error',
        message: 'Unknown provider exception',
      });
    },
  );
});
