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
import { expect, test } from '@playwright/test';
import sharp from 'sharp';

const filename = '다시 선택할 사진.png';
async function photo() {
  const buffer = await sharp({
    create: { width: 96, height: 64, channels: 4, background: '#97b4a0' },
  })
    .png()
    .toBuffer();
  return { name: filename, mimeType: 'image/png', buffer };
}

test.beforeEach(async ({ page }) => {
  // Simulate a disk permission/snapshot failure once; the retry uses the real read/decode/storage path.
  await page.addInitScript((name) => {
    const read = File.prototype.arrayBuffer;
    let fail = true;
    File.prototype.arrayBuffer = function () {
      if (this.name === name && fail) {
        fail = false;
        return Promise.reject(new DOMException('The requested file could not be read.', 'NotReadableError'));
      }
      return read.call(this);
    };
  }, filename);
});

test('제품 사진 읽기 실패를 안내하고 같은 파일 재선택으로 등록한다', async ({ page }) => {
  await page.goto('/admin/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('상품명').fill('파일 재선택 검증 제품');
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  const input = form.getByLabel('+ 제품 이미지 올리기', { exact: true });
  await input.setInputFiles(await photo());
  await expect(form.getByRole('alert')).toContainText('다운로드 폴더에 새 이름으로 저장한 뒤 다시 선택');
  await expect(form.getByRole('alert')).not.toContainText('The requested file');
  await expect(form.getByLabel('촬영 방향 1', { exact: true })).toHaveCount(0);
  await expect(form.getByLabel('상품명')).toHaveValue('파일 재선택 검증 제품');
  await expect(input).toBeEnabled();
  await input.setInputFiles(await photo());
  await expect(form.getByLabel('촬영 방향 1', { exact: true })).toBeVisible();
  await expect(form.getByRole('alert')).toHaveCount(0);
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '파일 재선택 검증 제품 상세 보기', exact: true }),
  ).toBeVisible();
});

test('공간 사진 읽기 실패 후 동일 사진을 다시 선택해 프로젝트를 만든다', async ({ page }) => {
  await page.goto('/');
  const input = page.getByTestId('project-upload');
  await expect(input).toBeEnabled();
  await input.setInputFiles(await photo());
  await expect(page.locator('.error[role="alert"]')).toContainText(
    '다운로드 폴더에 새 이름으로 저장한 뒤 다시 선택',
  );
  await expect(page.locator('.error[role="alert"]')).not.toContainText('The requested file');
  await expect(input).toBeEnabled();
  await input.setInputFiles(await photo());
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
});
