import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { extractPrimaryJpeg } from '../src/lib/jpeg-container';

/**
 * Android Ultra HDR JPEGs (base image + MPF + appended gain map JPEG), exactly as the phone saved
 * them, upload everywhere a photo is taken. Real isolated D1/R2 with the server's upload check;
 * the stored original is the first image only. Browser analysis only (no cloud AI).
 */
let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000 });

const PHOTOS =
  '.codex-remote-attachments/01a071fe-92b3-77b3-a261-8698b3d3f8e9/04c0e236-9188-46ed-9a61-a8ff283287f8';
const photo = (n: number) => `${PHOTOS}/${n}-Photo-${n}.jpg`;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** What the server must hold for a phone photo: its first image, byte for byte. */
const primary = (n: number) => {
  const bytes = extractPrimaryJpeg(new Uint8Array(readFileSync(photo(n))));
  return { size: bytes.length, sha256: sha256(bytes) };
};
async function storedOriginals(name: string) {
  return (await app.snapshot()).assets.filter(
    (asset: { name: string; kind: string }) => asset.name === name && asset.kind !== 'preview',
  );
}
/** A real file drag as the browser delivers it: a DataTransfer carrying the phone's file. */
async function drop(target: Locator, n: number) {
  const bytes = Array.from(readFileSync(photo(n)));
  const transfer = await target.page().evaluateHandle(
    ({ bytes, name }) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' }));
      return data;
    },
    { bytes, name: `${n}-Photo-${n}.jpg` },
  );
  await target.dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
}
const loaded = (image: Locator) =>
  expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
function watchRemote(page: Page) {
  const remote: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname))
      remote.push(url.href);
  });
  return remote;
}

test('Ultra HDR 사진으로 비교 공간을 만들면 첫 이미지만 저장되고 새로고침 뒤에도 보인다', async ({
  page,
}) => {
  test.setTimeout(240000);
  const remote = watchRemote(page);
  await page.goto('/');
  await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '사진으로 비교 공간 만들기', exact: true });
  await dialog.getByRole('radio', { name: /브라우저 기본 분석/ }).check();
  await dialog.getByTestId('reconstruction-upload').setInputFiles(photo(1));
  await dialog.getByRole('button', { name: '자동 초안 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 180000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 60000 });
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 60000 });
  const project = await app.project();
  const originals = await storedOriginals('1-Photo-1.jpg');
  expect(originals).toHaveLength(1);
  expect(originals[0]).toMatchObject({
    kind: 'original',
    mime: 'image/jpeg',
    width: 960,
    height: 1280,
    ...primary(1),
  });
  expect(project.shared.comparison?.referenceOriginalAssetId).toBe(originals[0].id);
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 60000 });
  await page.screenshot({ path: test.info().outputPath('ultra-hdr-comparison.png') });
  expect(remote).toEqual([]);
});

test('홈 직접 편집 줄에 Ultra HDR 사진을 끌어 놓으면 사진 위 편집이 시작되고 저장된다', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true })).toBeEnabled();
  await page.getByText('기존 사진 위에 직접 편집하기', { exact: true }).click();
  await drop(page.getByTestId('direct-edit-drop'), 2);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 60000 });
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 60000 });
  const originals = await storedOriginals('2-Photo-2.jpg');
  expect(originals).toHaveLength(1);
  expect(originals[0]).toMatchObject({ mime: 'image/jpeg', width: 960, height: 1280, ...primary(2) });
  expect((await app.project()).shared.baseline.originalAssetId).toBe(originals[0].id);
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 60000 });
  await expect(page.getByText(/960 × 1280 px/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('ultra-hdr-direct-edit.png') });
});

test('자재 폼 제품 이미지에 Ultra HDR 사진을 고르거나 끌어 놓아 등록하고 다시 열어도 보인다', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto('/admin/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  await form.getByLabel('상품명').fill('Ultra HDR 제품 사진');
  await form.getByLabel('+ 제품 이미지 올리기', { exact: true }).setInputFiles(photo(3));
  const images = form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true });
  // The form takes new photos once the previous upload has finished.
  await expect(images).toHaveCount(1);
  await drop(form.getByTestId('view-drop'), 4);
  await expect(images).toHaveCount(2);
  await expect(form.getByRole('alert')).toHaveCount(0);
  for (const n of [3, 4]) {
    const stored = await storedOriginals(`${n}-Photo-${n}.jpg`);
    expect(stored.find((asset: { kind: string }) => asset.kind === 'original')).toMatchObject({
      mime: 'image/jpeg',
      ...primary(n),
    });
  }
  await form.getByLabel('기준 단가', { exact: true }).fill('150000');
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.reload();
  const card = page.locator('article').filter({ hasText: 'Ultra HDR 제품 사진' });
  await loaded(card.getByRole('img', { name: 'Ultra HDR 제품 사진', exact: true }));
  await card.screenshot({ path: test.info().outputPath('ultra-hdr-material-card.png') });
});

test('HEIC 사진은 JPG로 저장해 다시 올리라고 안내한다', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '사진으로 비교 공간 만들기', exact: true });
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheicmif1heic'), Buffer.alloc(64)]);
  await dialog
    .getByTestId('reconstruction-upload')
    .setInputFiles({ name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: heic });
  await expect(dialog.getByRole('alert')).toContainText('HEIC 사진은 아직 올릴 수 없어요');
});
