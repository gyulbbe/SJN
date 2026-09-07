import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getActiveDesign } from '../src/lib/designs';
import { seedTestTiles, uploadBathroomPhoto } from '../tests/helpers/catalog-fixtures.mjs';
import { savedProject, storedProject } from '../tests/helpers/editor-actions';

async function editorReady(page: Page) {
  await expect(page).toHaveURL(/\/projects\/[\w-]+$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await expect(page.locator('.editor-error')).toHaveCount(0);
}

function browserDiagnostics(page: Page) {
  const errors: string[] = [];
  const serverWrites: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.context().on('request', (request) => {
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) &&
      /\/api\/cloud\/|supabase\./i.test(request.url())
    )
      serverWrites.push(request.url());
  });
  return { errors, serverWrites };
}

test('로그인 없이 기본 공간을 만들고 크기 수정 내용을 브라우저에 저장·복원한다', async ({ page }, info) => {
  const diagnostics = browserDiagnostics(page);
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByText('사진과 작업은 이 브라우저에 저장돼요.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /로그인|로그아웃/ })).toHaveCount(0);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '공간 크기 설정' });
  await dialog.getByLabel('가로 (m)', { exact: true }).fill('3.2');
  await dialog.getByLabel('깊이 (m)', { exact: true }).fill('2.8');
  await dialog.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await editorReady(page);
  const original = await savedProject(page);
  expect(original.name).toBe('기본 공간');
  expect(getActiveDesign(original)!.scene.room).toMatchObject({
    kind: 'parametric',
    widthMm: 3200,
    depthMm: 2800,
  });
  expect(getActiveDesign(original)!.scene.surfaces).toHaveLength(4);

  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  await dialog.getByLabel('가로 (m)', { exact: true }).fill('3.6');
  await dialog.getByRole('button', { name: '크기 적용', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const edited = await savedProject(page, original.editRevision);
  expect(getActiveDesign(edited)!.scene.room?.widthMm).toBe(3600);
  expect(getActiveDesign(edited)!.scene.room?.depthMm).toBe(2800);

  const projectUrl = page.url();
  await page.reload();
  await editorReady(page);
  expect(getActiveDesign(await savedProject(page))!.scene).toEqual(getActiveDesign(edited)!.scene);
  await page.goto('/');
  await expect(page.getByText('기본 공간', { exact: true })).toBeVisible();
  await page.goto(projectUrl);
  await editorReady(page);
  expect((await savedProject(page)).editRevision).toBe(edited.editRevision);
  await page.screenshot({ path: info.outputPath('cloudflare-local-editor.png'), fullPage: true });
  expect(diagnostics.errors).toEqual([]);
  expect(diagnostics.serverWrites).toEqual([]);
});

test('Workers 정적 자산이 실제 WASM·모델 파일의 원본 바이트로 제공된다', async ({ request }) => {
  const paths = [
    'models/tfjs-wasm/tfjs-backend-wasm.wasm',
    'models/tfjs-wasm/tfjs-backend-wasm-simd.wasm',
    'models/tfjs-wasm/tfjs-backend-wasm-threaded-simd.wasm',
    'models/deeplab-ade20k/model.json',
    'models/deeplab-ade20k/group1-shard1of1',
    'examples/bathroom.png',
  ];
  for (const path of paths) {
    const response = await request.get(`/${path}`);
    expect(response.status(), path).toBe(200);
    const actual = await response.body();
    const expected = await readFile(resolve('public', path));
    const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    expect(hash(actual), path).toBe(hash(expected));
    if (path.endsWith('.wasm'))
      expect(response.headers()['content-type'], path).toContain('application/wasm');
    if (path.endsWith('.json'))
      expect(response.headers()['content-type'], path).toContain('application/json');
  }
});

test('사용하지 않는 서버 저장 API 5개가 캐시되지 않는 503으로 응답한다', async ({ request }) => {
  const routes = [
    ['assets', 'GET'],
    ['assets', 'POST'],
    ['projects', 'POST'],
    ['materials', 'POST'],
    ['cleanup', 'POST'],
    ['role', 'GET'],
  ] as const;
  for (const [path, method] of routes) {
    const response = await request.fetch(`/api/cloud/${path}`, { method });
    expect(response.status(), `${method} ${path}`).toBe(503);
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(await response.json()).toEqual({ error: '서버 저장 모드가 꺼져 있어요.' });
  }
});

test('배포 번들의 브라우저 Worker가 실제 사진을 분석하고 벽 타일을 저장한다', async ({ page }, info) => {
  const diagnostics = browserDiagnostics(page);
  const workerUrls: string[] = [];
  const modelRequests: string[] = [];
  await page.addInitScript(() => {
    const runtime = window as Window & {
      __cloudflareSmokeWorkerErrors?: { message: string; filename: string; lineno: number; colno: number }[];
    };
    const errors: NonNullable<typeof runtime.__cloudflareSmokeWorkerErrors> = [];
    runtime.__cloudflareSmokeWorkerErrors = errors;
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.addEventListener('error', (event) => {
          errors.push({
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
          });
        });
      }
    };
  });
  page.on('worker', (worker) => workerUrls.push(worker.url()));
  page.context().on('request', (request) => {
    if (/\/models\/(deeplab-ade20k|tfjs-wasm)\//.test(request.url())) modelRequests.push(request.url());
  });
  await page.goto('/');
  await seedTestTiles(page);
  await uploadBathroomPhoto(page);
  await editorReady(page);
  const original = await savedProject(page);
  expect(getActiveDesign(original)!.scene.surfaces).toEqual([]);

  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '차콜 스톤' }).click();
  await expect
    .poll(
      async () =>
        (await page.getByRole('alert').count()) > 0 ||
        getActiveDesign(await storedProject(page))!.scene.surfaces.some(
          (surface) => surface.kind === 'wall' && !!surface.materialVersionId,
        ),
      { timeout: 120000 },
    )
    .toBe(true);
  await info.attach('photo-analysis-diagnostics', {
    body: JSON.stringify(
      {
        ...diagnostics,
        workerUrls,
        modelRequests,
        workerErrors: await page.evaluate(
          () =>
            (window as Window & { __cloudflareSmokeWorkerErrors?: unknown[] }).__cloudflareSmokeWorkerErrors,
        ),
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  expect(await page.getByRole('alert').allTextContents()).toEqual([]);
  await expect(page.getByTestId('auto-detection-status')).toHaveCount(0);
  const analyzed = await savedProject(page, original.editRevision);
  const walls = getActiveDesign(analyzed)!.scene.surfaces.filter((surface) => surface.kind === 'wall');
  expect(walls.length).toBeGreaterThan(0);
  expect(walls.every((surface) => !!surface.materialVersionId)).toBe(true);
  expect(workerUrls.length).toBeGreaterThan(0);
  expect(modelRequests.some((url) => url.endsWith('/model.json'))).toBe(true);
  expect(modelRequests.some((url) => url.endsWith('/group1-shard1of1'))).toBe(true);
  expect(modelRequests.some((url) => url.endsWith('.wasm'))).toBe(true);

  await page.reload();
  await editorReady(page);
  expect(getActiveDesign(await savedProject(page))!.scene).toEqual(getActiveDesign(analyzed)!.scene);
  await page.screenshot({ path: info.outputPath('cloudflare-photo-analysis.png'), fullPage: true });
  expect(diagnostics.errors).toEqual([]);
  expect(diagnostics.serverWrites).toEqual([]);
});
