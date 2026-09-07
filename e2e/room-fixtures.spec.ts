import { getActiveDesign } from '../src/lib/designs';
import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { ProjectDocument } from '../src/lib/types';
test.use({ channel: 'chrome', actionTimeout: 15000 });
async function saved(page: Page): Promise<ProjectDocument> {
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('gongganmiri-v1');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const p = await new Promise<ProjectDocument>((resolve, reject) => {
      const r = db.transaction('projects').objectStore('projects').get(id!);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return p;
  }, page.url().split('/').at(-1));
}
async function createProductRoom(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  const png = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect x="50" y="10" width="100" height="185" rx="15" fill="#ff2222"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill('규격 세면대');
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('800');
  await form
    .getByLabel('대표 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'basin.png', mimeType: 'image/png', buffer: png });
  await expect(form.getByLabel('대표 이미지 변경', { exact: true })).toBeEnabled();
  await form
    .getByLabel('+ 제품 방향 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: png });
  await expect(form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })).toHaveCount(
    1,
  );
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '규격 세면대' }).click();
  await expect(page.getByLabel('제품 배율', { exact: true })).toBeVisible();
}
async function pixels(page: Page, x: number, y: number) {
  return page.locator('[data-testid="canvas-frame"] canvas').evaluate(
    (el, p) => {
      const c = document.createElement('canvas');
      c.width = (el as HTMLCanvasElement).width;
      c.height = (el as HTMLCanvasElement).height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(el as HTMLCanvasElement, 0, 0);
      return [...ctx.getImageData(Math.floor(p.x * c.width), Math.floor(p.y * c.height), 1, 1).data];
    },
    { x, y },
  );
}
test('규격 도기 실제 드래그·원근 크기·잔상 없음·배율·방 크기·저장·출력', async ({ page }, info) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createProductRoom(page);
  const initial = getActiveDesign(await saved(page))!.scene.fixtures[0];
  expect(initial.roomPlacement?.widthMm).toBe(600);
  expect(initial.roomPlacement?.heightMm).toBe(800);
  expect(initial.roomPlacement?.contentBounds.left).toBeCloseTo(0.25, 2);
  await page.getByLabel('면 깊이 위치 (%)', { exact: true }).fill('20');
  const back = getActiveDesign(await saved(page))!.scene.fixtures[0];
  await page.getByLabel('면 깊이 위치 (%)', { exact: true }).fill('80');
  const front = getActiveDesign(await saved(page))!.scene.fixtures[0];
  expect(front.width).toBeGreaterThan(back.width * 1.15);
  expect(front.height / front.width).toBeCloseTo(4096 / 2731, 5);
  // Drag the actual SVG product envelope toward the left. Alpha center was red before movement.
  const redPoint = {
    x: front.position.x + (0.5 - front.anchor.x) * front.width,
    y: front.position.y + (0.5 - front.anchor.y) * front.height,
  };
  await expect.poll(async () => (await pixels(page, redPoint.x, redPoint.y))[0]).toBeGreaterThan(235);
  const envelope = page.locator(`rect[data-entity="${front.id}"]`);
  const box = (await envelope.boundingBox())!;
  const canvas = (await page.getByTestId('editor-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - canvas.width * 0.18, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const moved = getActiveDesign(await saved(page))!.scene.fixtures[0];
  expect(moved.roomPlacement!.u).toBeLessThan(front.roomPlacement!.u);
  await expect
    .poll(async () => {
      const rgb = await pixels(page, redPoint.x, redPoint.y);
      return rgb[0] - rgb[1];
    })
    .toBeLessThan(70);
  // Percentage override remains physical when the room is resized.
  await page.getByLabel('제품 배율', { exact: true }).fill('130');
  await page.getByLabel('제품 배율', { exact: true }).press('Tab');
  const scaled = getActiveDesign(await saved(page))!.scene.fixtures[0];
  expect(scaled.roomPlacement!.scale).toBe(1.3);
  const previous = await saved(page);
  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '공간 크기 설정', exact: true });
  await dialog.getByLabel('가로 (m)', { exact: true }).fill('3.6');
  await dialog.getByLabel('깊이 (m)', { exact: true }).fill('4');
  await dialog.getByRole('button', { name: '크기 적용', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const resized = await saved(page);
  expect(getActiveDesign(resized)!.scene.fixtures[0].roomPlacement).toEqual(scaled.roomPlacement);
  expect(getActiveDesign(resized)!.scene.fixtures[0].width).not.toBe(scaled.width);
  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await dialog.getByRole('button', { name: '크기 변경 직전 전체 복원', exact: true }).click();
  expect(getActiveDesign(await saved(page))!.scene).toEqual(getActiveDesign(previous)!.scene);
  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await dialog.getByRole('button', { name: '전체 다시 실행', exact: true }).click();
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  expect(getActiveDesign(await saved(page))!.scene).toEqual(getActiveDesign(resized)!.scene);
  await page.screenshot({ path: info.outputPath('room-product.png') });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: '이미지 내보내기', exact: true });
  const download = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  const file = await download;
  await file.saveAs(info.outputPath('room-product.png-export.png'));
  const meta = await sharp(info.outputPath('room-product.png-export.png')).metadata();
  expect(meta.width).toBe(4096);
  expect(meta.height).toBe(2731);
  expect(errors).toEqual([]);
});
