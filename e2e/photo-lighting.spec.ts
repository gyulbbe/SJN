import { test, expect, type Page } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';

/**
 * Photo lighting match (stage 3-3b): a comparison made from a photo stores the photo's light and
 * delit Before colours; the editor switches the light on/off and sets its strength, saved with the
 * shared Before (its undo history), on every render. Browser analysis only (DeepLab, no cloud AI).
 */
let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(240000);

const dialog = (page: Page) => page.getByRole('dialog', { name: '사진으로 비교 공간 만들기', exact: true });
async function canvasPixel(page: Page, x: number, y: number) {
  return page.locator('[data-testid="canvas-frame"] canvas').evaluate(
    (element, point) => {
      const source = element as HTMLCanvasElement;
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(source, 0, 0);
      return [
        ...context.getImageData(Math.floor(point.x * canvas.width), Math.floor(point.y * canvas.height), 1, 1)
          .data,
      ].slice(0, 3);
    },
    { x, y },
  );
}
const lighting = async () => (await app.project()).shared.comparison?.photoLighting;

test('사진으로 만든 비교 공간은 사진 조명을 저장하고, 켜기/끄기·세기가 저장·새로고침에 유지된다', async ({
  page,
}, info) => {
  const remote: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname))
      remote.push(url.href);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
  await dialog(page)
    .getByRole('radio', { name: /브라우저 기본 분석/ })
    .check();
  await dialog(page).getByTestId('reconstruction-upload').setInputFiles('public/examples/bathroom.png');
  await dialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 180000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 60000 });
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 60000 });
  const stored = await lighting();
  expect(stored).toMatchObject({ version: 1, enabled: true, strength: 1 });
  expect(['ceramic', 'achromatic']).toContain(stored!.method);
  // The Before tile made from the photo stores the delit colour, not the photo's.
  const project = await app.project();
  const plane = project.shared.comparison!.review!.planes[0];
  const surface = project.shared.comparison!.before.surfaces.find((s) => s.roomFace === plane.face)!;
  const tile = (await app.versions()).find((v) => v.id === surface.materialVersionId)!;
  expect(tile.color).not.toBe(plane.tile.color);

  const toggle = page.getByRole('checkbox', { name: '사진 조명 맞춤', exact: true });
  await expect(toggle).toBeChecked();
  await expect(page.getByText('원본 사진의 밝기·색온도에 맞춘 화면이에요.', { exact: false })).toBeVisible();
  // Settings change in the After view (Before and split views are read-only); the light applies to both.
  const point = { x: 0.5, y: 0.5 };
  const lit = await canvasPixel(page, point.x, point.y);
  await toggle.uncheck();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  await expect.poll(async () => (await lighting())?.enabled).toBe(false);
  await expect
    .poll(async () => JSON.stringify(await canvasPixel(page, point.x, point.y)))
    .not.toBe(JSON.stringify(lit));
  await expect(page.getByText('자재 본래 색을 중립 조명으로 보여 줘요.')).toBeVisible();
  // Switching it back on restores the same picture.
  await toggle.check();
  await expect.poll(async () => (await lighting())?.enabled).toBe(true);
  await expect
    .poll(async () => JSON.stringify(await canvasPixel(page, point.x, point.y)))
    .toBe(JSON.stringify(lit));
  // Half strength, typed into the number field.
  const strength = page.getByLabel('맞춤 세기 숫자 입력', { exact: true });
  await strength.fill('50');
  await strength.press('Enter');
  await expect.poll(async () => (await lighting())?.strength).toBe(0.5);
  const half = await canvasPixel(page, point.x, point.y);
  expect(half).not.toEqual(lit);
  await page.screenshot({ path: info.outputPath('photo-lighting-desktop.png') });
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 60000 });
  await expect(toggle).toBeChecked();
  await expect(page.getByLabel('맞춤 세기 숫자 입력', { exact: true })).toHaveValue('50');
  // A narrow screen keeps the control inside the page.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  // Narrow editors keep the properties in a panel behind this button.
  if (!(await toggle.isVisible()))
    await page.getByRole('button', { name: '자재 수량·금액 및 속성', exact: true }).click();
  await toggle.scrollIntoViewIfNeeded();
  const box = (await toggle.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390.5);
  await page.screenshot({ path: info.outputPath('photo-lighting-390.png') });
  expect(remote).toEqual([]);
});

test('사진 없는 기본 공간에는 사진 조명 맞춤이 없다', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.getByText('밝기와 색감', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '사진 조명 맞춤', exact: true })).toHaveCount(0);
});
