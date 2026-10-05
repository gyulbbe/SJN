import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(180000);

/** A plain picture of one colour: the colour on screen tells which photo of a product is shown. */
const photo = (width: number, height: number, fill: string) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${fill}"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
/** How many pixels of the picture are strongly red and strongly blue. */
async function colours(image: Buffer) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let red = 0,
    blue = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r > 170 && g < 90 && b < 90) red++;
    if (b > 170 && r < 90 && g < 90) blue++;
  }
  return { red, blue };
}

async function register(page: Page, name: string, views: [string, Buffer][]) {
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill(name);
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('400');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('700');
  await form.getByLabel('깊이 (mm)', { exact: true }).fill('600');
  await form.getByLabel('+ 제품 이미지 올리기', { exact: true }).setInputFiles(
    views.map(([direction, buffer], index) => ({
      name: `${index}-${direction}.png`,
      mimeType: 'image/png',
      buffer,
    })),
  );
  for (const [index, [direction]] of views.entries())
    await form.getByLabel(`촬영 방향 ${index + 1}`, { exact: true }).selectOption(direction);
  await expect(
    form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }).first(),
  ).toBeVisible();
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
}

test('네 방향 시점: 오른쪽 사진을 고른 제품은 오른쪽 화면에서 정면 사진이 되고, 없는 방향은 가까운 사진과 알림', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  // 정면 is red, 오른쪽 is blue (a side picture: as wide as the product is deep).
  await register(page, '색 변기', [
    ['정면', await photo(200, 350, '#e02020')],
    ['오른쪽', await photo(300, 350, '#2030e0')],
  ]);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '색 변기' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  // The product stands as the photo it is placed with says: the 오른쪽 photo makes it face right.
  await page.getByLabel('오른쪽 각도 선택', { exact: true }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });

  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  const picker = dialog.getByRole('group', { name: 'AI 입력 시점' });
  const preview = picker.getByTestId('flux-view-preview');
  const readout = picker.getByTestId('flux-view-readout');
  const notes = picker.getByTestId('flux-view-notes');
  const button = (name: string) => picker.getByRole('button', { name, exact: true });
  await expect(preview.locator('canvas')).toHaveCount(1, { timeout: 30000 });
  const look = async (view: string) => {
    await expect(readout).toHaveText(view);
    // The preview draws on the frame after the turn: wait for it to settle, then read the picture.
    await page.waitForTimeout(800);
    return colours(await preview.screenshot());
  };

  // Front: the product faces right, so its 오른쪽 photo (blue) shows. No stand-in, no note.
  const front = await look('정면');
  expect(front.blue).toBeGreaterThan(200);
  expect(front.red).toBeLessThan(front.blue / 20);
  await expect(notes).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('four-view-front.png') });

  // Right: the product faces the camera (the specification's own example): its 정면 photo (red).
  await button('오른쪽으로 90° 돌리기').click();
  const right = await look('오른쪽');
  expect(right.red).toBeGreaterThan(200);
  expect(right.blue).toBeLessThan(right.red / 20);
  await expect(notes).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('four-view-right.png') });

  // Back: it would show 왼쪽, which is not registered; the nearest registered photo is the 정면 (0° from
  // −90° is 90°; the 오른쪽 is 180°), and the dialog says so.
  await button('오른쪽으로 90° 돌리기').click();
  const back = await look('뒤');
  expect(back.red).toBeGreaterThan(200);
  expect(back.blue).toBeLessThan(back.red / 20);
  await expect(notes).toContainText(
    '뒤 화면: 색 변기의 ‘왼쪽’ 사진이 없어 ‘정면’ 사진을 썼어요. 방향별 사진을 더 등록하면 더 자연스러워요.',
  );
  await page.screenshot({ path: info.outputPath('four-view-back.png') });

  // Left: it would show 뒤, not registered either; the nearest is the 오른쪽 photo (blue, 90° away).
  await button('오른쪽으로 90° 돌리기').click();
  const left = await look('왼쪽');
  expect(left.blue).toBeGreaterThan(200);
  expect(left.red).toBeLessThan(left.blue / 20);
  await expect(notes).toContainText(
    '왼쪽 화면: 색 변기의 ‘뒤’ 사진이 없어 ‘오른쪽’ 사진을 썼어요. 방향별 사진을 더 등록하면 더 자연스러워요.',
  );
  await page.screenshot({ path: info.outputPath('four-view-left.png') });

  // Back at the front the note is gone, and the viewer shows the same note for its own view.
  await button('정면으로').click();
  await look('정면');
  await expect(notes).toHaveCount(0);
  await dialog.getByRole('button', { name: /닫기/ }).first().click();
  await page.getByRole('button', { name: '공간 둘러보기', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: '공간 둘러보기', exact: true });
  await expect(page.getByTestId('room-view-viewport')).toHaveAttribute('aria-busy', 'false', {
    timeout: 45000,
  });
  await viewer.getByRole('button', { name: '오른쪽 90°', exact: true }).click();
  await viewer.getByRole('button', { name: '오른쪽 90°', exact: true }).click();
  await expect(viewer.getByTestId('room-view-direction')).toHaveText('뒤쪽');
  await viewer.getByText(/표현 범위와 확인할 항목/).click();
  await expect(viewer).toContainText(
    '뒤 화면: 색 변기의 ‘왼쪽’ 사진이 없어 ‘정면’ 사진을 썼어요. 방향별 사진을 더 등록하면 더 자연스러워요.',
  );
  await page.screenshot({ path: info.outputPath('four-view-viewer-back.png') });
});
