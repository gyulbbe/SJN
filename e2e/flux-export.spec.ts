import { downloadedArtifact } from './helpers/downloaded-artifact';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import type { Page as AuthenticatedPage } from '@playwright/test';
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
const authenticatedTests = new WeakMap<AuthenticatedPage, AuthenticatedApp>();
test.beforeEach(async ({ page }) => {
  authenticatedTests.set(page, await authenticatedApp(page));
});
test.afterEach(async ({ page }) => {
  await authenticatedTests.get(page)?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(120000);

test('export converts with klein 4B, downloads PNG, re-generates with a new seed and preserves success on quota errors', async ({
  page,
}, testInfo) => {
  const png = await sharp({ create: { width: 992, height: 672, channels: 3, background: '#b8cbd0' } })
    .png()
    .toBuffer();
  const calls: { fields: string[]; seed: string; hash: string; scene: string }[] = [];
  let fail = false;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/export/photoreal', async (route) => {
    const req = route.request();
    const form = await new Response(new Uint8Array(req.postDataBuffer()!), {
      headers: { 'content-type': req.headers()['content-type'] },
    }).formData();
    calls.push({
      fields: [...form.keys()].sort(),
      seed: String(form.get('seed')),
      scene: String(form.get('scene')),
      hash: createHash('sha256')
        .update(Buffer.from(await (form.get('image') as Blob).arrayBuffer()))
        .digest('hex'),
    });
    if (fail)
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Cloudflare AI 사용 한도를 모두 사용했어요.' }),
      });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });
  const denied = await page.request.post('/api/export/photoreal', {
    headers: { origin: 'https://other.example' },
    data: 'no inference',
  });
  expect(denied.status()).toBe(403);
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  const convert = dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true });
  const regenerate = dialog.getByRole('button', {
    name: 'AI 변환 · flux-2-klein-4b 다시 만들기',
    exact: true,
  });
  const result = dialog.getByAltText('FLUX 4B 현장 사진 변환 결과');
  await expect(convert).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^AI 변환/ })).toHaveCount(1);
  expect(calls).toHaveLength(0);
  await convert.click();
  await expect(dialog.getByRole('button', { name: '4B 변환 중…', exact: true })).toBeDisabled();
  await expect(result).toBeVisible({ timeout: 30000 });
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('link', { name: '4B PNG 저장' }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toContain('flux-2-klein-4b.png');
  expect((await sharp(await downloadedArtifact(download)).metadata()).format).toBe('png');
  fail = true;
  await regenerate.click();
  await expect(dialog.getByRole('alert')).toContainText('한도를 모두 사용');
  await expect(result).toBeVisible();
  expect(calls).toHaveLength(2);
  expect(calls.map((c) => c.fields)).toEqual([
    ['image', 'scene', 'seed'],
    ['image', 'scene', 'seed'],
  ]);
  // The placed-product description travels with every request; an empty base room has none. The
  // input is the room seen from outside with the near walls cut away (no ceiling drawn).
  expect(JSON.parse(calls[0].scene)).toEqual({
    version: 1,
    fixtures: [],
    surfaces: [],
    view: 'cutaway',
  });
  // Converted from the front of the live 3D preview.
  await expect(dialog.getByTestId('flux-view-readout')).toHaveText('정면');
  expect(calls[1].scene).toBe(calls[0].scene);
  await expect(dialog.getByLabel('변환에 전달한 제품')).toContainText('전달할 제품 정보가 없어');
  // Re-generating reuses the captured After image with a fresh seed.
  expect(calls[0].hash).toBe(calls[1].hash);
  expect(calls[0].seed).not.toBe(calls[1].seed);
  await page.screenshot({ path: testInfo.outputPath('flux-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(regenerate).toBeVisible(); // A successful result keeps the explicit re-generate label.
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('flux-mobile.png') });
  // The mobile toolbar moves 내보내기 into 더보기, so reopen from the desktop toolbar.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(page.getByAltText('FLUX 4B 현장 사진 변환 결과')).toHaveCount(0);
  const original = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  expect((await original).suggestedFilename()).toMatch(/After\.png$/);
  expect(calls).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('closing during conversion discards late results and allows a fresh conversion', async ({ page }) => {
  const pending: import('@playwright/test').Route[] = [];
  const png = await sharp({ create: { width: 992, height: 672, channels: 3, background: '#dbcdbc' } })
    .png()
    .toBuffer();
  await page.route('**/api/export/photoreal', (route) => {
    pending.push(route);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  await expect.poll(() => pending.length).toBe(2);
  await pending[0].fulfill({ contentType: 'image/png', body: png }).catch(() => {});
  // The late response from the closed dialog must not appear in the new one.
  await expect(dialog.getByAltText('FLUX 4B 현장 사진 변환 결과')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '4B 변환 중…', exact: true })).toBeDisabled();
  await pending[1].fulfill({ contentType: 'image/png', body: png });
  await expect(dialog.getByAltText('FLUX 4B 현장 사진 변환 결과')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '이미지 다운로드', exact: true })).toBeEnabled();
});

