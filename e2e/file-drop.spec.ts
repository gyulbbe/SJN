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
test.use({ channel: 'chrome', actionTimeout: 15000 });

type Dropped = { name: string; type: string; bytes: number[] };
async function png(name: string, background: string): Promise<Dropped> {
  const buffer = await sharp({ create: { width: 64, height: 48, channels: 3, background } })
    .png()
    .toBuffer();
  return { name, type: 'image/png', bytes: Array.from(buffer) };
}
const text = (name: string): Dropped => ({
  name,
  type: 'text/plain',
  bytes: Array.from(Buffer.from('memo')),
});

/** A real file drag as the browser delivers it: a DataTransfer carrying File items. */
async function drag(target: Locator, files: Dropped[], type: 'dragenter' | 'drop' = 'drop') {
  const transfer = await target.page().evaluateHandle((list) => {
    const data = new DataTransfer();
    for (const file of list)
      data.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
    return data;
  }, files);
  await target.dispatchEvent(type, { dataTransfer: transfer });
  await transfer.dispose();
}
async function signedInHome(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true })).toBeEnabled();
}
const comparison = (page: Page) =>
  page.getByRole('dialog', { name: '사진으로 비교 공간 만들기', exact: true });

test('홈 시작 카드는 사진 한 장만 받는다: 여러 장은 안내만 하고 한 장이면 비교 창을 연다', async ({
  page,
}) => {
  await signedInHome(page);
  const card = page.locator('.start-card');
  await drag(card, [await png('a.png', '#97adaa')], 'dragenter');
  await expect(card).toHaveClass(/file-drop-active/);
  await card.screenshot({ path: test.info().outputPath('start-card-dragging.png') });
  await drag(card, [await png('a.png', '#97adaa'), await png('b.png', '#aa9797')]);
  await expect(card).not.toHaveClass(/file-drop-active/);
  await expect(page.getByRole('alert').filter({ hasText: '사진은 한 장만 올릴 수 있어요' })).toBeVisible();
  await expect(comparison(page)).toHaveCount(0);
  await drag(card, [text('memo.txt')]);
  await expect(page.getByRole('alert').filter({ hasText: 'JPG·PNG·WebP 이미지만' })).toBeVisible();
  await drag(card, [await png('한 장.png', '#97adaa')]);
  await expect(comparison(page)).toBeVisible();
  await expect(comparison(page).getByText('한 장.png', { exact: true })).toBeVisible();
});

test('홈 직접 편집 줄에 사진 한 장을 끌어 놓으면 비교 창 없이 사진 위 편집을 시작한다', async ({ page }) => {
  await signedInHome(page);
  await page.getByText('기존 사진 위에 직접 편집하기', { exact: true }).click();
  const row = page.getByTestId('direct-edit-drop');
  await drag(row, [await png('a.png', '#97adaa'), await png('b.png', '#aa9797')]);
  await expect(page.getByRole('alert').filter({ hasText: '한 장만' })).toBeVisible();
  await drag(row, [await png('직접 편집.png', '#97adaa')]);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 30000 });
  await expect(comparison(page)).toHaveCount(0);
});

test('비교 창 사진 상자는 한 장만 바꿔 넣고 여러 장은 거절한다', async ({ page }) => {
  await signedInHome(page);
  await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
  const box = comparison(page)
    .locator('label')
    .filter({ has: page.getByTestId('reconstruction-upload') });
  await expect(box).toContainText('한 장');
  await drag(box, [await png('첫 사진.png', '#97adaa')]);
  await expect(box).toContainText('첫 사진.png');
  await drag(box, [await png('a.png', '#97adaa'), await png('b.png', '#aa9797')]);
  await expect(comparison(page).getByRole('alert')).toContainText('한 장만');
  await expect(box).toContainText('첫 사진.png');
  await drag(box, [await png('바꾼 사진.png', '#aa9797')]);
  await expect(box).toContainText('바꾼 사진.png');
  await expect(comparison(page).getByRole('alert')).toHaveCount(0);
});

test('자재 폼 제품 이미지는 여러 장을 한꺼번에 받고 이미지가 아닌 파일만 빼고 알려 준다', async ({
  page,
}) => {
  await page.goto('/admin/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  const zone = form.getByTestId('view-drop');
  await expect(zone).toContainText('여러 장을 한꺼번에');
  await drag(zone, [await png('1.png', '#d22828')], 'dragenter');
  await expect(zone).toHaveClass(/file-drop-active/);
  await zone.screenshot({ path: test.info().outputPath('product-images-dragging.png') });
  await drag(zone, [
    await png('1.png', '#d22828'),
    await png('2.png', '#1eb450'),
    await png('3.png', '#2d50d2'),
  ]);
  const images = form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true });
  await expect(images).toHaveCount(3);
  await expect(form.getByLabel('촬영 방향 1', { exact: true })).toHaveValue('정면');
  await drag(zone, [await png('4.png', '#d22828'), text('memo.txt'), await png('5.png', '#1eb450')]);
  await expect(images).toHaveCount(5);
  await expect(form.getByText('이미지가 아닌 파일 1개는 빼고 올렸어요.', { exact: true })).toBeVisible();
  // Dropping somewhere else in the form is swallowed instead of opening the file in the tab.
  const prevented = await form.getByLabel('상품명').evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'stray.png', { type: 'image/png' }));
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(images).toHaveCount(5);
});

test('자재 폼 타일 텍스처도 여러 장을 한꺼번에 끌어 놓을 수 있다', async ({ page }) => {
  await page.goto('/admin/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  const zone = form.getByTestId('texture-drop');
  await drag(zone, [await png('t1.png', '#c8c8c8'), await png('t2.png', '#a0a0a0')]);
  await expect(form.getByRole('img', { name: /^타일 텍스처 \d$/ })).toHaveCount(2);
});

test('사진 재구성 테스트 페이지는 테스트 사진 한 장만 끌어 놓을 수 있다', async ({ page }) => {
  await page.goto('/reconstruction-performance');
  const run = page.getByRole('button', { name: '테스트 실행', exact: true });
  await expect(run).toBeDisabled();
  const zone = page.locator('label').filter({ has: page.getByLabel('테스트할 사진', { exact: true }) });
  await drag(zone, [await png('a.png', '#ada99b'), await png('b.png', '#9bada9')]);
  await expect(page.getByRole('alert').filter({ hasText: '한 장만' })).toBeVisible();
  await drag(zone, [await png('테스트.png', '#ada99b')]);
  await expect(page.getByRole('button', { name: /테스트 실행|실패한 단계부터 재시도/ })).toBeEnabled();
});
