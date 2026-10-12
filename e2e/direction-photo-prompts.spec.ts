import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';

let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000, permissions: ['clipboard-read', 'clipboard-write'] });
test.setTimeout(180000);

// (Windows hands the text back with CRLF line ends; the box holds LF.)
const clipboard = async (page: Page) =>
  (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
/** Copies one direction from the guide and returns what landed on the clipboard. */
async function copyFromGuide(page: Page, guide: Locator, direction: string) {
  await guide.getByRole('tab', { name: direction, exact: true }).click();
  await expect(guide.getByRole('tab', { name: direction, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await guide.getByRole('button', { name: `${direction} 프롬프트 복사`, exact: true }).click();
  await expect(guide.getByRole('status').filter({ hasText: '복사했어요' })).toBeVisible();
  const copied = await clipboard(page);
  // What is copied is what the box shows.
  await expect(guide.getByLabel(`${direction} 프롬프트`, { exact: true })).toHaveValue(copied);
  return copied;
}

test('자재 등록 폼에서 방향별 AI 사진 프롬프트를 복사한다: 비율·카메라·순백 배경, 왼쪽은 LEFT·오른쪽은 RIGHT, 안내', async ({
  page,
}, info) => {
  await page.goto('/admin/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption('bath');
  await form.getByLabel('상품명').fill('프롬프트 시험 욕조');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('1700');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('560');
  await form.getByLabel('깊이 (mm)', { exact: true }).fill('750');
  await form.getByLabel('설치 방식', { exact: true }).selectOption('floor');

  const guide = form.getByTestId('direction-prompts');
  await guide.getByText('AI로 방향별 사진 만들기', { exact: true }).click();
  await expect(guide.getByText('결과를 저장해 같은 이름의 방향으로 등록해요.')).toBeVisible();
  await expect(guide).toContainText(
    'AI로 만든 사진은 실제 제품과 다를 수 있어요. 실제 제품과 비교해 확인하세요.',
  );
  await expect(guide).toContainText('이 제품에 권장하는 사진: 정면·왼쪽');

  // 정면: the width : height ratio, the camera from slightly above (a floor product), a pure white background.
  const front = await copyFromGuide(page, guide, '정면');
  expect(front).toContain('Product: bathtub, 1700 × 560 × 750 mm (width × height × depth).');
  expect(front).toContain('about 3.0 : 1 (1700 : 560 mm)');
  expect(front).toContain('looking down about 10 degrees');
  expect(front).toContain('pure white seamless background (#FFFFFF)');
  expect(front).toContain("View: the product's front faces the camera straight on.");
  expect(front).not.toContain('image 2 is the front view');
  await guide.screenshot({ path: info.outputPath('prompt-front.png') });

  // 왼쪽 and 오른쪽: the front to the matching edge, the depth : height ratio, the 정면 result attached.
  const left = await copyFromGuide(page, guide, '왼쪽');
  expect(left).toContain('toward the LEFT edge of the image');
  expect(left).toContain('about 1.3 : 1 (750 : 560 mm)');
  expect(left).toContain('image 2 is the front view already made from it');
  const right = await copyFromGuide(page, guide, '오른쪽');
  expect(right).toContain('toward the RIGHT edge of the image');
  expect(right).not.toContain('toward the LEFT edge of the image and');

  // The features typed in go into the prompt (they are not saved with the material).
  await guide.getByLabel('지켜야 할 제품 특징(선택)', { exact: true }).fill('overflow at the right end');
  expect(await copyFromGuide(page, guide, '정면')).toContain(
    'Details that must stay the same: overflow at the right end.',
  );

  // Without a depth the side views have no ratio, and the guide says so.
  await form.getByLabel('깊이 (mm)', { exact: true }).fill('');
  await guide.getByRole('tab', { name: '왼쪽', exact: true }).click();
  await expect(guide.getByTestId('prompt-notice')).toContainText(
    '가로·높이·깊이를 먼저 넣으면 비율이 프롬프트에 들어가요.',
  );
  expect(await copyFromGuide(page, guide, '왼쪽')).not.toContain(' : 1 (');
  await form.getByLabel('깊이 (mm)', { exact: true }).fill('750');
  await guide.getByRole('tab', { name: '왼쪽', exact: true }).click();
  await expect(guide.getByTestId('prompt-notice')).toHaveCount(0);

  // A wall product: the camera at its centre height, and its back hardly needed (still copyable).
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('설치 방식', { exact: true }).selectOption('wall');
  await guide.getByRole('tab', { name: '뒤', exact: true }).click();
  await expect(guide.getByTestId('prompt-notice')).toContainText(
    '벽에 거는 제품은 뒤 사진이 거의 필요 없어요.',
  );
  const back = await copyFromGuide(page, guide, '뒤');
  expect(back).toContain("The camera is at the product's center height, looking straight at it.");
  expect(back).toContain('Its front is the side a person stands at; its back mounts to the wall.');
  await guide.screenshot({ path: info.outputPath('prompt-wall-back.png') });

  // A photo card copies the prompt for its own direction.
  const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#c8c8c8' } })
    .png()
    .toBuffer();
  await form
    .getByLabel('+ 제품 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: photo });
  await expect(form.getByLabel('촬영 방향 1', { exact: true })).toHaveValue('정면');
  await form.getByLabel('촬영 방향 1', { exact: true }).selectOption('오른쪽');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await form.getByRole('button', { name: '오른쪽 방향 프롬프트 복사', exact: true }).click();
  await expect(form.getByRole('status').filter({ hasText: '복사했어요' }).first()).toBeVisible();
  const card = await clipboard(page);
  expect(card).toContain('toward the RIGHT edge of the image');
  expect(card).toContain('Product: washbasin, 1700 × 560 × 750 mm');
  await form.screenshot({ path: info.outputPath('prompt-card.png') });
});