test('server wait shows elapsed seconds, the usual time and a slow notice, never a percentage', async ({
  page,
}, testInfo) => {
  const pending: import('@playwright/test').Route[] = [];
  const png = await sharp({ create: { width: 992, height: 672, channels: 3, background: '#c7d0c4' } })
    .png()
    .toBuffer();
  await page.route('**/api/export/photoreal', (route) => {
    pending.push(route);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  const wait = dialog.getByTestId('server-wait-progress');
  const elapsed = dialog.getByTestId('server-wait-elapsed');
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  // No history in this browser yet: the measured 2026-09-25 time.
  await expect(wait).toContainText('보통 약 9초');
  await expect(wait).toContainText('서버에서 현장 사진처럼 변환하는 중이에요.');
  await expect(wait.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  // Read in the page so the one-second steps are seen as they happen.
  const seen = await elapsed.evaluate(async (element) => {
    const values: string[] = [];
    const end = performance.now() + 3300;
    while (performance.now() < end) {
      const text = element.textContent ?? '';
      if (values.at(-1) !== text) values.push(text);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return values;
  });
  const numbers = seen.map((text) => Number(text.replace('초', '')));
  expect(numbers.length).toBeGreaterThanOrEqual(3);
  numbers.slice(1).forEach((value, index) => expect(value).toBe(numbers[index] + 1));
  await page.screenshot({ path: testInfo.outputPath('flux-wait-desktop.png') });
  await pending[0].fulfill({ contentType: 'image/png', body: png });
  await expect(dialog.getByAltText('FLUX 4B 현장 사진 변환 결과')).toBeVisible();
  await expect(wait).toHaveCount(0);
  const history = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('sjn:server-wait:v1:flux') ?? '[]'),
  );
  expect(history).toHaveLength(1);
  expect(history[0]).toBeGreaterThan(3000);
  const usual = Math.max(1, Math.round(history[0] / 1000));
  // This browser's own time now sets the usual time; going past it says so.
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b 다시 만들기', exact: true }).click();
  await expect.poll(() => pending.length).toBe(2);
  await expect(wait).toContainText(`보통 약 ${usual}초`);
  await expect(wait).toContainText('평소보다 오래 걸리고 있어요.', { timeout: (usual + 4) * 1000 });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await wait.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('flux-wait-390-slow.png') });
  await pending[1].fulfill({ contentType: 'image/png', body: png });
  await expect(wait).toHaveCount(0);
  await expect(dialog.getByAltText('FLUX 4B 현장 사진 변환 결과')).toBeVisible();
});

