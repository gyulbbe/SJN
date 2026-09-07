import { getActiveDesign } from '../src/lib/designs';
import { seedTestTiles, uploadBathroomPhoto } from '../tests/helpers/catalog-fixtures.mjs';
import { selectFixture, selectSurface } from '../tests/helpers/editor-actions';
import { test, expect, type Page, type Locator, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import type { FixtureInstance, Point, ProjectDocument } from '../src/lib/types';
import { maskContains } from '../src/lib/render/mask';

test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(180000);
const name = '타일 위 새 2D 세면대';

async function evidence(info: TestInfo, filename: string, body: Buffer, contentType = 'application/json') {
  const directory = resolve('test-results/fixture-tiling-qa');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, filename);
  await writeFile(path, body);
  await info.attach(filename, { path, contentType });
  return path;
}
async function stored(page: Page): Promise<ProjectDocument> {
  return page.evaluate(
    (id) =>
      new Promise<ProjectDocument>((resolve, reject) => {
        const request = indexedDB.open('gongganmiri-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction('projects').objectStore('projects').get(id);
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
          get.onerror = () => {
            db.close();
            reject(get.error);
          };
        };
      }),
    page.url().split('/').at(-1)!,
  );
}
async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await expect(page.locator('.editor-error')).toHaveCount(0);
  return stored(page);
}
async function setRange(locator: Locator, value: string) {
  await locator.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await locator.press('ArrowRight');
  await locator.press('ArrowLeft');
  await locator.blur();
}
async function pointOnCanvas(page: Page, point: Point) {
  const frame = (await page.getByTestId('canvas-frame').boundingBox())!;
  return { x: frame.x + point.x * frame.width, y: frame.y + point.y * frame.height };
}
async function screenshotPixels(page: Page) {
  const png = Buffer.from(
    await page
      .locator('[data-testid="canvas-frame"] canvas')
      .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL('image/png').split(',')[1]),
    'base64',
  );
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    png,
    raw: data,
    width: info.width,
    height: info.height,
    hash: createHash('sha256').update(data).digest('hex'),
  };
}
type Raster = Awaited<ReturnType<typeof screenshotPixels>>;
function patch(raster: Raster, point: Point) {
  const cx = Math.floor(point.x * raster.width),
    cy = Math.floor(point.y * raster.height);
  return [-1, 0, 1].flatMap((dy) =>
    [-1, 0, 1].map((dx) => [
      ...raster.raw.subarray(
        ((cy + dy) * raster.width + cx + dx) * 4,
        ((cy + dy) * raster.width + cx + dx) * 4 + 3,
      ),
    ]),
  );
}
function patchDifference(a: number[][], b: number[][]) {
  return Math.max(...a.flatMap((pixel, i) => pixel.map((value, channel) => Math.abs(value - b[i][channel]))));
}
function pink(pixels: number[][]) {
  return pixels.every(([r, g, b]) => r > 200 && r - g > 130 && b > 60 && b < 180);
}
function imageRectDifference(
  a: Raster,
  b: Raster,
  rect: { left: number; top: number; right: number; bottom: number },
) {
  let max = 0,
    changed = 0,
    total = 0,
    pixels = 0;
  for (let y = Math.floor(rect.top * a.height); y < Math.floor(rect.bottom * a.height); y++)
    for (let x = Math.floor(rect.left * a.width); x < Math.floor(rect.right * a.width); x++) {
      let difference = 0;
      for (let c = 0; c < 3; c++)
        difference = Math.max(
          difference,
          Math.abs(a.raw[(y * a.width + x) * 4 + c] - b.raw[(y * b.width + x) * 4 + c]),
        );
      max = Math.max(max, difference);
      total += difference;
      if (difference > 2) changed++;
      pixels++;
    }
  return { maxDifference: max, meanDifference: total / pixels, changedOverTolerance: changed, pixels };
}
const underlying = (document: ProjectDocument) => ({ ...getActiveDesign(document)!.scene, fixtures: [] });
function productPoint(fixture: FixtureInstance, x: number, y: number): Point {
  return {
    x: fixture.position.x + (x - fixture.anchor.x) * fixture.width,
    y: fixture.position.y + (y - fixture.anchor.y) * fixture.height,
  };
}

