import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { savedProject, selectFixture } from '../tests/helpers/editor-actions';
import type { ProjectDocument } from '../src/lib/types';

/**
 * A photo product on the left wall faces into the room by default and, when "보는 방향" says
 * "앞쪽(정면)", the open front: stored only then, undoable, kept over a reload, and drawn that way
 * by the space viewer and the AI export's input (mock FLUX). The 2D editor is not touched.
 */
let app: AuthenticatedApp | undefined;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(240000);
const shots = 'test-results/product-facing/e2e';
mkdirSync(shots, { recursive: true });

/** The product's saturated blue, bounding box of the pixels of that blue in a picture. */
async function blueBox(image: Buffer) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width,
    x1 = -1,
    y0 = info.height,
    y1 = -1,
    pixels = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const o = (y * info.width + x) * 3;
      if (data[o + 2] > 140 && data[o + 2] - data[o] > 70 && data[o + 2] - data[o + 1] > 30) {
        pixels++;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  return pixels ? { width: x1 - x0 + 1, height: y1 - y0 + 1, pixels } : { width: 0, height: 0, pixels: 0 };
}
const facingOf = (project: ProjectDocument) => {
  const design = project.designs.find((d) => d.id === project.activeDesignId) ?? project.designs[0];
  return design.scene.fixtures[0].roomPlacement as { face: string; facing?: string };
};