test('every result is checked once for the placed products; a missing one is reported, never re-generated', async ({
  page,
}, testInfo) => {
  const png = await sharp({ create: { width: 992, height: 672, channels: 3, background: '#c9c3b8' } })
    .png()
    .toBuffer();
  const converts: string[] = [];
  const checks: {
    type: string;
    scene: { version: number; fixtures: Record<string, unknown>[]; walls?: string[] };
  }[] = [];
  let missing = false,
    checkFails = false;
  await page.route('**/api/export/photoreal', async (route) => {
    converts.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });
  await page.route('**/api/export/photoreal/check', async (route) => {
    const req = route.request();
    const form = await new Response(new Uint8Array(req.postDataBuffer()!), {
      headers: { 'content-type': req.headers()['content-type'] },
    }).formData();
    expect([...form.keys()].sort()).toEqual(['image', 'scene']);
    const scene = JSON.parse(String(form.get('scene')));
    checks.push({ type: (form.get('image') as Blob).type, scene });
    if (checkFails)
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Cloudflare AI 사용 한도를 모두 사용했어요.' }),
      });
    await route.fulfill({
      json: {
        fixtures: scene.fixtures.map((f: { kind: string }, i: number) => ({
          index: i + 1,
          kind: f.kind,
          present: missing ? 'no' : 'yes',
          seenAs: missing ? 'other' : f.kind,
        })),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  // One registered product placed in the room, so the result has something to look for.
  const product = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200"><rect x="30" y="15" width="100" height="170" rx="20" fill="#f1f0ec"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill('확인할 세면대');
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('800');
  await form
    .getByLabel('+ 제품 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'basin.png', mimeType: 'image/png', buffer: product });
  await expect(
    form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
  ).toBeVisible();
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '확인할 세면대' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  const result = dialog.getByAltText('FLUX 4B 현장 사진 변환 결과');
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  await expect(dialog.getByText('AI 제품 확인: 배치한 제품 1개가 모두 보여요.')).toBeVisible({
    timeout: 30000,
  });
  await expect(result).toBeVisible();
  await dialog.getByText('AI 제품 확인: 배치한 제품 1개가 모두 보여요.').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('flux-check-ok.png') });
  expect(converts).toHaveLength(1);
  expect(checks).toHaveLength(1);
  // The check gets a JPEG of the result and, per product, its kind and box only.
  expect(checks[0].type).toBe('image/jpeg');
  expect(checks[0].scene.version).toBe(1);
  expect(checks[0].scene.fixtures.map((f) => Object.keys(f).sort())).toEqual([['box', 'face', 'kind']]);
  expect(checks[0].scene.fixtures[0].kind).toBe('basin');
  const regenerate = dialog.getByRole('button', {
    name: 'AI 변환 · flux-2-klein-4b 다시 만들기',
    exact: true,
  });
  missing = true;
  await regenerate.click();
  const warning = dialog.getByRole('alert');
  await expect(warning).toContainText('배치한 제품이 바뀌었을 수 있어요');
  await expect(warning).toContainText('세면대가');
  await expect(warning).toContainText('자동으로 다시 만들지는 않아요');
  await warning.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('flux-check-warning.png') });
  await expect(regenerate).toBeEnabled();
  expect(converts).toHaveLength(2);
  expect(checks).toHaveLength(2);
  // A failed check keeps the result and says so; nothing is retried.
  checkFails = true;
  await regenerate.click();
  await expect(dialog.getByText(/AI 제품 확인을 하지 못했어요\. Cloudflare AI 사용 한도/)).toBeVisible();
  await expect(result).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(regenerate).toBeEnabled();
  expect(converts).toHaveLength(3);
  expect(checks).toHaveLength(3);
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('link', { name: '4B PNG 저장' }).click();
  expect((await sharp(await downloadedArtifact(await downloaded)).metadata()).format).toBe('png');
});

