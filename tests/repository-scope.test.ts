import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/repositories/cloud', () => ({
  createCloudRepositories: (mode: string, userId: string) => ({ mode, userId }),
}));
import { getRepositories, getRepositoryUserId, initializeRepositories, resetRepositories } from '../src/lib/repositories';
describe('repository transitions', () => {
  it('retains same identity but requires explicit initialization after leaving a workspace', () => {
    const original = initializeRepositories('d1', 'user-a');
    expect(initializeRepositories('d1', 'user-a')).toBe(original);
    expect(getRepositoryUserId()).toBe('user-a');
    resetRepositories();
    expect(getRepositoryUserId()).toBe('');
    expect(() => getRepositories()).toThrow('작업 공간이 변경');
    expect(() => initializeRepositories('d1')).toThrow('로그인 확인');
    expect(initializeRepositories('d1', 'user-b')).not.toBe(original);
    resetRepositories();
    for (const mode of ['local', 'supabase']) {
      // Runtime checks also reject stale/untyped callers.
      expect(() => initializeRepositories(mode as 'd1', 'user-a')).toThrow('D1 저장소만');
    }
    expect(() => getRepositories()).toThrow();
  });
});
