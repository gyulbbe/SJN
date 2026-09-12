import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { savedProject } from '../tests/helpers/editor-actions';
import { getActiveDesign } from '../src/lib/designs';

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
    await page.goto('http://127.0.0.1:3000/materials');
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

test('타일은 텍스처만 등록: 상품 소개·대표 설정 없이 목록·상세·편집·사용 내역 표시', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000/materials');
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