async function registerProduct(page: Page) {
  // A transparent, self-authored 2D basin graphic; this test never removes the photographed fixtures.
  const png = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="256"><path d="M24 28Q96 8 168 28L160 65Q150 97 120 102H72Q42 97 32 65Z" fill="#eb247a"/><rect x="72" y="88" width="48" height="153" rx="12" fill="#eb247a"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await dialog.getByLabel('상품명').fill(name);
  await dialog.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await dialog.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await dialog.getByLabel('높이 (mm)', { exact: true }).fill('800');
  await dialog
    .getByLabel('+ 제품 방향 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'new-2d-basin.png', mimeType: 'image/png', buffer: png });
  await expect(
    dialog.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: '대표 이미지로 사용', exact: true }).click();
  await dialog.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: name }).click();
  await expect(page.getByRole('heading', { name: '제품 속성', exact: true })).toBeVisible();
}

test('새 2D 위생도기 이동·복제·삭제 뒤 타일 무늬를 복원하고 저장·내보내기에 반영한다', async ({
  page,
}, info) => {
  const errors: string[] = [],
    checkpoints: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await seedTestTiles(page);
  await uploadBathroomPhoto(page);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '클라우드 화이트' }).click();
  await expect
    .poll(
      async () => getActiveDesign(await stored(page))!.scene.surfaces.filter((s) => s.kind === 'wall').length,
      {
        timeout: 120000,
      },
    )
    .toBe(3);
  await expect(page.getByTestId('auto-detection-status')).toHaveCount(0);
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '라이트 스톤' }).click();
  await expect
    .poll(async () => getActiveDesign(await stored(page))!.scene.surfaces.every((s) => !!s.materialVersionId))
    .toBe(true);
  const tiled = await saved(page);
  expect(getActiveDesign(tiled)!.scene.fixtures).toHaveLength(0);
  expect(getActiveDesign(tiled)!.scene.surfaces.filter((s) => s.kind === 'floor')).toHaveLength(1);
  const baseline = await screenshotPixels(page);
  await evidence(info, 'tiles-before-product.png', baseline.png, 'image/png');
  const sameTiles = (document: ProjectDocument, checkpoint: string) => {
    expect(
      underlying(document),
      `${checkpoint}: all masks, perspective, tile settings, seed and colors stay unchanged`,
    ).toEqual(underlying(tiled));
    checkpoints.push(checkpoint);
  };

  await registerProduct(page);
  await setRange(page.getByLabel('제품 크기', { exact: true }), '0.16');
  await page.getByLabel('기준점 가로 (%)', { exact: true }).fill('50');
  await page.getByLabel('기준점 세로 (%)', { exact: true }).fill('84');
  const placed = await saved(page);
  expect(getActiveDesign(placed)!.scene.fixtures).toHaveLength(1);
  const fixture = getActiveDesign(placed)!.scene.fixtures[0];
  expect(fixture.width).toBeCloseTo(0.16, 5);
  expect(fixture.shadow.opacity).toBeGreaterThan(0);
  sameTiles(placed, 'new product');
  const wallPoint = productPoint(fixture, 0.5, 0.22),
    floorPoint = productPoint(fixture, 0.5, 0.82);
  const transparentPoint = productPoint(fixture, 0.05, 0.2);
  const shadowPoint = { x: fixture.position.x + 0.04, y: fixture.position.y + 0.024 };
  expect(
    getActiveDesign(tiled)!.scene.surfaces.some(
      (s) => s.kind === 'wall' && maskContains(s.mask, wallPoint, 1.5),
    ),
  ).toBe(true);
  expect(
    getActiveDesign(tiled)!.scene.surfaces.some(
      (s) => s.kind === 'floor' && maskContains(s.mask, floorPoint, 1.5),
    ),
  ).toBe(true);
  await expect.poll(async () => pink(patch(await screenshotPixels(page), wallPoint))).toBe(true);
  const placedRaster = await screenshotPixels(page);
  expect(pink(patch(placedRaster, floorPoint))).toBe(true);
  expect(
    patchDifference(patch(baseline, transparentPoint), patch(placedRaster, transparentPoint)),
  ).toBeLessThanOrEqual(2);
  const shadowDifference = patchDifference(patch(baseline, shadowPoint), patch(placedRaster, shadowPoint));
  expect(shadowDifference).toBeGreaterThan(5);

  await expect(page.getByRole('button', { name: '가림 브러시', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '선택 / 이동', exact: true }).click();
  const start = await pointOnCanvas(page, floorPoint);
  const end = await pointOnCanvas(page, { x: floorPoint.x + 0.25, y: floorPoint.y + 0.08 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  const moved = await saved(page),
    movedFixture = getActiveDesign(moved)!.scene.fixtures[0];
  expect(movedFixture.position.x).toBeCloseTo(fixture.position.x + 0.25, 3);
  expect(movedFixture.position.y).toBeCloseTo(fixture.position.y + 0.08, 3);
  expect(movedFixture.occlusion).toEqual(fixture.occlusion);
  expect({ ...movedFixture, position: fixture.position, occlusion: fixture.occlusion }).toEqual(fixture);
  expect(moved.editRevision).toBe(placed.editRevision + 1);
  sameTiles(moved, 'mouse move');
  const movedBodyPoint = productPoint(movedFixture, 0.5, 0.22);
  await expect.poll(async () => pink(patch(await screenshotPixels(page), movedBodyPoint))).toBe(true);
  const movedRaster = await screenshotPixels(page);
  const oldPosition = imageRectDifference(baseline, movedRaster, {
    left: 0.385,
    top: 0.5,
    right: 0.615,
    bottom: 0.92,
  });
  expect(oldPosition.maxDifference).toBeLessThanOrEqual(2);
  expect(oldPosition.changedOverTolerance).toBe(0);
  await evidence(info, 'moved-product.png', movedRaster.png, 'image/png');

  await page.getByRole('button', { name: '복제', exact: true }).click();
  const duplicated = await saved(page);
  expect(getActiveDesign(duplicated)!.scene.fixtures).toHaveLength(2);
  const copy = getActiveDesign(duplicated)!.scene.fixtures.find((f) => f.id !== fixture.id)!;
  expect(copy.occlusion).toEqual(movedFixture.occlusion);
  expect(copy.position.x).toBeCloseTo(movedFixture.position.x + 0.035, 6);
  sameTiles(duplicated, 'duplicate');
  await selectFixture(page, copy);
  await page.getByRole('button', { name: '제품 삭제', exact: true }).click();
  const copyDeleted = await saved(page);
  expect(getActiveDesign(copyDeleted)!.scene).toEqual(getActiveDesign(moved)!.scene);
  await expect.poll(async () => (await screenshotPixels(page)).hash).toBe(movedRaster.hash);
  sameTiles(copyDeleted, 'delete duplicate');
  await selectFixture(page, fixture);
  await page.getByRole('button', { name: '제품 삭제', exact: true }).click();
  const deleted = await saved(page);
  expect(getActiveDesign(deleted)!.scene.fixtures).toHaveLength(0);
  sameTiles(deleted, 'delete all new products');
  await expect.poll(async () => (await screenshotPixels(page)).hash).toBe(baseline.hash);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  expect(getActiveDesign(await saved(page))!.scene).toEqual(getActiveDesign(moved)!.scene);
  await expect.poll(async () => (await screenshotPixels(page)).hash).toBe(movedRaster.hash);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  expect(getActiveDesign(await saved(page))!.scene).toEqual(getActiveDesign(deleted)!.scene);
  await expect.poll(async () => (await screenshotPixels(page)).hash).toBe(baseline.hash);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  expect(getActiveDesign(await saved(page))!.scene).toEqual(getActiveDesign(moved)!.scene);
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  const reloaded = await saved(page);
  expect(getActiveDesign(reloaded)!.scene).toEqual(getActiveDesign(moved)!.scene);
  sameTiles(reloaded, 'save and reload');
  await expect.poll(async () => (await screenshotPixels(page)).hash).toBe(movedRaster.hash);

  // A selected wall still has a selection outline; the removed geometry handles never appear.
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  const back = getActiveDesign(reloaded)!.scene.surfaces.find((s) => s.name === '정면 벽')!;
  await selectSurface(page, back);
  await expect(page.locator(`path[data-entity="${back.id}"]`)).toHaveClass('selected-region');
  await expect(page.locator('[data-handle]')).toHaveCount(0);
  const beforeExport = await screenshotPixels(page);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  const directory = resolve('test-results/fixture-tiling-qa');
  const exportedPath = resolve(directory, 'fixture-on-tiles-export.png');
  await (await download).saveAs(exportedPath);
  const exported = await sharp(exportedPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([exported.info.width, exported.info.height]).toEqual([1536, 1024]);
  const exportHash = createHash('sha256').update(exported.data).digest('hex');
  const exportRaster = { ...beforeExport, raw: exported.data, hash: exportHash };
  const exportVsPreview = imageRectDifference(beforeExport, exportRaster, {
    left: 0,
    top: 0,
    right: 1,
    bottom: 1,
  });
  // Export uses a 2048px atlas while preview uses 512px. Bound the small interpolation
  // difference, then compare identical export quality with and without the selection outline exactly.
  expect(exportVsPreview.maxDifference).toBeLessThanOrEqual(5);
  expect(exportVsPreview.meanDifference).toBeLessThan(0.5);
  expect(pink(patch(exportRaster, movedBodyPoint))).toBe(true);
  await expect(page.getByRole('dialog', { name: '이미지 내보내기', exact: true })).toHaveCount(0);
  await page.getByLabel('타일 적용 위치', { exact: true }).selectOption('all');
  await expect(page.locator('[data-handle]')).toHaveCount(0);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const plainDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  const plainPath = resolve(directory, 'fixture-on-tiles-export-no-selection.png');
  await (await plainDownload).saveAs(plainPath);
  const plainExport = await sharp(plainPath).ensureAlpha().raw().toBuffer();
  expect(createHash('sha256').update(plainExport).digest('hex')).toBe(exportHash);
  expect(getActiveDesign(await stored(page))!.scene).toEqual(getActiveDesign(moved)!.scene);
  expect(errors).toEqual([]);
  await evidence(info, 'fixture-on-tiles-export.png', await readFile(exportedPath), 'image/png');
  await evidence(
    info,
    'fixture-tiling-report.json',
    Buffer.from(
      JSON.stringify(
        {
          scope:
            'Newly registered transparent 2D products only; photographed fixture removal is not performed.',
          wallCount: 3,
          floorCount: 1,
          checkpoints,
          wallPoint,
          floorPoint,
          transparentPoint,
          shadowPoint,
          shadowDifference,
          oldPosition,
          tiledHash: baseline.hash,
          movedHash: movedRaster.hash,
          allProductsDeletedRestoredEntireRaster: true,
          cloneDeletionRestoredMovedRaster: true,
          undoRedoAndReloadRestoredEntireRaster: true,
          exportHash,
          exportVsPreview,
          selectedAndUnselectedExportsHaveIdenticalRGBA: true,
          geometryHandlesAbsent: true,
          exportExcludesSelectionOutline: true,
          unchangedSurfaceMasksPerspectivePhaseAndMaterialVersions: true,
          errors,
        },
        null,
        2,
      ),
    ),
  );
});
