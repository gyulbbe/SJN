import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { normalizeRoomView } from '../src/lib/room-viewer/view-state';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
import { savedProject, storedProject } from '../tests/helpers/editor-actions';
import type { ProjectDocument } from '../src/lib/types';

let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});

test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(180000);
const form = (page: Page) => page.getByRole('dialog', { name: '벽 구조 편집', exact: true });
const viewer = (page: Page) => page.getByRole('dialog', { name: '공간 둘러보기', exact: true });
const active = (project: ProjectDocument) =>
  project.designs.find((design) => design.id === project.activeDesignId)!;
const main = (page: Page) => page.getByTestId('room-editor-canvas');
async function ready(page: Page, structured = true) {
  await expect(structured ? main(page) : page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 45000 });
  await expect(page.locator('.editor-error')).toHaveCount(0);
  if (structured) await expect(main(page)).toHaveAttribute('aria-busy', 'false', { timeout: 45000 });
}
async function opened(page: Page) {
  await expect(viewer(page)).toBeVisible();
  await expect(page.getByTestId('room-view-viewport')).toHaveAttribute('aria-busy', 'false', {
    timeout: 45000,
  });
  await expect
    .poll(async () => Number(await page.getByTestId('room-view-viewport').getAttribute('data-frame')))
    .toBeGreaterThan(0);
  await expect(viewer(page).getByRole('alert')).toHaveCount(0);
}
async function closeViewer(page: Page) {
  await viewer(page).getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  await expect(viewer(page)).toHaveCount(0);
}
async function editStructure(page: Page) {
  const button = page.getByRole('button', { name: /^벽 구조 편집/ });
  if (!(await button.isVisible()))
    await page
      .getByRole('button', { name: /^(자재·공간 속성|.* 속성)$/ })
      .last()
      .click();
  await button.click();
  await expect(form(page)).toBeVisible();
}
async function diff(a: Buffer, b: Buffer) {
  const images = await Promise.all(
    [a, b].map((image) => sharp(image).resize(240, 160, { fit: 'fill' }).removeAlpha().raw().toBuffer()),
  );
  return (
    images[0].reduce((sum, value, index) => sum + Math.abs(value - images[1][index]), 0) / images[0].length
  );
}
function observe(page: Page) {
  const errors: string[] = [],
    denied: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return page
    .context()
    .route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (
        /^https?:$/.test(url.protocol) &&
        (!['localhost', '127.0.0.1'].includes(url.hostname) ||
          /\.(onnx|safetensors)$|\/api\/(ai|reconstruction)/.test(url.pathname))
      ) {
        denied.push(url.href);
        return route.abort();
      }
      return route.fallback();
    })
    .then(() => ({ errors, denied }));
}
// Explicit author-created test product, in the disposable browser context only.
async function seedProduct(page: Page) {
  await page.evaluate(
    async ({ name, code, file, description }) => {
      const api = async (path: string, body: FormData | object) => {
        const response = await fetch(
          '/api/d1/' + path,
          body instanceof FormData
            ? { method: 'POST', body }
            : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        );
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      };
      const canvas = document.createElement('canvas');
      canvas.width = 180;
      canvas.height = 260;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#e74177';
      ctx.fillRect(30, 10, 120, 240);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!), 'image/png'),
      );
      const assetId = crypto.randomUUID();
      const form = new FormData();
      form.set(
        'metadata',
        JSON.stringify({
          id: assetId,
          name: file,
          mime: 'image/png',
          size: blob.size,
          width: 180,
          height: 260,
          kind: 'product',
          createdAt: new Date().toISOString(),
        }),
      );
      form.set('file', blob, file);
      await api('assets', form);
      await api('materials', {
        operation: 'create',
        input: {
          name,
          code,
          description,
          category: 'basin',
          scope: 'shared',
          brand: '',
          color: '',
          finish: '',
          catalog: { colorIds: [], compositionIds: [], finishIds: [] },
          widthMm: 500,
          heightMm: 750,
          depthMm: 450,
          usage: 'both',
          installation: 'floor',
          coverAssetId: assetId,
          imageAssetIds: [assetId],
          textureAssetIds: [],
          views: [{ assetId, direction: '정면', anchor: { x: 0.5, y: 0.98 } }],
          defaultGroutWidth: 2,
          defaultGroutColor: '#dddddd',
          defaultPattern: 'grid',
        },
      });
    },
    {
      name: '구조 UI 검증 세면대',
      code: 'QA-WALL-FEATURE-UI',
      file: '저장·이동 검증 제품.png',
      description: '실제 사진·AI 관측과 무관한 합성 제품',
    },
  );
}
async function start(page: Page, product = false) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await seedTestTiles(page);
  if (product) await seedProduct(page);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정', exact: true })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await ready(page, false);
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '차콜 스톤' }).click();
  await savedProject(page);
  if (product) {
    await page.getByRole('button', { name: '위생도기', exact: true }).click();
    await page.locator('button.material-tile').filter({ hasText: '구조 UI 검증 세면대' }).click();
    await savedProject(page);
  }
  return savedProject(page);
}
async function saveJson(info: TestInfo, name: string, value: unknown) {
  await writeFile(info.outputPath(name + '.json'), JSON.stringify(value, null, 2));
}

