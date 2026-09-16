import { afterEach, describe, expect, it, vi } from 'vitest';
import * as inventory from '../src/app/api/reconstruction/local/route';
import * as geometry from '../src/app/api/reconstruction/local/geometry/route';
import * as lab from '../src/app/api/reconstruction-lab/engine/route';

afterEach(() => vi.unstubAllGlobals());
describe('retired local AI endpoints', () => {
  it.each([
    ['inventory', inventory],
    ['geometry', geometry],
    ['lab', lab],
  ] as const)('%s rejects stale clients without invoking local or cloud AI', async (_name, handlers) => {
    const fetcher = vi.fn(() => {
      throw new Error('No inference or forwarding allowed');
    });
    vi.stubGlobal('fetch', fetcher);
    for (const handler of [handlers.GET, handlers.POST]) {
      const response = handler();
      expect(response.status).toBe(410);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Location')).toBeNull();
      expect(await response.json()).toMatchObject({ available: false, code: 'local_ai_retired' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
