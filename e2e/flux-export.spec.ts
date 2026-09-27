import { downloadedArtifact } from './helpers/downloaded-artifact';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import type { Page as AuthenticatedPage } from '@playwright/test';
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
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
  // The placed-product description travels with every request; an empty base room has none.
  expect(JSON.parse(calls[0].scene)).toEqual({ version: 1, fixtures: [], surfaces: [] });
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
  const checks: { type: string; scene: { version: number; fixtures: Record<string, unknown>[] } }[] = [];
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
  expect(checks[0].scene.fixtures.map((f) => Object.keys(f).sort())).toEqual([['box', 'kind']]);
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
  await expect(note).toContainText(
    '벽 타일 색이 원본보다 따뜻하게(노랗게) 바뀌어 원래 자재 색으로 맞췄어요',
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
