import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/repositories/local', () => ({ createLocalRepositories: () => ({ mode: 'local' }) }));
vi.mock('../src/lib/repositories/cloud', () => ({
  createCloudRepositories: (mode: string, userId: string) => ({ mode, userId }),
}));
import { getRepositories, initializeRepositories, resetRepositories } from '../src/lib/repositories';
describe('repository transitions', () => {
  it('retains same identity but requires explicit initialization after leaving a workspace', () => {
    const original = initializeRepositories('d1', 'user-a');
    expect(initializeRepositories('d1', 'user-a')).toBe(original);
    resetRepositories();
    expect(() => getRepositories()).toThrow('작업 공간이 변경');
    expect(() => initializeRepositories('d1')).toThrow('로그인 확인');
    expect(initializeRepositories('d1', 'user-b')).not.toBe(original);
    resetRepositories();
    expect(initializeRepositories('local').mode).toBe('local');
  });
});
