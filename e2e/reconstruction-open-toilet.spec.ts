import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import type { Page as AuthenticatedPage } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { storedProject, savedProject } from '../tests/helpers/editor-actions';

const authenticatedTests = new WeakMap<AuthenticatedPage, AuthenticatedApp>();
test.beforeEach(async ({ page }) => {
  authenticatedTests.set(page, await authenticatedApp(page));
});
test.afterEach(async ({ page }) => {
  await authenticatedTests.get(page)?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test('actual open toilet and pedestal: inference, empty After, reload and PNG comparison', async ({
  page,
}, info) => {
  test.skip(!process.env.OPEN_TOILET_PHOTO, 'Set OPEN_TOILET_PHOTO to the local regression photograph.');
  test.setTimeout(240000);
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (request) => {
    if (
      /^https?:/.test(request.url()) &&
      !['localhost', '127.0.0.1'].includes(new URL(request.url()).hostname)
    )
      external.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '사진으로 비교 공간 만들기', exact: true });
  // Keep the existing model-specific regression on its original browser baseline.
  await dialog.getByRole('radio', { name: /브라우저 기본 분석/ }).check();
  const buffer = await readFile(process.env.OPEN_TOILET_PHOTO!);
  const inputFormat = (await sharp(buffer).metadata()).format;
  if (!['jpeg', 'png', 'webp'].includes(inputFormat ?? '')) throw new Error('Unsupported test photo');
  await dialog.getByTestId('reconstruction-upload').setInputFiles({
    name: 'open-toilet.' + (inputFormat === 'jpeg' ? 'jpg' : inputFormat),
    mimeType: 'image/' + inputFormat,
    buffer,
  });
  await dialog.getByRole('button', { name: '자동 초안 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 180000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 60000 });
  const project = await savedProject(page),
    comparison = project.shared.comparison!;
  const fixtures = comparison.before.fixtures;
  expect(fixtures.filter((f) => f.reconstruction?.kind === 'toilet')).toHaveLength(1);
  expect(fixtures.filter((f) => f.reconstruction?.kind === 'basin')).toHaveLength(1);
  expect(fixtures.filter((f) => f.reconstruction?.kind === 'mirror')).toHaveLength(0);
  expect(fixtures.find((f) => f.reconstruction?.kind === 'basin')?.reconstruction).toMatchObject({
    basinVariant: 'pedestal',
    widthMm: 600,
    heightMm: 800,
    provenance: { mounting: 'inferred', dimensions: 'default' },
  });
  expect(
    comparison.review!.candidates.some(
      (c) => c.evidence.contextualKind === 'toilet-assembly' && c.status === 'placed',
    ),
  ).toBe(true);
  expect(project.designs[0].scene.fixtures).toEqual([]);
  await info.attach('actual-model-and-rule-result', {
    body: JSON.stringify(comparison, null, 2),
    contentType: 'application/json',
  });
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await page.getByTestId('canvas-frame').screenshot({ path: info.outputPath('actual-before.png') });
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 60000 });
  await savedProject(page);
  expect((await storedProject(page)).shared.comparison!.before).toEqual(comparison.before);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: '이미지 내보내기', exact: true });
  await exportDialog.getByLabel('이미지 구성').selectOption('compare');
  const pending = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  const download = await pending,
    stream = await download.createReadStream();
  if (!stream) throw new Error('PNG download stream unavailable');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const png = Buffer.concat(chunks),
    metadata = await sharp(png).metadata();
  expect(metadata.format).toBe('png');
  expect(metadata.width).toBe(4096);
  await writeFile(info.outputPath('actual-before-empty-after.png'), png);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
