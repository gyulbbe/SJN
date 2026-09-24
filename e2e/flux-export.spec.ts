import { downloadedArtifact } from './helpers/downloaded-artifact';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import type { Page as AuthenticatedPage } from '@playwright/test';
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
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
  const calls: { fields: string[]; seed: string; hash: string }[] = [];
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
    ['image', 'seed'],
    ['image', 'seed'],
  ]);
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