test('실제 벽 구조 UI: 유효성·취소·공통 공간보기·이력·저장·마지막 삭제·Before 격리', async ({
  page,
}, info) => {
  const network = await observe(page),
    initial = await start(page);
  const baseline = JSON.stringify(initial.shared.baseline);
  await editStructure(page);
  await form(page).getByRole('button', { name: '벽 홈 추가', exact: true }).click();
  await form(page).getByLabel('벽 안쪽 깊이 (mm)', { exact: true }).fill('0');
  await expect(form(page).getByRole('alert')).toBeVisible();
  await expect(form(page).getByRole('button', { name: '적용하고 공간 보기', exact: true })).toBeDisabled();
  await form(page).getByLabel('벽 안쪽 깊이 (mm)', { exact: true }).fill('200');
  await form(page).getByRole('button', { name: '벽 홈 추가', exact: true }).click();
  await expect(form(page).getByRole('alert')).toContainText('겹치거나');
  await expect(form(page).getByRole('button', { name: '적용하고 공간 보기', exact: true })).toBeDisabled();
  await form(page).getByRole('button', { name: '선택한 구조 삭제', exact: true }).click();
  await expect(form(page).getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('draft-valid.png'), fullPage: true });
  await form(page).getByRole('button', { name: '취소', exact: true }).click();
  expect(await storedProject(page)).toEqual(initial);
  await editStructure(page);
  await form(page).getByRole('button', { name: '벽 홈 추가', exact: true }).click();
  await form(page).getByRole('button', { name: '적용하고 공간 보기', exact: true }).click();
  await opened(page);
  await viewer(page).getByRole('button', { name: 'After', exact: true }).click();
  const added = await savedProject(page, initial.editRevision);
  expect(active(added).scene.wallFeatures).toHaveLength(1);
  expect(active(added).scene.wallFeatures![0]).toMatchObject({ kind: 'closed-niche', source: 'user' });
  expect(JSON.stringify(added.shared.baseline)).toBe(baseline);
  expect(added.shared.comparison).toBe(initial.shared.comparison);
  const viewerAfter = await viewer(page)
    .locator('canvas')
    .screenshot({ path: info.outputPath('viewer-after.png') });
  await viewer(page).getByRole('button', { name: 'Before', exact: true }).click();
  const viewerBefore = await viewer(page)
    .locator('canvas')
    .screenshot({ path: info.outputPath('viewer-before.png') });
  expect(await diff(viewerBefore, viewerAfter)).toBeGreaterThan(1);
  await viewer(page).getByRole('button', { name: 'After', exact: true }).click();
  await closeViewer(page);
  await ready(page);
  const mainAfter = await main(page)
    .locator('canvas')
    .screenshot({ path: info.outputPath('main-after.png') });
  const mainViewerDifference = await diff(mainAfter, viewerAfter);
  expect(mainViewerDifference).toBeLessThan(3);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  const undone = await savedProject(page, added.editRevision);
  expect(active(undone).scene.wallFeatures).toBeUndefined();
  await ready(page, false);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  const redone = await savedProject(page, undone.editRevision);
  expect(active(redone).scene.wallFeatures).toEqual(active(added).scene.wallFeatures);
  await ready(page);
  const beforeReload = await main(page)
    .locator('canvas')
    .screenshot({ path: info.outputPath('before-reload.png') });
  await page.reload();
  await ready(page);
  const reloaded = await savedProject(page);
  expect(active(reloaded).scene).toEqual(active(redone).scene);
  expect(reloaded.roomView).toEqual(redone.roomView);
  const afterReload = await main(page)
    .locator('canvas')
    .screenshot({ path: info.outputPath('after-reload.png') });
  expect(await diff(beforeReload, afterReload)).toBeLessThan(0.1);
  await editStructure(page);
  await form(page).getByRole('combobox', { name: '형태', exact: true }).selectOption('floor-alcove');
  await expect(form(page).getByLabel('높이 (mm)', { exact: true })).toHaveCount(0);
  await form(page).getByRole('button', { name: '적용하고 공간 보기', exact: true }).click();
  await opened(page);
  const alcove = await savedProject(page, reloaded.editRevision);
  expect(active(alcove).scene.wallFeatures![0].kind).toBe('floor-alcove');
  expect(Object.hasOwn(active(alcove).scene.wallFeatures![0], 'heightMm')).toBe(false);
  await page.screenshot({ path: info.outputPath('alcove-viewer.png'), fullPage: true });
  await closeViewer(page);
  await ready(page);
  await editStructure(page);
  await form(page).getByRole('button', { name: '선택한 구조 삭제', exact: true }).click();
  await form(page).getByRole('button', { name: '적용하고 공간 보기', exact: true }).click();
  await opened(page);
  const removed = await savedProject(page, alcove.editRevision);
  expect(Object.hasOwn(active(removed).scene, 'wallFeatures')).toBe(false);
  expect(JSON.stringify(removed.shared.baseline)).toBe(baseline);
  await closeViewer(page);
  await ready(page, false);
  await page.reload();
  await ready(page, false);
  expect(Object.hasOwn(active(await savedProject(page)).scene, 'wallFeatures')).toBe(false);
  expect(network).toEqual({ errors: [], denied: [] });
  await saveJson(info, 'verification', {
    purpose: 'Authored UI data, not AI recognition evidence',
    initial,
    added,
    undone,
    redone,
    reloaded,
    alcove,
    removed,
    mainViewerMeanRgbDifference: mainViewerDifference,
    reloadMeanRgbDifference: await diff(beforeReload, afterReload),
    network,
  });
});

