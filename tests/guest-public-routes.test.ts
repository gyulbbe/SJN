import { describe, it, expect } from 'vitest';
import { isPublicPage, signInDestinations } from '../src/lib/auth/public-routes';
describe('guest public routes and OAuth return allowlist', () => {
  it('opens only explicit public screens', () => {
    for (const path of ['/', '/materials', '/materials/', '/try', '/login'])
      expect(isPublicPage(path)).toBe(true);
    for (const path of [
      '/projects/123',
      '/admin',
      '/admin/materials',
      '/reconstruction-performance',
      '/try/private',
      '/materials/private',
      '//evil.test',
    ])
      expect(isPublicPage(path)).toBe(false);
  });
  it('returns only fixed same-origin destinations', () => {
    expect(signInDestinations()).toEqual({ callbackURL: '/', errorCallbackURL: '/login?authError=google' });
    expect(signInDestinations({ resumeGuest: true })).toEqual({
      callbackURL: '/try?resume=1',
      errorCallbackURL: '/login?authError=google&resume=guest',
    });
  });
});
