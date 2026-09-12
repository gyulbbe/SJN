import { getActiveDesign } from '../src/lib/designs';
import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
import { savedProject, storedProject, selectFixture, selectSurface } from '../tests/helpers/editor-actions';
import type { ProjectDocument, Scene } from '../src/lib/types';

test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(150000);

const material = (page: Page, name: string) => page.locator('button.material-tile').filter({ hasText: name });
const productName = '사용자가 등록한 세면대';
const geometry = (scene: Scene) =>
  scene.surfaces.map(({ materialVersionId, tile, color, ...surface }) => {
    void materialVersionId;
    void tile;
    void color;
    return surface;
  });
function foundations(project: ProjectDocument, original: ProjectDocument) {
  expect(getActiveDesign(project)!.scene.surfaces).toHaveLength(4);
  expect(
    getActiveDesign(project)!
      .scene.surfaces.map((surface) => surface.roomFace)
      .sort(),
  ).toEqual(['back', 'floor', 'left', 'right']);
  expect(geometry(getActiveDesign(project)!.scene)).toEqual(geometry(getActiveDesign(original)!.scene));
  expect(getActiveDesign(project)!.scene.originalAssetId).toBe(
    getActiveDesign(original)!.scene.originalAssetId,
  );
  expect(getActiveDesign(project)!.scene.previewAssetId).toBe(
    getActiveDesign(original)!.scene.previewAssetId,
  );
  expect(project.shared.comparison).toEqual(original.shared.comparison);
}
async function simplifiedControls(page: Page) {
  await expect(page.locator('.layer-item, [data-handle]')).toHaveCount(0);
  for (const name of [
    '영역 사각형',
    '면 추가',
    '다각형 그리기',
    '다각형 완료',
    '보호 영역 그리기',
    '영역 브러시',
    '영역 지우개',
    '가림 브러시',
    '선택 항목 삭제',
    '레이어',
    '바닥 경계 다시 맞추기',
    '벽 경계 다시 맞추기',
    '사진 면 직접 지정',
    '기존 제품 제거 / 배경 복원',
    '보호 초기화',
    '원본 배경',
  ])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '레이어', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('실측 치수 확인', { exact: true })).toHaveCount(0);
}
async function ready(page: Page) {
  await expect(page).toHaveURL(/\/projects\/[\w-]+$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await savedProject(page);
}
async function canvasHash(page: Page) {
  const png = await page
    .locator('[data-testid="canvas-frame"] canvas')
    .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL('image/png').split(',')[1]);
  return createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex');
}
async function originalRendered(page: Page, project: ProjectDocument) {
  const points = getActiveDesign(project)!.scene.surfaces.map((surface) => ({
    x: surface.quad.reduce((sum, point) => sum + point.x, 0) / 4,
    y: surface.quad.reduce((sum, point) => sum + point.y, 0) / 4,
  }));
  const expected = await page.evaluate(
    async ({ id, points, width, height }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('gongganmiri-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const asset = await new Promise<{ blob: Blob }>((resolve, reject) => {
        const request = database.transaction('assets').objectStore('assets').get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      const bitmap = await createImageBitmap(asset.blob),
        canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      return points.map((p) => [
        ...context.getImageData(Math.floor(p.x * width), Math.floor(p.y * height), 1, 1).data,
      ]);
    },
    {
      id: ((value) => value.designs.find((item) => item.id === value.activeDesignId)!)(project).scene
        .previewAssetId,
      points,
      width: Math.min(
        2048,
        ((value) => value.designs.find((item) => item.id === value.activeDesignId)!)(project).scene
          .imageWidth,
      ),
      height: Math.round(
        (Math.min(
          2048,
          ((value) => value.designs.find((item) => item.id === value.activeDesignId)!)(project).scene
            .imageWidth,
        ) *
          ((value) => value.designs.find((item) => item.id === value.activeDesignId)!)(project).scene
            .imageHeight) /
          ((value) => value.designs.find((item) => item.id === value.activeDesignId)!)(project).scene
            .imageWidth,
      ),
    },
  );
  await expect
    .poll(async () =>
      page.locator('[data-testid="canvas-frame"] canvas').evaluate(
        (source, { points, expected }) => {
          const image = source as HTMLCanvasElement,
            canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return Math.max(
            ...points.flatMap((p, index) =>
              [
                ...context.getImageData(Math.floor(p.x * image.width), Math.floor(p.y * image.height), 1, 1)
                  .data,
              ].map((value, channel) => Math.abs(value - expected[index][channel])),
            ),
          );
        },
        { points, expected },
      ),
    )
    .toBeLessThanOrEqual(2);
}
async function addUserProduct(page: Page) {
  const png = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200"><rect x="30" y="15" width="100" height="170" rx="20" fill="#e8275d"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill(productName);
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('800');
  await form
    .getByLabel('+ 제품 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'user-basin.png', mimeType: 'image/png', buffer: png });
  await expect(
    form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
  ).toBeVisible();
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  const previous = await storedProject(page);
  await material(page, productName).click();
  return savedProject(page, previous.editRevision);
}

test('기본 네 면은 삭제할 수 없고 타일과 사용자 제품만 바꾸며 Before·실행 취소·재진입을 유지한다', async ({
  page,
}, info) => {
  const errors: string[] = [],
    models: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/\/models\//, async (route) => {
    models.push(route.request().url());
    await route.abort();
  });
  await page.goto('/');
  await seedTestTiles(page);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await ready(page);
  const initial = await storedProject(page);
  expect(getActiveDesign(initial)!.scene.fixtures).toEqual([]);
  expect(getActiveDesign(initial)!.scene.surfaces.every((surface) => !surface.materialVersionId)).toBe(true);
  await originalRendered(page, initial);
  const originalHash = await canvasHash(page);
  await simplifiedControls(page);
  await expect(page.getByRole('button', { name: '제품 삭제', exact: true })).toHaveCount(0);
  let current = initial;
  for (const surface of getActiveDesign(initial)!.scene.surfaces) {
    await selectSurface(page, surface);
    await simplifiedControls(page);
    await expect(page.getByRole('button', { name: '제품 삭제', exact: true })).toHaveCount(0);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace');
    expect((await storedProject(page)).editRevision).toBe(current.editRevision);
    foundations(await storedProject(page), initial);
  }
  for (const surface of getActiveDesign(initial)!.scene.surfaces) {
    await selectSurface(page, surface);
    await material(page, '차콜 스톤').click();
    current = await savedProject(page, current.editRevision);
    expect(
      getActiveDesign(current)!.scene.surfaces.find((candidate) => candidate.id === surface.id)
        ?.materialVersionId,
    ).toBeTruthy();
    foundations(current, initial);
    await page.getByRole('button', { name: '이 면의 타일 초기화', exact: true }).click();
    current = await savedProject(page, current.editRevision);
    expect(
      getActiveDesign(current)!.scene.surfaces.find((candidate) => candidate.id === surface.id)
        ?.materialVersionId,
    ).toBeUndefined();
    foundations(current, initial);
  }
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await page.getByLabel('타일 적용 위치', { exact: true }).selectOption('all');
  await material(page, '차콜 스톤').click();
  current = await savedProject(page, current.editRevision);
  await selectSurface(
    page,
    getActiveDesign(initial)!.scene.surfaces.find((surface) => surface.roomFace === 'floor')!,
  );
  await material(page, '라이트 스톤').click();
  const tiled = await savedProject(page, current.editRevision);
  expect(getActiveDesign(tiled)!.scene.surfaces.every((surface) => !!surface.materialVersionId)).toBe(true);
  foundations(tiled, initial);
  const tiledHash = await canvasHash(page);
  const placed = await addUserProduct(page);
  expect(getActiveDesign(placed)!.scene.fixtures).toHaveLength(1);
  foundations(placed, initial);
  expect(getActiveDesign(placed)!.scene.surfaces).toEqual(getActiveDesign(tiled)!.scene.surfaces);
  const fixture = getActiveDesign(placed)!.scene.fixtures[0];
  await selectSurface(page, getActiveDesign(tiled)!.scene.surfaces[0]);
  await expect(page.getByRole('button', { name: '제품 삭제', exact: true })).toHaveCount(0);
  await selectFixture(page, fixture);
  await simplifiedControls(page);
  await expect(page.getByRole('button', { name: '제품 삭제', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '제품 삭제', exact: true }).click();
  const deleted = await savedProject(page, placed.editRevision);
  expect(getActiveDesign(deleted)!.scene.fixtures).toEqual([]);
  foundations(deleted, initial);
  expect(getActiveDesign(deleted)!.scene).toEqual(getActiveDesign(tiled)!.scene);
  await expect.poll(() => canvasHash(page)).toBe(tiledHash);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  const undone = await savedProject(page, deleted.editRevision);
  expect(getActiveDesign(undone)!.scene).toEqual(getActiveDesign(placed)!.scene);
  foundations(undone, initial);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  const redone = await savedProject(page, undone.editRevision);
  expect(getActiveDesign(redone)!.scene).toEqual(getActiveDesign(deleted)!.scene);
  foundations(redone, initial);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  const restored = await savedProject(page, redone.editRevision);
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect.poll(() => canvasHash(page)).toBe(originalHash);
  expect((await storedProject(page)).editRevision).toBe(restored.editRevision);
  await page.getByRole('button', { name: 'After', exact: true }).click();
  await page.reload();
  await ready(page);
  const reloaded = await storedProject(page);
  expect(getActiveDesign(reloaded)!.scene).toEqual(getActiveDesign(placed)!.scene);
  foundations(reloaded, initial);
  await selectFixture(page, getActiveDesign(reloaded)!.scene.fixtures[0]);
  await expect(page.getByRole('button', { name: '제품 삭제', exact: true })).toBeEnabled();
  await simplifiedControls(page);
  await page.screenshot({ path: info.outputPath('simple-editor-product.png'), fullPage: true });
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect.poll(() => canvasHash(page)).toBe(originalHash);
  await info.attach('simple-editor-invariants', {
    body: JSON.stringify(
      {
        initialSurfaceIds: getActiveDesign(initial)!.scene.surfaces.map((surface) => surface.id),
        finalSurfaceIds: getActiveDesign(reloaded)!.scene.surfaces.map((surface) => surface.id),
        deletedProducts: getActiveDesign(deleted)!.scene.fixtures.length,
        restoredProductId: getActiveDesign(reloaded)!.scene.fixtures[0].id,
        originalHash,
        tiledHash,
        models,
        errors,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  expect(models).toEqual([]);
  expect(errors).toEqual([]);
});
