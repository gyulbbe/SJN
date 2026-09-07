import { describe, expect, it } from 'vitest';
import { assertCloudflareLocalMode, cloudflareLocalRouteSource } from '../build/cloudflare-local';

describe('Cloudflare local API boundary', () => {
  it.each([
    ['C:\\dev\\SJN', 'C:/dev/SJN/src/app/api/cloud/assets/route.ts'],
    ['C:/dev/SJN/', 'c:\\dev\\SJN\\src\\app\\api\\cloud\\projects\\route.ts'],
    ['/workspace/SJN', '/workspace/SJN/src/app/api/cloud/role/route.ts'],
    ['/workspace/SJN/', '/workspace/SJN/src/app/api/cloud/assets/route.ts?worker&v=123'],
  ])('replaces cloud API modules under %s', (root, id) => {
    expect(cloudflareLocalRouteSource(id, root)).not.toBeNull();
  });

  it.each([
    '/workspace/SJN/src/app/api/health/route.ts',
    '/workspace/SJN/src/app/api/cloud-copy/assets/route.ts',
    '/workspace/SJN/src/app/api/cloud/assets/page.tsx',
    '/workspace/SJN/src/lib/supabase/validation.ts',
    '/workspace/other/src/app/api/cloud/assets/route.ts',
  ])('preserves unrelated module %s', (id) => {
    expect(cloudflareLocalRouteSource(id, '/workspace/SJN')).toBeNull();
  });

  it('serves the generated module without loading server storage dependencies', async () => {
    const source = cloudflareLocalRouteSource(
      '/workspace/SJN/src/app/api/cloud/assets/route.ts',
      '/workspace/SJN',
    );
    expect(source).not.toBeNull();
    // A data URL cannot resolve project/package imports, so importing the emitted
    // module also verifies that the disabled endpoint is self-contained.
    const url = `data:text/javascript;base64,${Buffer.from(source!).toString('base64')}`;
    const handlers = (await import(/* @vite-ignore */ url)) as Record<string, () => Response>;
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = handlers[method]();
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: '서버 저장 모드가 꺼져 있어요.' });
    }
  });

  it('accepts the default/local mode and rejects incompatible explicit modes', () => {
    expect(() => assertCloudflareLocalMode(undefined)).not.toThrow();
    expect(() => assertCloudflareLocalMode('local')).not.toThrow();
    expect(() => assertCloudflareLocalMode('supabase')).toThrow('local 저장 모드');
    expect(() => assertCloudflareLocalMode('')).toThrow('local 저장 모드');
  });
});
