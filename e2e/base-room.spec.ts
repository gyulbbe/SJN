import { getActiveDesign } from '../src/lib/designs';
import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
import type { ProjectDocument } from '../src/lib/types';

test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(90000);

async function records<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(
    (storeName) =>
      new Promise<T[]>((resolve, reject) => {
        const request = indexedDB.open('gongganmiri-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction(storeName).objectStore(storeName).getAll();
          get.onerror = () => {
            db.close();
            reject(get.error);
          };
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
        };
      }),
    store,
  );
}
async function savedProject(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  const id = page.url().split('/').at(-1);
  const project = (await records<ProjectDocument>(page, 'projects')).find((candidate) => candidate.id === id);
  expect(project).toBeDefined();
  return project!;
}
async function editorReady(page: Page) {
  await expect(page).toHaveURL(/\/projects\/[\w-]+$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await expect(page.locator('.editor-error')).toHaveCount(0);
}
let landmarks: { x: number; y: number }[] = [];
async function pixels(page: Page) {
  return page.locator('[data-testid="canvas-frame"] canvas').evaluate((element, points) => {
    const source = element as HTMLCanvasElement;
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(source, 0, 0);
    const radius = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) * 0.003));
    return points.map((point) => {
      const samples = context.getImageData(
        Math.floor(point.x * canvas.width) - radius,
        Math.floor(point.y * canvas.height) - radius,
        radius * 2 + 1,
        radius * 2 + 1,
      ).data;
      const mean = [0, 0, 0, 0];
      for (let offset = 0; offset < samples.length; offset += 4)
        for (let channel = 0; channel < 4; channel++)
          mean[channel] += samples[offset + channel] / (samples.length / 4);
      return mean;
    });
  }, landmarks);
}
const distance = (left: number[], right: number[]) =>
  Math.max(...left.slice(0, 3).map((value, index) => Math.abs(value - right[index])));
const materialButton = (page: Page, name: string) =>
  page.locator('button.material-tile').filter({ hasText: name });

