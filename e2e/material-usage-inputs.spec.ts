import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { ProjectDocument } from '../src/lib/types';

test.use({ channel: 'chrome' });
async function persisted(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gongganmiri-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<ProjectDocument>((resolve, reject) => {
      const request = db
        .transaction('projects')
        .objectStore('projects')
        .get(location.pathname.split('/').at(-1)!);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return project;
  });
}
const design = (project: ProjectDocument) =>
  project.designs.find((item) => item.id === project.activeDesignId)!;

test('자재 포장 확인, 수량·단가 Enter/blur 단일 기록과 빈 값·0원 구분', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정' })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  const buffer = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#c9d1bf' } })
    .png()
    .toBuffer();
  await form.getByLabel('상품명').fill('입력 확인 타일');
  await expect(form.getByLabel('+ 타일 텍스처 올리기', { exact: true })).toBeEnabled();
  await form
    .getByLabel('+ 타일 텍스처 올리기', { exact: true })
    .setInputFiles({ name: 'texture.png', mimeType: 'image/png', buffer });
  await expect(form.getByRole('button', { name: '자재 등록', exact: true })).toBeEnabled();
  await form.getByLabel('판매 단위', { exact: true }).selectOption('box');
  await form.getByLabel('기준 단가', { exact: true }).fill('30000');
  await form.getByLabel('박스당 면적 (㎡)', { exact: true }).fill('2');
  await form.getByLabel('박스당 수량 (장)', { exact: true }).fill('4');
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('박스당 면적');
  await form.getByRole('checkbox', { name: '등록한 박스당 면적을 기준으로 사용할 것을 확인했어요.' }).check();
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.locator('button.material-tile').filter({ hasText: '입력 확인 타일' }).click();
  const row = page.getByTestId('usage-row').filter({ hasText: '입력 확인 타일' });
  await expect(row).toBeVisible();
  const sameArea = row.getByLabel('바닥 면적 (㎡)', { exact: true });
  await sameArea.fill('5.76');
  await sameArea.press('Enter');
  await expect(row).toContainText('직접 입력한 면적');
  const before = await persisted(page);
  const price = row.getByLabel('입력 확인 타일 단가 (원)', { exact: true });
  await price.fill('15000');
  await expect(price).toHaveValue('15000');
  await price.press('Enter');
  await expect(price).toHaveValue('15000');
  await expect(price).not.toBeFocused();
  await page.getByRole('heading', { name: '자재 수량·금액', exact: true }).click();
  let saved = await persisted(page);
  expect(design(saved).history.past.length).toBe(design(before).history.past.length + 1);
  await price.fill('');
  await price.press('Tab');
  await expect(row.getByTestId('usage-row-amount')).toHaveText('계산 전');
  await price.fill('0');
  await price.press('Enter');
  await expect(row.getByTestId('usage-row-amount')).toHaveText('0원');
  const quantity = row.getByLabel('입력 확인 타일 구매 수량', { exact: true });
  saved = await persisted(page);
  await quantity.fill('9');
  await quantity.press('Enter');
  await expect(row).toContainText('참고 장수 36장');
  const afterQuantity = await persisted(page);
  expect(design(afterQuantity).history.past.length).toBe(design(saved).history.past.length + 1);
  await price.fill('-2');
  await price.press('Enter');
  await expect(price).toHaveAttribute('aria-invalid', 'true');
  await expect(price).toBeFocused();
  await price.press('Escape');
  await expect(price).toHaveValue('0');
  await expect(price).toHaveAttribute('aria-invalid', 'false');
  await page.screenshot({ path: testInfo.outputPath('usage-panel-inputs.png'), fullPage: true });
  expect(errors).toEqual([]);
});
