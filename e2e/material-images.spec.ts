import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page, {
    allowModelDownloads:
      process.env.SJN_AI_BACKGROUND_REAL === '1' || process.env.SJN_AI_BACKGROUND_WASM === '1',
  });
});
test.afterEach(async () => {
  await app?.dispose();
});
import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { savedProject } from '../tests/helpers/editor-actions';
import { getActiveDesign } from '../src/lib/designs';

test.use({ channel: 'chrome' });

const red = [210, 40, 40, 255];
const green = [30, 180, 80, 255];
const blue = [45, 80, 210, 255];
async function imageFile(name: string, color: number[]) {
  const buffer = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: color[0], g: color[1], b: color[2], alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return { name, mimeType: 'image/png', buffer };
}
async function imageColor(locator: Locator, expected: number[]) {
  await expect
    .poll(async () => {
      return locator.evaluate((element) => {
        if (!(element instanceof HTMLImageElement) || !element.complete || !element.naturalWidth) return [];
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d')!;
        context.drawImage(element, 0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      });
    })
    .toEqual(expected);
}
async function noCoverControls(form: Locator) {
  await expect(form.getByRole('heading', { name: '상품 소개 이미지', exact: true })).toHaveCount(0);
  await expect(form.getByRole('button', { name: /대표 이미지/ })).toHaveCount(0);
  await expect(form.getByLabel('대표 이미지 올리기', { exact: true })).toHaveCount(0);
}
async function checkDisplays(page: Page, name: string, color: number[], tile = false, preferredView = 0) {
  const card = page.locator('article').filter({ hasText: name });
  await imageColor(card.getByRole('img', { name, exact: true }), color);
  await card.screenshot({ path: test.info().outputPath('material-card.png') });
  await card.getByRole('button', { name: `${name} 상세 보기`, exact: true }).click();
  const detail = page.getByRole('dialog', { name, exact: true });
  await imageColor(detail.getByRole('img', { name, exact: true }), color);
  await detail.screenshot({ path: test.info().outputPath('material-detail.png') });
  await detail.getByRole('button', { name: '닫기', exact: true }).click();
  await page.goto('http://127.0.0.1:3000/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await savedProject(page);
  await page.getByRole('button', { name: tile ? '바닥 타일' : '위생도기', exact: true }).click();
  const material = page.locator('button.material-tile').filter({ hasText: name });
  await imageColor(material.getByRole('img', { name, exact: true }), color);
  const before = await savedProject(page);
  await material.click();
  const placed = await savedProject(page, before.editRevision);
  if (!tile) expect(getActiveDesign(placed)!.scene.fixtures[0].viewIndex).toBe(preferredView);
  const usage = page.getByTestId('usage-row').filter({ hasText: name });
  await imageColor(usage.getByRole('img', { name, exact: true }), color);
  await usage.screenshot({ path: test.info().outputPath('material-usage.png') });
  if (!tile && preferredView === 1) {
    await page.getByTestId('fixture-view-0').click();
    const changed = await savedProject(page, placed.editRevision);
    expect(getActiveDesign(changed)!.scene.fixtures[0].viewIndex).toBe(0);
    await page.reload();
    await expect(page.getByTestId('editor-canvas')).toBeVisible();
    const restored = await savedProject(page);
    expect(getActiveDesign(restored)!.scene.fixtures[0].viewIndex).toBe(0);
    await imageColor(
      page.getByTestId('usage-row').filter({ hasText: name }).getByRole('img', { name, exact: true }),
      color,
    );
  }
}
for (const hasFront of [true, false]) {
  test(`제품 이미지만 등록: ${hasFront ? '두 번째 정면 사진 우선' : '정면 없으면 첫 사진'} · 목록·상세·편집 목록·사용 내역 동일`, async ({
    page,
  }) => {
    await page.goto('http://127.0.0.1:3000/admin/materials');
    await page.getByRole('button', { name: '자재 등록', exact: true }).click();
    const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
    const name = hasFront ? '정면 자동 표시 검증 제품' : '첫 사진 자동 표시 검증 제품';
    await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
    await form.getByLabel('상품명').fill(name);
    await noCoverControls(form);
    await expect(form.getByRole('heading', { name: '제품 이미지', exact: true })).toBeVisible();
    await form.getByRole('button', { name: '자재 등록', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText(/제품 이미지|제품 사진/);
    await form
      .getByLabel('+ 제품 이미지 올리기', { exact: true })
      .setInputFiles([await imageFile('first-red.png', red), await imageFile('second-green.png', green)]);
    await expect(
      form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
    ).toHaveCount(2);
    const firstPreset = form.getByLabel('촬영 방향 1 빠른 선택', { exact: true });
    await expect(firstPreset).toBeVisible();
    await firstPreset.selectOption('오른쪽 사선');
    await expect(form.getByLabel('촬영 방향 1', { exact: true })).toHaveValue('오른쪽 사선');
    await form.getByLabel('촬영 방향 1', { exact: true }).fill('오른쪽 25도');
    await expect(firstPreset).toHaveValue('');
    await form
      .getByLabel('촬영 방향 2 빠른 선택', { exact: true })
      .selectOption(hasFront ? '정면' : '뒤에서');
    await expect(form.getByLabel('촬영 방향 2', { exact: true })).toHaveValue(hasFront ? '정면' : '뒤에서');
    await form.getByLabel('기준 단가', { exact: true }).fill('120000');
    await form.getByRole('heading', { name: '제품 이미지', exact: true }).scrollIntoViewIfNeeded();
    await form.screenshot({ path: test.info().outputPath('product-images-form.png') });
    await form.getByRole('button', { name: '자재 등록', exact: true }).click();
    await expect(form).toHaveCount(0);
    await checkDisplays(page, name, hasFront ? green : red, false, hasFront ? 1 : 0);
  });
}

test('타일 한 장을 사각형으로 선택하면 규격 비율로 잘라 텍스처로 쓴다', async ({ page }) => {
  // A 400×400 white photo with one 200×100 blue tile in the middle.
  const tile = await sharp({
    create: { width: 200, height: 100, channels: 4, background: { r: blue[0], g: blue[1], b: blue[2], alpha: 1 } },
  })
    .png()
    .toBuffer();
  const photo = await sharp({
    create: { width: 400, height: 400, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: tile, left: 100, top: 150 }])
    .png()
    .toBuffer();
  await page.goto('http://127.0.0.1:3000/admin/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('상품명').fill('사각형 선택 검증 타일');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await form.getByLabel('세로 (mm)', { exact: true }).fill('300');
  await form
    .getByLabel('+ 타일 텍스처 올리기', { exact: true })
    .setInputFiles({ name: 'tiles.png', mimeType: 'image/png', buffer: photo });
  await form.getByRole('button', { name: '한 장 선택·정면 보정', exact: true }).click();
  const crop = page.getByRole('dialog', { name: '타일 한 장 선택·정면 보정', exact: true });
  const rectMode = crop.getByRole('button', { name: '사각형', exact: true });
  await expect(rectMode).toHaveAttribute('aria-pressed', 'true');
  await expect(crop.getByRole('checkbox', { name: '규격 비율 고정 (600:300)', exact: true })).toBeChecked();
  const field = (label: string) =>
    crop.getByRole('spinbutton', { name: `선택 영역 ${label} (%)`, exact: true });
  const ratio = async () => Number(await field('가로').inputValue()) / Number(await field('세로').inputValue());
  // The first rectangle already follows the 2:1 spec on a square photo.
  await expect.poll(ratio).toBeCloseTo(2, 1);
  // Dragging from outside the selection draws a new one; the lock keeps it 2:1.
  const canvas = crop.getByLabel('타일 한 장 사각형 선택 화면', { exact: true });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.02, box.y + box.height * 0.02);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.9, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Number(await field('가로').inputValue())).toBeCloseTo(58, 0);
  expect(Number(await field('왼쪽').inputValue())).toBeCloseTo(2, 0);
  await expect.poll(ratio).toBeCloseTo(2, 1);
  // Typed values select exactly the blue tile; the height follows the locked width.
  await field('왼쪽').fill('25');
  await field('위').fill('37.5');
  await field('가로').fill('50');
  await expect(field('세로')).toHaveValue('25');
  // The four-point mode starts from the rectangle, and switching back keeps it.
  await crop.getByRole('button', { name: '네 점 (기울어진 사진)', exact: true }).click();
  await expect(crop.getByRole('spinbutton', { name: '모서리 1 가로 위치', exact: true })).toHaveValue('25');
  await expect(crop.getByRole('spinbutton', { name: '모서리 3 세로 위치', exact: true })).toHaveValue('62.5');
  await rectMode.click();
  await expect(field('위')).toHaveValue('37.5');
  await expect(field('세로')).toHaveValue('25');
  await crop.screenshot({ path: test.info().outputPath('tile-crop-rect-1440.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await crop.screenshot({ path: test.info().outputPath('tile-crop-rect-390.png') });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await crop.getByRole('button', { name: '편집 결과 적용', exact: true }).click();
  await expect(crop).toHaveCount(0);
  const texture = form.getByRole('img', { name: '타일 텍스처 1', exact: true });
  await expect
    .poll(() =>
      texture.evaluate((image) =>
        image instanceof HTMLImageElement && image.complete ? image.naturalWidth / image.naturalHeight : 0,
      ),
    )
    .toBe(2);
  // Centre and near-corner pixels are both blue, so the crop sits on the tile and not the white wall.
  const pixels = await texture.evaluate((image) => {
    const img = image as HTMLImageElement,
      canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(img, 0, 0);
    return [
      [0.5, 0.5],
      [0.05, 0.08],
      [0.95, 0.92],
    ].map(([x, y]) => [...context.getImageData(canvas.width * x, canvas.height * y, 1, 1).data]);
  });
  for (const pixel of pixels) for (const [i, value] of blue.slice(0, 3).entries()) expect(Math.abs(pixel[i] - value)).toBeLessThanOrEqual(4);
});

test('타일은 텍스처만 등록: 상품 소개·대표 설정 없이 목록·상세·편집·사용 내역 표시', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000/admin/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  const name = '텍스처 자동 표시 검증 타일';
  await form.getByLabel('상품명').fill(name);
  await noCoverControls(form);
  await form
    .getByLabel('+ 타일 텍스처 올리기', { exact: true })
    .setInputFiles(await imageFile('tile-blue.png', blue));
  await expect(form.getByRole('img', { name: '타일 텍스처 1', exact: true })).toBeVisible();
  await form.getByLabel('기준 단가', { exact: true }).fill('10000');
  await form.screenshot({ path: test.info().outputPath('tile-texture-form.png') });
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await checkDisplays(page, name, blue, true);
});