test('기본 공간은 업로드 없이 열리고 네 면에 즉시 타일을 적용하여 저장·비교·출력한다', async ({
  page,
}, testInfo) => {
  const modelRequests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/\/models\//, async (route) => {
    modelRequests.push(route.request().url());
    await route.abort('failed');
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '기본 공간으로 시작', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await editorReady(page);
  const original = await savedProject(page);
  expect(original.name).toBe('기본 공간');
  expect(getActiveDesign(original)!.scene.imageWidth).toBe(4096);
  expect(getActiveDesign(original)!.scene.imageHeight).toBe(2731);
  expect(getActiveDesign(original)!.scene.room).toEqual({
    kind: 'parametric',
    version: 1,
    widthMm: 2400,
    depthMm: 2400,
    heightMm: 2400,
  });
  const center = (points: { x: number; y: number }[]) => ({
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  });
  const face = (name: string) =>
    getActiveDesign(original)!.scene.surfaces.find((surface) => surface.roomFace === name)!;
  landmarks = ['left', 'back', 'right', 'floor'].map((name) => center(face(name).quad));
  landmarks.push(
    center([face('left').quad[0], face('left').quad[1], face('right').quad[0], face('right').quad[1]]),
  );
  expect(getActiveDesign(original)!.scene.surfaces).toHaveLength(4);
  expect(
    getActiveDesign(original)!.scene.surfaces.every(
      (surface) => !surface.materialVersionId && !surface.calibrated,
    ),
  ).toBe(true);
  expect(getActiveDesign(original)!.scene.fixtures).toEqual([]);
  expect(getActiveDesign(original)!.scene.protection).toEqual({ polygon: [], strokes: [] });
  expect(getActiveDesign(original)!.history).toEqual({ past: [], future: [] });
  expect(await records(page, 'materials')).toEqual([]);
  await expect(page.locator('.empty-catalog')).toContainText('등록된 자재가 없어요.');
  const initialPixels = await pixels(page);
  await page
    .locator('[data-testid="canvas-frame"] canvas')
    .screenshot({ path: testInfo.outputPath('base-before.png') });
  const projectUrl = page.url();
  await page.reload();
  await editorReady(page);
  expect(getActiveDesign(await savedProject(page))!.scene).toEqual(getActiveDesign(original)!.scene);

  // Test-only catalog preparation keeps product defaults out of the shipped application.
  await page.goto('/');
  await seedTestTiles(page);
  await page.goto(projectUrl);
  await editorReady(page);
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await materialButton(page, '차콜 스톤').click();
  const walls = await savedProject(page);
  expect(getActiveDesign(walls)!.scene.surfaces.filter((surface) => surface.kind === 'wall')).toHaveLength(3);
  expect(
    getActiveDesign(walls)!
      .scene.surfaces.filter((surface) => surface.kind === 'wall')
      .every((surface) => !!surface.materialVersionId),
  ).toBe(true);
  expect(
    getActiveDesign(walls)!.scene.surfaces.find((surface) => surface.kind === 'floor')?.materialVersionId,
  ).toBeUndefined();
  await expect
    .poll(async () =>
      Math.min(
        ...(await pixels(page)).slice(0, 3).map((pixel, index) => distance(pixel, initialPixels[index])),
      ),
    )
    .toBeGreaterThan(30);
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await materialButton(page, '라이트 스톤').click();
  const allTiled = await savedProject(page);
  expect(getActiveDesign(allTiled)!.scene.surfaces.every((surface) => !!surface.materialVersionId)).toBe(
    true,
  );
  expect(getActiveDesign(allTiled)!.scene.surfaces.map((surface) => surface.id)).toEqual(
    getActiveDesign(original)!.scene.surfaces.map((surface) => surface.id),
  );
  expect(allTiled.editRevision).toBe(original.editRevision + 2);
  expect(getActiveDesign(allTiled)!.history.past).toHaveLength(2);

  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await materialButton(page, '클라우드 화이트').click();
  const updated = await savedProject(page);
  expect(
    getActiveDesign(updated)!
      .scene.surfaces.filter((surface) => surface.kind === 'wall')
      .every(
        (surface) =>
          surface.materialVersionId !==
          getActiveDesign(walls)!.scene.surfaces.find((candidate) => candidate.kind === 'wall')!
            .materialVersionId,
      ),
  ).toBe(true);
  expect(getActiveDesign(updated)!.scene.surfaces.find((surface) => surface.kind === 'floor')).toEqual(
    getActiveDesign(allTiled)!.scene.surfaces.find((surface) => surface.kind === 'floor'),
  );
  const bounds = await page.getByTestId('canvas-frame').boundingBox();
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect
    .poll(async () =>
      Math.max(...(await pixels(page)).map((pixel, index) => distance(pixel, initialPixels[index]))),
    )
    .toBeLessThanOrEqual(2);
  expect(await page.getByTestId('canvas-frame').boundingBox()).toEqual(bounds);
  await page.getByRole('button', { name: 'After', exact: true }).click();
  const afterCompare = await savedProject(page);
  expect(getActiveDesign(afterCompare)!.scene).toEqual(getActiveDesign(updated)!.scene);
  expect(afterCompare.editRevision).toBe(updated.editRevision);
  expect(getActiveDesign(afterCompare)!.history).toEqual(getActiveDesign(updated)!.history);
  await page.reload();
  await editorReady(page);
  expect(getActiveDesign(await savedProject(page))!.scene).toEqual(getActiveDesign(updated)!.scene);
  const afterPixels = await pixels(page);
  await page
    .locator('[data-testid="canvas-frame"] canvas')
    .screenshot({ path: testInfo.outputPath('base-after.png') });
  expect(distance(afterPixels[4], initialPixels[4])).toBeLessThanOrEqual(2);
  await page.screenshot({ path: testInfo.outputPath('base-room-editor.png'), fullPage: true });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  const output = testInfo.outputPath('base-room-after.png');
  await (await downloaded).saveAs(output);
  const image = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  expect(image.info.width).toBe(4096);
  expect(image.info.height).toBe(2731);
  const radius = Math.max(1, Math.round(Math.min(image.info.width, image.info.height) * 0.003));
  landmarks.forEach((point, index) => {
    const mean = [0, 0, 0];
    const cx = Math.floor(point.x * image.info.width),
      cy = Math.floor(point.y * image.info.height);
    for (let y = cy - radius; y <= cy + radius; y++)
      for (let x = cx - radius; x <= cx + radius; x++) {
        const start = (y * image.info.width + x) * image.info.channels;
        for (let channel = 0; channel < 3; channel++)
          mean[channel] += image.data[start + channel] / (radius * 2 + 1) ** 2;
      }
    expect(distance(mean, afterPixels[index])).toBeLessThanOrEqual(5);
  });
  expect(modelRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('공간 치수를 미리 확인하고 유효성 검사·취소 후 원하는 크기로 한 번만 생성한다', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '공간 크기 설정' });
  await expect(dialog.getByLabel('가로 (m)', { exact: true })).toHaveValue('2.4');
  await expect(dialog.getByLabel('깊이 (m)', { exact: true })).toHaveValue('2.4');
  await expect(dialog.getByLabel('높이 (m)', { exact: true })).toHaveValue('2.4');
  await expect(dialog).toContainText('5.76 ㎡');
  const preview = dialog.getByAltText('입력한 크기에 맞춘 빈 공간 미리보기');
  await expect(preview).toBeVisible();
  const firstPreview = await preview.getAttribute('src');
  await dialog.getByLabel('가로 (m)', { exact: true }).fill('0.1');
  await dialog.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('0.5–20m');
  expect(await records(page, 'projects')).toEqual([]);
  await dialog.getByLabel('가로 (m)', { exact: true }).fill('3.6');
  await dialog.getByLabel('깊이 (m)', { exact: true }).fill('2');
  await dialog.getByLabel('높이 (m)', { exact: true }).fill('2.8');
  await expect(dialog).toContainText('7.2 ㎡');
  await expect.poll(() => preview.getAttribute('src')).not.toBe(firstPreview);
  await page.screenshot({ path: testInfo.outputPath('room-dimensions-preview.png'), fullPage: true });
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect(await records(page, 'projects')).toEqual([]);
  expect(await records(page, 'assets')).toEqual([]);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await expect(dialog.getByLabel('가로 (m)', { exact: true })).toHaveValue('2.4');
  await dialog.getByLabel('가로 (m)', { exact: true }).fill('3.6');
  await dialog.getByRole('button', { name: '공간 만들기', exact: true }).evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await editorReady(page);
  const project = await savedProject(page);
  expect(getActiveDesign(project)!.scene.room?.widthMm).toBe(3600);
  expect(
    getActiveDesign(project)!.scene.surfaces.find((surface) => surface.roomFace === 'floor')?.widthMm,
  ).toBe(3600);
  expect(await records(page, 'projects')).toHaveLength(1);
});

