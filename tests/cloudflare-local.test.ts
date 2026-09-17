import { describe, expect, it } from 'vitest';
import { cloudflareRuntimeSource } from '../build/cloudflare-local';
import * as assets from '../src/app/api/cloud/assets/route';
import * as projects from '../src/app/api/cloud/projects/route';
import * as materials from '../src/app/api/cloud/materials/route';
import * as cleanup from '../src/app/api/cloud/cleanup/route';
import * as role from '../src/app/api/cloud/role/route';

describe('D1 runtime boundary', () => {
  it.each([
    ['C:\\dev\\SJN', 'C:/dev/SJN/src/lib/platform/runtime.ts'],
    ['C:/dev/SJN/', 'c:\\dev\\SJN\\src\\lib\\platform\\runtime.ts'],
    ['/workspace/SJN', '/workspace/SJN/src/lib/platform/runtime.ts?worker&v=123'],
  ])('injects only Workers runtime bindings under %s', (root, id) => {
    const source = cloudflareRuntimeSource(id, root);
    expect(source).toContain('cloudflare:workers');
    expect(source).toContain('waitUntil');
    expect(source).not.toContain('APP_ENV');
  });
  it.each([
    '/workspace/SJN/src/lib/platform/runtime-copy.ts',
    '/workspace/other/src/lib/platform/runtime.ts',
    '/workspace/SJN/src/lib/storage/validation.ts',
    '/workspace/SJN/src/app/api/d1/assets/route.ts',
    '/workspace/SJN/src/app/api/cloud/assets/route.ts',
  ])('does not replace another module: %s', (id) => {
    expect(cloudflareRuntimeSource(id, '/workspace/SJN')).toBeNull();
  });
  it.each([assets, projects, materials, cleanup, role])(
    'permanently retires old storage APIs without any storage access',
    async (route) => {
      for (const handler of [
        route.GET,
        route.POST,
        route.PUT,
        route.PATCH,
        route.DELETE,
        route.HEAD,
        route.OPTIONS,
      ]) {
        const response = handler();
        expect(response.status).toBe(410);
        expect(response.headers.get('Cache-Control')).toContain('no-store');
        expect(await response.json()).toEqual({
          error: '이전 저장 API는 종료됐어요. 새로고침한 뒤 Google 계정으로 로그인해 주세요.',
        });
      }
    },
  );
});