test('the product faces the wall or the front in the 3D room and the AI input; undo and reload keep it', async ({
  page,
}, testInfo) => {
  const converts: Buffer[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const answer = await sharp({ create: { width: 992, height: 672, channels: 3, background: '#c9c3b8' } })
    .png()
    .toBuffer();
  await page.route('**/api/export/photoreal', async (route) => {
    const req = route.request();
    const form = await new Response(new Uint8Array(req.postDataBuffer()!), {
      headers: { 'content-type': req.headers()['content-type'] },
    }).formData();
    converts.push(Buffer.from(await (form.get('image') as Blob).arrayBuffer()));
    await route.fulfill({ status: 200, contentType: 'image/png', body: answer });
  });
  await page.route('**/api/export/photoreal/check', (route) =>
    route.fulfill({ json: { fixtures: [], extras: [], walls: [] } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  const photo = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200"><rect x="10" y="10" width="140" height="180" rx="14" fill="#1f6fb8"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill('방향 확인 세면대');
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('800');
  await form
    .getByLabel('+ 제품 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'basin.png', mimeType: 'image/png', buffer: photo });
  await expect(
    form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
  ).toBeVisible();
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '방향 확인 세면대' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });

  const direction = page.getByRole('combobox', { name: '제품 보는 방향', exact: true });
  const face = page.getByRole('combobox', { name: '제품 설치 면', exact: true });
  const note = page.getByTestId('facing-note');
  // On the floor the choice is disabled, and says why.
  await expect(face).toHaveValue('floor');
  await expect(direction).toBeDisabled();
  await expect(note).toContainText('왼쪽·오른쪽 벽에서만 고를 수 있어요');
  let project = await savedProject(page);
  const fixtureId = project.designs[0].scene.fixtures[0].id;
  await face.selectOption('left');
  project = await savedProject(page, project.editRevision);
  expect(facingOf(project).face).toBe('left');
  await expect(direction).toBeEnabled();
  await expect(direction).toHaveValue('wall');
  await expect(note).toHaveText('3D 방·AI 변환에서 이 제품이 보는 방향이에요. 2D 화면 모양은 바뀌지 않아요.');
  expect('facing' in facingOf(project)).toBe(false);

  // The space viewer's front view, and the AI input's front, as pictures of the blue product.
  const viewer = page.getByRole('dialog', { name: '공간 둘러보기', exact: true });
  const inViewer = async (name: string) => {
    await page.getByRole('button', { name: '공간 둘러보기', exact: true }).click();
    await expect(viewer).toBeVisible();
    await expect(page.getByTestId('room-view-viewport')).toHaveAttribute('aria-busy', 'false', {
      timeout: 45000,
    });
    await expect
      .poll(async () => Number(await page.getByTestId('room-view-viewport').getAttribute('data-frame')))
      .toBeGreaterThan(0);
    // The default is a before/after split; the product is in the After.
    const frame = Number(await page.getByTestId('room-view-viewport').getAttribute('data-frame'));
    await viewer.getByRole('button', { name: 'After', exact: true }).click();
    await expect
      .poll(async () => Number(await page.getByTestId('room-view-viewport').getAttribute('data-frame')))
      .toBeGreaterThan(frame);
    const image = await viewer.locator('canvas').screenshot({ path: `${shots}/${name}.png` });
    await page.getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
    await expect(viewer).toHaveCount(0);
    return blueBox(image);
  };
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  const inAiInput = async (name: string) => {
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    const before = converts.length;
    await expect(dialog.getByTestId('flux-view-readout')).toHaveText('정면', { timeout: 30000 });
    await dialog.getByRole('button', { name: /^AI 변환 · flux-2-klein-4b/ }).click();
    await expect.poll(() => converts.length, { timeout: 45000 }).toBe(before + 1);
    await expect(dialog.getByAltText('FLUX 4B 현장 사진 변환 결과')).toBeVisible({ timeout: 30000 });
    // The fixed comparison picture the conversion started from (the model input, unpadded).
    await dialog.getByAltText('AI 변환 기준 원본').screenshot({ path: `${shots}/${name}.png` });
    const box = await blueBox(converts.at(-1)!);
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    return box;
  };
  const wallViewer = await inViewer('wall-viewer-front');
  const wallInput = await inAiInput('wall-ai-input');
  expect(wallViewer.pixels).toBeGreaterThan(20);
  expect(wallInput.pixels).toBeGreaterThan(20);

  // Choose "앞쪽(정면)": one edit, written only now.
  await selectFixture(page, { id: fixtureId });
  await expect(direction).toHaveValue('wall');
  await direction.selectOption('front');
  project = await savedProject(page, project.editRevision);
  expect(facingOf(project)).toMatchObject({ face: 'left', facing: 'front' });
  const frontViewer = await inViewer('front-viewer-front');
  const frontInput = await inAiInput('front-ai-input');
  testInfo.annotations.push({
    type: 'silhouette',
    description: JSON.stringify({ wallViewer, frontViewer, wallInput, frontInput }),
  });
  // Face-on to the front camera it is several times as wide as turned into the room.
  expect(frontViewer.width).toBeGreaterThanOrEqual(2.5 * wallViewer.width);
  expect(frontInput.width).toBeGreaterThanOrEqual(2.5 * wallInput.width);
  expect(frontViewer.height).toBeGreaterThanOrEqual(wallViewer.height * 0.85);
  expect(frontInput.height).toBeGreaterThanOrEqual(wallInput.height * 0.85);
  expect(converts).toHaveLength(2);

  // The 2D editor shows the same picture and the same size and place either way.
  const box2d = async () =>
    page.locator(`[data-testid="editor-canvas"] [data-entity="${fixtureId}"]`).boundingBox();
  const flat = await box2d();
  await direction.selectOption('wall');
  project = await savedProject(page, project.editRevision);
  expect('facing' in facingOf(project)).toBe(false);
  const flatAgain = await box2d();
  expect(flatAgain).toEqual(flat);

  // Undo and redo are single steps.
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(direction).toHaveValue('front');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(direction).toHaveValue('wall');
  project = await savedProject(page, project.editRevision);
  expect('facing' in facingOf(project)).toBe(false);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await expect(direction).toHaveValue('front');
  project = await savedProject(page, project.editRevision);
  expect(facingOf(project).facing).toBe('front');

  // A reload keeps it, and the 3D room still shows the product face-on.
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  expect(facingOf(await savedProject(page)).facing).toBe('front');
  await selectFixture(page, { id: fixtureId });
  await expect(direction).toHaveValue('front');
  const reloaded = await inViewer('front-viewer-after-reload');
  expect(reloaded.width).toBeGreaterThanOrEqual(2.5 * wallViewer.width);

  // Moving it to the back wall keeps the choice but it has no effect there (disabled, explained);
  // back on the right wall it applies again.
  await face.selectOption('back');
  await expect(direction).toBeDisabled();
  await expect(note).toContainText('왼쪽·오른쪽 벽에서만 고를 수 있어요');
  await face.selectOption('right');
  await expect(direction).toBeEnabled();
  await expect(direction).toHaveValue('front');

  // A narrow screen keeps the property panel (a drawer there) and the new choice inside the page.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '자재 수량·금액 및 속성', exact: true }).click();
  await expect(direction).toBeVisible();
  await direction.scrollIntoViewIfNeeded();
  const select = (await direction.boundingBox())!;
  expect(select.x).toBeGreaterThanOrEqual(0);
  expect(select.x + select.width).toBeLessThanOrEqual(390.5);
  expect(select.height).toBeGreaterThanOrEqual(32);
  expect(
    await page
      .locator('.usage-drawer.open')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${shots}/inspector-390.png` });
  expect(errors).toEqual([]);
});