test('WebGL 실패는 프로젝트를 만들지 않고 다시 시도할 수 있다', async ({ page }) => {
  await page.addInitScript(() => {
    const runtime = window as Window & { failRoomContext?: boolean };
    runtime.failRoomContext = true;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<typeof original>
    ) {
      if (runtime.failRoomContext && String(args[0]).includes('webgl')) return null;
      return Reflect.apply(original, this, args);
    } as typeof original;
  });
  await page.goto('/');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '공간 크기 설정' });
  await dialog.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(dialog.getByRole('alert').first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: '공간 만들기', exact: true })).toBeEnabled();
  expect(await records(page, 'projects')).toEqual([]);
  expect(await records(page, 'assets')).toEqual([]);
  await page.evaluate(() => {
    (window as Window & { failRoomContext?: boolean }).failRoomContext = false;
  });
  await dialog.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await editorReady(page);
  expect(await records(page, 'projects')).toHaveLength(1);
});

for (const width of [390, 320]) {
  test(`${width}px 공간 설정과 편집기는 넘침 없이 크기를 바꿀 수 있다`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '공간 크기 설정' });
    const image = dialog.getByAltText('입력한 크기에 맞춘 빈 공간 미리보기');
    await expect(image).toBeVisible();
    const previous = await image.getAttribute('src');
    await dialog.getByLabel('가로 (m)', { exact: true }).fill('3.6');
    await expect(dialog).toContainText('8.64 ㎡');
    await expect.poll(() => image.getAttribute('src')).not.toBe(previous);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`room-dialog-${width}.png`) });
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await records(page, 'projects')).toEqual([]);
    await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
    await dialog.getByRole('button', { name: '공간 만들기', exact: true }).click();
    await editorReady(page);
    await expect(page.getByRole('button', { name: '공간 크기', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`room-editor-${width}.png`) });
    await page.getByRole('button', { name: '공간 크기', exact: true }).click();
    await dialog.getByLabel('가로 (m)', { exact: true }).fill('3.6');
    await dialog.getByRole('button', { name: '크기 적용', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(getActiveDesign(await savedProject(page))!.scene.room?.widthMm).toBe(3600);
  });
}

test('공간 생성 중 취소하면 늦게 끝난 배경으로 프로젝트를 만들지 않는다', async ({ page }) => {
  await page.addInitScript(() => {
    const runtime = window as Window & { pendingRoomBlob?: (() => void) | null };
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback, ...args) {
      const hold = this.width >= 4096;
      original.call(
        this,
        (blob) => {
          if (hold) runtime.pendingRoomBlob = () => callback(blob);
          else callback(blob);
        },
        ...args,
      );
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '공간 크기 설정' });
  await dialog.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => !!(window as Window & { pendingRoomBlob?: () => void }).pendingRoomBlob))
    .toBe(true);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await page.evaluate(() => (window as Window & { pendingRoomBlob?: () => void }).pendingRoomBlob?.());
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled();
  await expect.poll(async () => (await records(page, 'projects')).length).toBe(0);
  expect(await records(page, 'assets')).toEqual([]);
});