test('구조 있는 메인 3D: 실제 제품 선택·설치면 드래그·90도·undo/redo·저장', async ({ page }, info) => {
  const network = await observe(page);
  const initial = await start(page, true);
  expect(active(initial).scene.fixtures).toHaveLength(1);
  await editStructure(page);
  await form(page).getByRole('button', { name: '벽 홈 추가', exact: true }).click();
  await form(page).getByRole('button', { name: '적용하고 공간 보기', exact: true }).click();
  await opened(page);
  await closeViewer(page);
  await ready(page);
  const added = await savedProject(page, initial.editRevision);
  const capture = await main(page)
    .locator('canvas')
    .screenshot({ path: info.outputPath('product-before.png') });
  const pixels = await sharp(capture).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const points: [number, number][] = [];
  for (let y = 0; y < pixels.info.height; y++)
    for (let x = 0; x < pixels.info.width; x++) {
      const offset = (y * pixels.info.width + x) * 4;
      const r = pixels.data[offset],
        g = pixels.data[offset + 1],
        b = pixels.data[offset + 2];
      if (r > 100 && r > g * 1.5 && b > g * 1.2) points.push([x, y]);
    }
  expect(points.length).toBeGreaterThan(50);
  const center = points.reduce(
    ([x, y], point) => [x + point[0] / points.length, y + point[1] / points.length],
    [0, 0],
  );
  const box = (await main(page).boundingBox())!;
  const x = box.x + (center[0] / pixels.info.width) * box.width;
  const y = box.y + (center[1] / pixels.info.height) * box.height;
  await page.getByRole('button', { name: '선택 / 이동', exact: true }).click();
  await page.mouse.click(x, y);
  await expect(page.getByRole('heading', { name: '제품 속성', exact: true })).toBeVisible();
  // Escape must retire the captured gesture, not just its current draft.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 22, y - 9, { steps: 3 });
  await page.keyboard.press('Escape');
  await page.mouse.move(x + 55, y - 25, { steps: 3 });
  await page.mouse.up();
  await ready(page);
  const cancelledDrag = await savedProject(page);
  expect(cancelledDrag.editRevision).toBe(added.editRevision);
  expect(active(cancelledDrag).scene.fixtures).toEqual(active(added).scene.fixtures);
  expect(active(cancelledDrag).history).toEqual(active(added).history);
  await saveJson(info, 'cancelled-drag', cancelledDrag);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 45, y - 18, { steps: 5 });
  await page.mouse.up();
  const dragged = await savedProject(page, added.editRevision);
  const beforeFixture = active(added).scene.fixtures[0],
    afterFixture = active(dragged).scene.fixtures[0];
  expect(afterFixture.id).toBe(beforeFixture.id);
  expect(afterFixture.roomPlacement).not.toEqual(beforeFixture.roomPlacement);
  expect(afterFixture.roomPlacement!.face).toBe(beforeFixture.roomPlacement!.face);
  expect(active(dragged).scene.wallFeatures).toEqual(active(added).scene.wallFeatures);
  expect(dragged.shared.baseline).toEqual(added.shared.baseline);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  const undone = await savedProject(page, dragged.editRevision);
  expect(active(undone).scene.fixtures[0]).toEqual(beforeFixture);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  const redone = await savedProject(page, undone.editRevision);
  expect(active(redone).scene.fixtures[0]).toEqual(afterFixture);
  const viewBefore = normalizeRoomView(redone.roomView);
  await page.getByRole('button', { name: '왼쪽 90°', exact: true }).click();
  await expect.poll(async () => (await storedProject(page)).roomView).not.toEqual(viewBefore);
  const rotated = await savedProject(page);
  expect(active(rotated).scene).toEqual(active(redone).scene);
  await page.screenshot({ path: info.outputPath('rotated-ui.png'), fullPage: true });
  await page.getByRole('button', { name: '오른쪽 90°', exact: true }).click();
  await expect.poll(async () => (await storedProject(page)).roomView).toEqual(viewBefore);
  await savedProject(page);
  await page.reload();
  await ready(page);
  const reopened = await savedProject(page);
  expect(active(reopened).scene.fixtures[0]).toEqual(afterFixture);
  expect(active(reopened).scene.wallFeatures).toEqual(active(added).scene.wallFeatures);
  await page.screenshot({ path: info.outputPath('product-reopened.png'), fullPage: true });
  expect(network).toEqual({ errors: [], denied: [] });
  await saveJson(info, 'verification', {
    purpose: 'Authored test image product and structure, not model inference',
    initial,
    added,
    dragged,
    undone,
    redone,
    rotated,
    reopened,
    selectedPixelCount: points.length,
    network,
  });
});