test('result walls get their tile colour back; the AI colours stay one click away with a warning', async ({
  page,
}, testInfo) => {
  let reframe = false;
  const conversions: string[] = [];
  // The mock model answers with the input at result size, warmer and darker (the stage-3 "white
  // walls turn beige" case), or zoomed in (a reframed result).
  await page.route('**/api/export/photoreal', async (route) => {
    const req = route.request();
    const form = await new Response(new Uint8Array(req.postDataBuffer()!), {
      headers: { 'content-type': req.headers()['content-type'] },
    }).formData();
    const input = Buffer.from(await (form.get('image') as Blob).arrayBuffer());
    const { width, height } = await sharp(input).metadata();
    const size = { width: width! * 2, height: height! * 2 };
    const answer = reframe
      ? sharp(
          await sharp(input)
            .extract({
              left: Math.round(width! * 0.15),
              top: Math.round(height! * 0.15),
              width: Math.round(width! * 0.7),
              height: Math.round(height! * 0.7),
            })
            .toBuffer(),
        ).resize(size.width, size.height, { fit: 'fill' })
      : sharp(input)
          .resize(size.width, size.height)
          .recomb([
            [0.95, 0.03, 0],
            [0, 0.93, 0],
            [0, 0, 0.8],
          ]);
    conversions.push(reframe ? 'reframed' : 'warm');
    await route.fulfill({ status: 200, contentType: 'image/png', body: await answer.png().toBuffer() });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await seedTestTiles(page);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정', exact: true })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '클라우드 화이트' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  const result = dialog.getByAltText('FLUX 4B 현장 사진 변환 결과');
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  const note = dialog.getByTestId('flux-color-note');
  // The input also shows the (untiled) floor, which is compared and corrected too.
  await expect(note).toContainText(
    /^벽 타일 색이 원본보다 따뜻하게\(노랗게\).* 바뀌어 원래 자재 색으로 맞췄어요/,
    {
      timeout: 30000,
    },
  );
  // The back wall's centre in the shown image: blue comes back once the warm cast is removed.
  const wall = () =>
    result.evaluate(async (element) => {
      const image = element as HTMLImageElement;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const [r, g, b] = context.getImageData(
        Math.round(canvas.width * 0.5),
        Math.round(canvas.height * 0.4),
        1,
        1,
      ).data;
      return { warmth: r - b, brightness: (r + g + b) / 3 };
    });
  const corrected = await wall();
  const toggle = dialog.getByRole('button', { name: 'AI 원본 색 보기', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('flux-color-corrected.png') });
  const correctedDownload = page.waitForEvent('download');
  await dialog.getByRole('link', { name: '4B PNG 저장' }).click();
  const saved = await correctedDownload;
  expect(saved.suggestedFilename()).toMatch(/flux-2-klein-4b\.png$/);
  expect((await sharp(await downloadedArtifact(saved)).metadata()).format).toBe('png');
  await toggle.click();
  const original = dialog.getByRole('button', { name: '보정한 색 보기', exact: true });
  await expect(original).toHaveAttribute('aria-pressed', 'true');
  const raw = await wall();
  expect(raw.warmth).toBeGreaterThan(corrected.warmth + 15);
  expect(corrected.brightness).toBeGreaterThanOrEqual(raw.brightness);
  const warning = dialog.getByRole('alert');
  await expect(warning).toContainText('벽 타일 색이 원본보다 따뜻하게(노랗게) 바뀌었을 수 있어요.');
  const rawDownload = page.waitForEvent('download');
  await dialog.getByRole('link', { name: '4B PNG 저장' }).click();
  expect((await rawDownload).suggestedFilename()).toMatch(/flux-2-klein-4b-AI원본색\.png$/);
  // A narrow screen keeps the new controls inside the dialog.
  await page.setViewportSize({ width: 390, height: 844 });
  await original.scrollIntoViewIfNeeded();
  const box = (await original.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('flux-color-original-390.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  // A reframed result is neither corrected nor compared, and says so.
  reframe = true;
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b 다시 만들기', exact: true }).click();
  await expect(note).toContainText('AI가 구도를 바꿔 벽·바닥 색을 원본과 비교하지 못했어요', {
    timeout: 30000,
  });
  await expect(dialog.getByRole('button', { name: /색 보기$/ })).toHaveCount(0);
  expect(conversions).toEqual(['warm', 'reframed']);
});

test('the AI input is the outside view turned in the live 3D preview, its white margin comes back; added and moved objects are reported once', async ({
  page,
}, testInfo) => {
  const converts: { hash: string; image: Buffer; scene: { ceiling?: unknown; view?: string } }[] = [];
  const checks: { walls?: string[]; fixtures: { kind: string; face?: string }[] }[] = [];
  const checkImages: Buffer[] = [];
  let answer: 'extras' | 'moved' = 'extras';
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/export/photoreal', async (route) => {
    const req = route.request();
    const form = await new Response(new Uint8Array(req.postDataBuffer()!), {
      headers: { 'content-type': req.headers()['content-type'] },
    }).formData();
    const image = Buffer.from(await (form.get('image') as Blob).arrayBuffer());
    converts.push({
      hash: createHash('sha256').update(image).digest('hex'),
      image,
      scene: JSON.parse(String(form.get('scene'))),
    });
    // Long enough to see the second conversion start over and lock the turning.
    if (answer === 'moved') await new Promise((resolve) => setTimeout(resolve, 1500));
    // The mock model keeps the room and framing (its input at twice the size) but builds a dark
    // "wall" in the white margin on the left: the outside view's old failure.
    const { width, height } = await sharp(image).metadata();
    const wall = await sharp({
      create: {
        width: Math.round(width! * 0.16),
        height: Math.round(height! * 1.2),
        channels: 3,
        background: '#4a3d33',
      },
    })
      .png()
      .toBuffer();
    const body = await sharp(image)
      .resize(width! * 2, height! * 2)
      .composite([{ input: wall, left: Math.round(width! * 0.02), top: Math.round(height! * 0.4) }])
      .png()
      .toBuffer();
    await route.fulfill({ status: 200, contentType: 'image/png', body });
  });
  await page.route('**/api/export/photoreal/check', async (route) => {
    const req = route.request();
    const form = await new Response(new Uint8Array(req.postDataBuffer()!), {
      headers: { 'content-type': req.headers()['content-type'] },
    }).formData();
    const scene = JSON.parse(String(form.get('scene')));
    checks.push(scene);
    checkImages.push(Buffer.from(await (form.get('image') as Blob).arrayBuffer()));
    const face: string = scene.fixtures[0].face;
    await route.fulfill({
      json: {
        fixtures: scene.fixtures.map((f: { kind: string }, i: number) => ({
          index: i + 1,
          kind: f.kind,
          present: answer === 'moved' ? 'no' : 'yes',
          seenAs: answer === 'moved' ? 'none' : f.kind,
        })),
        // The user example: a window and a glass partition nobody placed, or the basin on another wall.
        extras:
          answer === 'moved'
            ? [{ kind: 'basin', place: face === 'left' ? 'right' : 'left' }]
            : [
                { kind: 'window', place: 'right' },
                { kind: 'glassPartition', place: 'middle' },
              ],
        walls: (scene.walls ?? []).map((wall: string) => ({
          face: wall,
          uniformTiles: wall === 'back' ? 'no' : 'yes',
        })),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  const product = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200"><rect x="30" y="15" width="100" height="170" rx="20" fill="#f1f0ec"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill('확인할 세면대');
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('800');
  await form
    .getByLabel('+ 제품 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'basin.png', mimeType: 'image/png', buffer: product });
  await expect(
    form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
  ).toBeVisible();
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '확인할 세면대' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  // A view saved in the space viewer is not used: the AI view starts in front of the room.
  await page.getByRole('button', { name: '공간 둘러보기', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 둘러보기', exact: true })
    .getByRole('button', { name: '왼쪽 90°', exact: true })
    .click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  await page.getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  const picker = dialog.getByRole('group', { name: 'AI 입력 시점' });
  const preview = picker.getByTestId('flux-view-preview');
  const readout = picker.getByTestId('flux-view-readout');
  const orbit = async () => ({
    azimuth: Number(await preview.getAttribute('data-azimuth')),
    elevation: Number(await preview.getAttribute('data-elevation')),
  });
  const button = (name: string) => picker.getByRole('button', { name, exact: true });
  // Neither the in-room direction controls nor the fixed view chips are left; the saved view is
  // not used: the preview starts in front of the room.
  await expect(dialog.getByRole('button', { name: /5° 돌리기/ })).toHaveCount(0);
  await expect(dialog.getByRole('radio', { name: /방 안 ·|저장한 방 안 시점/ })).toHaveCount(0);
  await expect(preview.locator('canvas')).toHaveCount(1, { timeout: 30000 });
  await expect(readout).toHaveText('정면');
  // Four sides only, 90° at a time: no view from above, no level-again button, no free drag.
  for (const name of ['왼쪽으로 90° 돌리기', '오른쪽으로 90° 돌리기', '정면으로'])
    await expect(button(name)).toBeVisible();
  for (const name of ['위에서 보기', '옆에서 보기']) await expect(button(name)).toHaveCount(0);

  // Buttons turn a quarter at a time around the room, and the view is named.
  const names: string[] = [];
  for (let i = 0; i < 4; i++) {
    await button('오른쪽으로 90° 돌리기').click();
    names.push((await readout.textContent())!);
  }
  expect(names).toEqual(['오른쪽', '뒤', '왼쪽', '정면']);
  await button('왼쪽으로 90° 돌리기').click();
  expect(await orbit()).toEqual({ azimuth: -90, elevation: 0 });
  await expect(readout).toHaveText('왼쪽');
  await button('정면으로').click();
  await expect(readout).toHaveText('정면');
  // Arrow keys do the same; up and down do nothing.
  await preview.focus();
  await page.keyboard.press('ArrowRight');
  await expect(readout).toHaveText('오른쪽');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  await expect(readout).toHaveText('오른쪽');
  expect(await orbit()).toEqual({ azimuth: 90, elevation: 0 });
  await page.keyboard.press('ArrowLeft');
  await expect(readout).toHaveText('정면');
  // Dragging the picture changes neither the heading nor the height.
  const box = (await preview.boundingBox())!;
  const dragBy = async (dx: number, dy: number) => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
    await page.mouse.up();
  };
  await dragBy(-box.width / 4, box.width / 6);
  await dragBy(box.width / 3, -box.height / 3);
  await page.waitForTimeout(200);
  expect(await orbit()).toEqual({ azimuth: 0, elevation: 0 });
  await expect(readout).toHaveText('정면');
  await page.screenshot({ path: testInfo.outputPath('flux-view-front.png') });

  // The chosen view is exactly what the AI receives.
  await button('정면으로').click();
  await button('오른쪽으로 90° 돌리기').click();
  await expect(readout).toHaveText('오른쪽');
  // Wait for the preview frame of this view before reading it.
  await page.waitForTimeout(300);
  const chosen = await preview.screenshot();
  const result = dialog.getByAltText('FLUX 4B 현장 사진 변환 결과');
  const source = dialog.getByAltText('AI 변환 기준 원본');
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  const warning = dialog.getByRole('alert');
  await expect(warning).toContainText(
    '배치하지 않은 물건이 생겼을 수 있어요: 창문(오른쪽 벽), 유리 칸막이(가운데)',
    { timeout: 30000 },
  );
  await expect(warning).toContainText('다시 만들어 보세요. 자동으로 다시 만들지는 않아요.');
  expect(converts).toHaveLength(1);
  expect(checks).toHaveLength(1);
  // The room from outside: said to be a cutaway, and no ceiling is drawn or described.
  expect(converts[0].scene.view).toBe('cutaway');
  expect(converts[0].scene.ceiling).toBeUndefined();
  // The 1024 px capture goes out scaled and padded to the model size; compare its picture area.
  const layout = fluxInputLayout(1024, Math.round((1024 * box.height) / box.width));
  const sent = await sharp(converts[0].image)
    .extract({
      left: Math.round(layout.x),
      top: Math.round(layout.y),
      width: Math.round(layout.contentWidth),
      height: Math.round(layout.contentHeight),
    })
    .png()
    .toBuffer();
  // The walls in view are asked about; the tile-layout answer is kept, not shown (it proved unreliable).
  expect(checks[0].walls!.length).toBeGreaterThan(0);
  await expect(warning).not.toContainText('타일 배열');
  await expect(dialog.getByText('AI 제품 확인: 배치한 제품 1개가 모두 보여요.')).toBeVisible();
  // The mock model built a dark wall in the white margin. The margin is white again in the result
  // shown and in the picture the AI check was asked about; the room is the model's.
  const white = (raw: Buffer) => {
    let count = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 245 && raw[i + 1] > 245 && raw[i + 2] > 245) count++;
    return count / (raw.length / 3);
  };
  const plain = (image: Buffer) => sharp(image).removeAlpha().raw().toBuffer();
  const [sentWhite, checkedWhite] = await Promise.all([
    plain(sent).then(white),
    plain(checkImages[0]).then(white),
  ]);
  const shown = Buffer.from(
    await result.evaluate(async (img: HTMLImageElement) =>
      Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())),
    ),
  );
  const shownWhite = white(await plain(shown));
  testInfo.annotations.push({
    type: 'backdrop',
    description: `input ${sentWhite} · shown ${shownWhite} · checked ${checkedWhite}`,
  });
  expect(sentWhite).toBeGreaterThan(0.3);
  expect(shownWhite).toBeGreaterThan(sentWhite - 0.03);
  expect(checkedWhite).toBeGreaterThan(sentWhite - 0.03);
  // The middle of the fake wall (left margin, halfway down) is white again.
  const { data: shownRaw, info } = await sharp(shown)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const fake = (Math.round(info.height * 0.55) * info.width + Math.round(info.width * 0.1)) * 3;
  expect([...shownRaw.subarray(fake, fake + 3)].every((value) => value > 245)).toBe(true);
  // Composition: the request matches the preview it was sent from, not the front view.
  await button('정면으로').click();
  await page.waitForTimeout(300);
  const front = await preview.screenshot();
  const small = (image: Buffer) =>
    sharp(image).resize(48, 32, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const difference = async (a: Buffer, b: Buffer) => {
    const [x, y] = await Promise.all([small(a), small(b)]);
    let sum = 0;
    for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
    return sum / x.length;
  };
  const same = await difference(sent, chosen);
  const other = await difference(sent, front);
  testInfo.annotations.push({ type: 'preview-difference', description: `same ${same} · front ${other}` });
  expect(same).toBeLessThan(3);
  expect(other).toBeGreaterThan(same * 2);
  // Just turning keeps the result, with a note; turning back to the sent view clears it.
  const turned = dialog.getByTestId('flux-view-turned');
  await expect(turned).toHaveText(
    '시점을 바꿨어요. 다시 변환하면 새 비교로 시작하니 지금 결과는 먼저 저장해 주세요.',
  );
  await expect(result).toBeVisible();
  await expect(source).toBeVisible();
  await button('오른쪽으로 90° 돌리기').click();
  await expect(turned).toHaveCount(0);
  await button('왼쪽으로 90° 돌리기').click();
  await expect(turned).toBeVisible();
  await warning.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('flux-extras-warning.png') });
  // A narrow screen keeps the preview, its controls and every notice inside the dialog, and a
  // touch drag on the preview does not turn the view.
  await page.setViewportSize({ width: 390, height: 844 });
  await preview.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const before = await orbit();
  const touch = (await preview.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const at = (dx: number, dy: number) => [
    { x: touch.x + touch.width / 2 + dx, y: touch.y + touch.height / 2 + dy, id: 1 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0, 0) });
  for (let i = 1; i <= 6; i++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(-6 * i, 6 * i) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect(await orbit()).toEqual(before);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.screenshot({ path: testInfo.outputPath('flux-view-390.png') });
  await warning.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('flux-extras-warning-390.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('link', { name: '4B PNG 저장' }).click();
  expect((await sharp(await downloadedArtifact(await downloaded)).metadata()).format).toBe('png');

  // Converting from another view (the front, where the basin is whole) is another comparison:
  // the fixed source and the result start over.
  await button('정면으로').click();
  await expect(turned).toBeVisible();
  answer = 'moved';
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  await expect(result).toHaveCount(0);
  // Turning is locked only while converting.
  await expect(button('오른쪽으로 90° 돌리기')).toBeDisabled();
  await expect(warning).toContainText('배치한 제품이 바뀌었을 수 있어요', { timeout: 30000 });
  await expect(warning).toContainText(/세면대가 .+에서 .+ 옮겨졌을 수 있어요\./);
  await expect(source).toBeVisible();
  await expect(button('오른쪽으로 90° 돌리기')).toBeEnabled();
  await expect(turned).toHaveCount(0);
  expect(converts).toHaveLength(2);
  expect(checks).toHaveLength(2);
  expect(converts[1].hash).not.toBe(converts[0].hash);
  // The view lives only while the dialog is open.
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(readout).toHaveText('정면');
  expect(errors).toEqual([]);
});

test('composite export (chosen in the dialog): the room goes out empty, our products come back at their render pixels', async ({
  page,
}, testInfo) => {
  const sent: { scene: { fixtures: unknown[]; mode?: string } }[] = [];
  const checks: { fixtures: unknown[]; room?: string }[] = [];
  let shift = 0;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The mock model changes nothing (or moves the room down): its input scaled to twice the size.
  await page.route('**/api/export/photoreal', async (route) => {
    const req = route.request();
    const form = await new Response(new Uint8Array(req.postDataBuffer()!), {
      headers: { 'content-type': req.headers()['content-type'] },
    }).formData();
    sent.push({ scene: JSON.parse(String(form.get('scene'))) });
    const input = Buffer.from(await (form.get('image') as Blob).arrayBuffer());
    const { width, height } = await sharp(input).metadata();
    const scaled = await sharp(input)
      .resize(width! * 2, height! * 2)
      .png()
      .toBuffer();
    const body = await sharp({
      create: { width: width! * 2, height: height! * 2, channels: 3, background: '#ffffff' },
    })
      .composite([{ input: scaled, left: 0, top: shift }])
      .png()
      .toBuffer();
    await route.fulfill({ status: 200, contentType: 'image/png', body });
  });
  await page.route('**/api/export/photoreal/check', async (route) => {
    const req = route.request();
    const form = await new Response(new Uint8Array(req.postDataBuffer()!), {
      headers: { 'content-type': req.headers()['content-type'] },
    }).formData();
    checks.push(JSON.parse(String(form.get('scene'))));
    await route.fulfill({ json: { fixtures: [], extras: [{ kind: 'glassPartition', place: 'middle' }] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  const product = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200"><rect x="30" y="15" width="100" height="170" rx="20" fill="#2f6fb0"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill('합성할 세면대');
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('800');
  await form
    .getByLabel('+ 제품 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'basin.png', mimeType: 'image/png', buffer: product });
  await expect(
    form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
  ).toBeVisible();
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '합성할 세면대' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  // The current method is the default; experiment A and B are one click away.
  const methods = dialog.getByRole('group', { name: '변환 방식' });
  await expect(methods.getByRole('radio')).toHaveCount(4);
  await expect(methods.getByRole('radio', { name: '지금 방식', exact: true })).toBeChecked();
  await expect(dialog.getByTestId('flux-composite-note')).toContainText('제품까지 AI가 다시 그려요');
  await methods.getByText('실험 A · 빈 방 합성', { exact: true }).click();
  await expect(methods.getByRole('radio', { name: '실험 A · 빈 방 합성', exact: true })).toBeChecked();
  await expect(dialog.getByTestId('flux-composite-note')).toContainText('AI에는 제품을 뺀 빈 방');
  const result = dialog.getByAltText('FLUX 4B 현장 사진 변환 결과');
  const source = dialog.getByAltText('AI 변환 기준 원본');
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  const warning = dialog.getByRole('alert');
  await expect(warning).toContainText('배치하지 않은 물건이 생겼을 수 있어요: 유리 칸막이(가운데)', {
    timeout: 30000,
  });
  await expect(warning).not.toContainText('떠 보일');
  // The model got no fixture; the check asked about an empty room.
  expect(sent[0].scene.fixtures).toEqual([]);
  expect(sent[0].scene.mode).toBe('empty-room');
  expect(checks[0]).toMatchObject({ fixtures: [], room: 'empty' });
  // The shown result is on the capture grid and carries the product at the render's pixels (the
  // reference is the full render), though the model's room had none.
  const pixels = (locator: import('@playwright/test').Locator) =>
    locator.evaluate(async (element) => {
      const image = element as HTMLImageElement;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return {
        width: canvas.width,
        height: canvas.height,
        data: [...context.getImageData(0, 0, canvas.width, canvas.height).data],
      };
    });
  const [shown, reference] = await Promise.all([pixels(result), pixels(source)]);
  expect([shown.width, shown.height]).toEqual([reference.width, reference.height]);
  let blue = 0,
    blueKept = 0;
  for (let i = 0; i < reference.data.length; i += 4) {
    if (reference.data[i + 2] <= reference.data[i] + 60) continue;
    blue++;
    const change =
      Math.abs(shown.data[i] - reference.data[i]) + Math.abs(shown.data[i + 2] - reference.data[i + 2]);
    if (change <= 12) blueKept++;
  }
  expect(blue).toBeGreaterThan(100);
  expect(blueKept / blue).toBeGreaterThan(0.95);
  await warning.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('flux-composite.png') });
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('link', { name: '4B PNG 저장' }).click();
  expect((await sharp(await downloadedArtifact(await downloaded)).metadata()).format).toBe('png');
  // The model moved the room down: the product may look afloat, and the dialog says so.
  shift = 24;
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b 다시 만들기', exact: true }).click();
  await expect(warning).toContainText('AI가 방 구도를 바꿔 도기가 떠 보일 수 있어요.', { timeout: 30000 });
  await expect(warning).toContainText('다시 만들어 보세요');
  await page.setViewportSize({ width: 390, height: 844 });
  await warning.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('flux-composite-390.png') });
  expect(sent).toHaveLength(2);
  expect(checks).toHaveLength(2);
  // This browser remembers the method; B sends grey stand-ins and says so.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(methods.getByRole('radio', { name: '실험 A · 빈 방 합성', exact: true })).toBeChecked();
  await methods.getByText('실험 B · 회색 자리 합성', { exact: true }).click();
  await expect(dialog.getByTestId('flux-composite-note')).toContainText('제품 자리는 회색 표시');
  shift = 0;
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  await expect(result).toBeVisible({ timeout: 30000 });
  expect(sent[2].scene).toMatchObject({ fixtures: [], mode: 'placeholders' });
  await expect.poll(() => checks.length).toBe(3);
  expect(checks[2]).toMatchObject({ fixtures: [], room: 'placeholders' });
  // Experiment C with nothing to repaint (a flat product photo is a photograph already): the dialog
  // says so before the click, the room goes out empty once, and no product is sent at all.
  let productCalls = 0;
  await page.route('**/api/export/photoreal/product', async (route) => {
    productCalls++;
    await route.abort();
  });
  await methods.getByText('실험 C · 제품별 다듬기', { exact: true }).click();
  await expect(dialog.getByTestId('flux-composite-note')).toContainText('다듬을 제품이 없어요');
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  await expect(dialog.getByTestId('flux-refine-note')).toContainText('AI가 다듬은 제품이 없어', {
    timeout: 30000,
  });
  expect(sent[3].scene).toMatchObject({ fixtures: [], mode: 'empty-room' });
  expect(productCalls).toBe(0);
  expect(errors).toEqual([]);
});

test('a wall the model drew much darker is put back; the AI colours warn about the lightness', async ({
  page,
}, testInfo) => {
  const conversions: string[] = [];
  // The mock model answers with the input at result size, drawn a lot darker: the lightness case
  // (a charcoal tile drawn mid grey, the other way round), colour untouched.
  await page.route('**/api/export/photoreal', async (route) => {
    const req = route.request();
    const form = await new Response(new Uint8Array(req.postDataBuffer()!), {
      headers: { 'content-type': req.headers()['content-type'] },
    }).formData();
    const input = Buffer.from(await (form.get('image') as Blob).arrayBuffer());
    const { width, height } = await sharp(input).metadata();
    conversions.push('dark');
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: await sharp(input)
        .resize(width! * 2, height! * 2)
        .linear(0.55, 0)
        .png()
        .toBuffer(),
    });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await seedTestTiles(page);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정', exact: true })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '클라우드 화이트' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  const result = dialog.getByAltText('FLUX 4B 현장 사진 변환 결과');
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  const note = dialog.getByTestId('flux-color-note');
  // The shown (corrected) result says what it did, not that the colours "match".
  await expect(note).toContainText(
    /^벽 타일이 원본보다 훨씬 어둡게.* 바뀌어 원래 자재 색·밝기 쪽으로 되돌렸어요/,
    { timeout: 30000 },
  );
  const wall = () =>
    result.evaluate(async (element) => {
      const image = element as HTMLImageElement;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const [r, g, b] = context.getImageData(
        Math.round(canvas.width * 0.5),
        Math.round(canvas.height * 0.4),
        1,
        1,
      ).data;
      return (r + g + b) / 3;
    });
  const corrected = await wall();
  await dialog.getByRole('button', { name: 'AI 원본 색 보기', exact: true }).click();
  const raw = await wall();
  // The darkened wall comes back a good part of the way, never past the render's own light.
  expect(corrected).toBeGreaterThan(raw + 25);
  const warning = dialog.getByRole('alert');
  await expect(warning).toContainText('벽 타일이 원본보다 훨씬 어둡게 바뀌었을 수 있어요.');
  await page.screenshot({ path: testInfo.outputPath('flux-lightness-original.png') });
  expect(conversions).toEqual(['dark']);
});
