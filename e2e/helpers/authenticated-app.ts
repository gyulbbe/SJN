import { handleAdminUsers } from '../../src/lib/admin/users';
import { adminProjects, adminProjectAssets, adminProjectMaterials } from '../../src/lib/admin/projects';
import { readAiUsage } from '../../src/lib/admin/ai-usage';
import { diagnosticArchiveRequest } from '../../src/lib/reconstruction/diagnostic-archive-server';
import { serverError } from '../../src/lib/storage/server';
import type { Page, Route } from '@playwright/test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyD1Migrations, allD1Migrations } from '../../tests/helpers/d1-migrations';
import { handleD1Request } from '../../src/lib/d1';
import { publicMaterials, publicImage, publicPlacement } from '../../src/lib/catalog/public';
import type { D1Bindings, D1Resource } from '../../src/lib/d1/types';
import type { MaterialVersion, ProjectDocument } from '../../src/lib/types';

/** Test-only signed-in identity; storage operations use real isolated D1/R2. No Google or remote service. */
export async function authenticatedApp(
  page: Page,
  options: { admin?: boolean; allowModelDownloads?: boolean; signedIn?: boolean } = {},
) {
  const id = crypto.randomUUID();
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("test only"); } }',
      compatibilityDate: '2026-09-01',
      d1Databases: { DB: id },
      r2Buckets: { ASSET_BUCKET: id },
    }),
  );
  const env = {
    DB: await worker.getD1Database('DB'),
    ASSET_BUCKET: await worker.getR2Bucket('ASSET_BUCKET'),
  } as unknown as D1Bindings;
  await applyD1Migrations(env.DB, allD1Migrations);
  await env.DB.prepare(
    'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)',
  )
    .bind(id, '브라우저 검증 회원', id + '@example.test', new Date().toISOString(), new Date().toISOString())
    .run();
  const actor = { id, isAdmin: options.admin ?? true };
  if (actor.isAdmin) await env.DB.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(id).run();
  let signedIn = options.signedIn ?? true;
  const pending = new Set<Promise<void>>();
  async function fulfill(route: Route, response: Response) {
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  }
  const handler = async (route: Route) => {
    const original = route.request(),
      url = new URL(original.url());
    const path = url.pathname;
    if (path === '/api/storage/status')
      return route.fulfill({ json: { mode: 'd1', ready: true, reason: 'ready', authRequired: true } });
    const state = await env.DB.prepare('SELECT status FROM d1_user_management WHERE user_id=?')
      .bind(id)
      .first<{ status: string }>();
    actor.isAdmin = !!(await env.DB.prepare('SELECT user_id FROM admin_roles WHERE user_id=?')
      .bind(id)
      .first());
    if (state?.status === 'suspended')
      return route.fulfill({
        status: 403,
        json: { error: '이용이 정지된 계정이에요.', code: 'account_suspended' },
      });
    if (path === '/api/auth/get-session')
      return route.fulfill({
        json: signedIn ? { user: { id, name: '브라우저 검증 회원', email: id + '@example.test' } } : null,
      });
    if (path === '/api/auth/sign-out') {
      signedIn = false;
      return route.fulfill({ json: { success: true } });
    }
    const request = new Request(original.url(), {
      method: original.method(),
      headers: original.headers(),
      body: ['GET', 'HEAD'].includes(original.method())
        ? undefined
        : original.postDataBuffer()
          ? new Uint8Array(original.postDataBuffer()!)
          : undefined,
    });
    if (path === '/api/catalog/materials') return fulfill(route, await publicMaterials(env));
    if (path === '/api/catalog/images') return fulfill(route, await publicImage(env, request));
    if (path === '/api/catalog/placement') return fulfill(route, await publicPlacement(env, request));
    if (!signedIn) return route.fulfill({ status: 401, json: { error: '로그인이 필요해요.' } });
    if (path === '/api/admin/users') return fulfill(route, await handleAdminUsers(request, env, actor));
    if (path === '/api/admin/projects') return fulfill(route, await adminProjects({ env, actor }, request));
    if (path === '/api/admin/project-assets')
      return fulfill(route, await adminProjectAssets({ env, actor }, request));
    if (path === '/api/admin/project-materials')
      return fulfill(route, await adminProjectMaterials({ env, actor }, request));
    // Isolated tests have no Cloudflare analytics settings, so this is the unconfigured admin path.
    if (path === '/api/admin/ai-usage')
      return fulfill(
        route,
        actor.isAdmin
          ? await readAiUsage({}).then((usage) => Response.json(usage), serverError)
          : Response.json({ error: '관리자만 사용할 수 있어요.' }, { status: 403 }),
      );
    if (path === '/api/catalog/materials') return fulfill(route, await publicMaterials(env));
    if (path === '/api/catalog/images') return fulfill(route, await publicImage(env, request));
    if (path === '/api/reconstruction/diagnostics')
      return fulfill(route, await diagnosticArchiveRequest({ env, actor }, request));
    if (path.startsWith('/api/d1/'))
      return fulfill(
        route,
        await handleD1Request(path.slice('/api/d1/'.length) as D1Resource, request, env, actor),
      );
    return route.fulfill({ status: 503, json: { error: '격리 테스트에서 외부 서비스는 호출하지 않아요.' } });
  };
  await page.context().route('**/api/**', (route) => {
    const job = Promise.resolve(handler(route));
    pending.add(job);
    void job.then(
      () => pending.delete(job),
      () => pending.delete(job),
    );
    return job;
  });
  await page
    .context()
    .route(
      options.allowModelDownloads
        ? /accounts\.google\.com/
        : /huggingface\.co|cdn\.jsdelivr\.net|accounts\.google\.com/,
      (route) => route.abort(),
    );
  return {
    env,
    actor,
    signIn() {
      signedIn = true;
    },
    async project(projectId = page.url().split('/').at(-1)!): Promise<ProjectDocument> {
      const response = await handleD1Request(
        'projects',
        new Request('http://127.0.0.1:3000/api/d1/projects', {
          method: 'POST',
          body: JSON.stringify({ operation: 'load', id: projectId }),
          headers: { 'Content-Type': 'application/json' },
        }),
        env,
        actor,
      );
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    async versions(name?: string): Promise<MaterialVersion[]> {
      const rows = await env.DB.prepare('SELECT payload_json FROM d1_material_versions').all<{
        payload_json: string;
      }>();
      return rows.results
        .map((row) => JSON.parse(row.payload_json) as MaterialVersion)
        .filter((v) => !name || v.name === name);
    },
    async snapshot() {
      const assets = await env.DB.prepare(
        'SELECT metadata_json,content_hash FROM d1_assets ORDER BY id',
      ).all<{ metadata_json: string; content_hash: string }>();
      const materials = await env.DB.prepare('SELECT * FROM d1_materials ORDER BY id').all();
      const versions = await env.DB.prepare('SELECT payload_json FROM d1_material_versions ORDER BY id').all<{
        payload_json: string;
      }>();
      return {
        assets: assets.results.map((row) => ({ ...JSON.parse(row.metadata_json), sha256: row.content_hash })),
        materials: materials.results,
        versions: versions.results.map((row) => JSON.parse(row.payload_json) as MaterialVersion),
      };
    },
    async dispose() {
      // Assertions are finished. Stop routing before unmount aborts outstanding image fetches;
      // Playwright otherwise reports a second fulfill for a route already canceled by teardown.
      await page.context().unrouteAll({ behavior: 'ignoreErrors' });
      if (!page.isClosed()) await page.goto('about:blank', { waitUntil: 'commit', timeout: 10000 });
      await Promise.allSettled([...pending]);
      await worker.dispose();
    },
  };
}
export type AuthenticatedApp = Awaited<ReturnType<typeof authenticatedApp>>;
