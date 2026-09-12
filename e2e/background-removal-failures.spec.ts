import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import sharp from 'sharp';

test.use({ channel: 'chrome' });

// Failure injection blocks real requests / removes browser support. No synthetic AI result is returned.
const modelUrl = /^https:\/\/huggingface\.co\/studioludens\/birefnet-lite-512\/resolve\//;
const aiDialog = (page: Page) => page.getByRole('dialog', { name: 'AI 배경 제거 테스트', exact: true });

async function openUploadedProduct(page: Page) {
  await page.goto('/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('상품명').fill('배경 제거 실패 검증 제품');
  const buffer = await sharp({ create: { width: 64, height: 48, channels: 4, background: '#a9bec0' } })
    .png()
    .toBuffer();
  await form
    .getByLabel('+ 제품 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'failure-only.png', mimeType: 'image/png', buffer });
  await expect(form.getByLabel('+ 제품 이미지 올리기', { exact: true })).toBeEnabled();
  await expect(
    form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
  ).toBeVisible();
  return form;
}

async function persistentManifest(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gongganmiri-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const manifest: Record<string, unknown[]> = {};
    try {
      for (const store of ['assets', 'materials', 'versions']) {
        const records = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        manifest[store] = await Promise.all(
          records.map(async (record) => {
            const { blob, ...metadata } = record;
            if (!(blob instanceof Blob)) return metadata;
            const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
            return {
              ...metadata,
              blobSize: blob.size,
              blobType: blob.type,
              sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
                '',
              ),
            };
          }),
        );
      }
    } finally {
      db.close();
    }
    return manifest;
  });
}

async function previewSource(form: Locator) {
  return form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }).getAttribute('src');
}

async function startTest(form: Locator) {
  await form.getByRole('button', { name: '정면 사진 AI 배경 제거 테스트', exact: true }).click();
}

async function assertNoResult(page: Page) {
  await expect(aiDialog(page).getByTestId('background-removal-result')).toHaveCount(0);
  await expect(aiDialog(page).getByRole('button', { name: '투명 PNG 다운로드', exact: true })).toBeDisabled();
  await expect(aiDialog(page).getByRole('button', { name: '투명 PNG 업로드', exact: true })).toBeDisabled();
}

test('모델 네트워크 실패는 이유·재시도 표시 · 기존 사진과 자재 데이터 보존', async ({ page, context }) => {
  test.setTimeout(120_000);
  const requested: string[] = [];
  await context.route(modelUrl, async (route) => {
    requested.push(route.request().url());
    await route.abort('internetdisconnected');
  });
  const form = await openUploadedProduct(page);
  const before = await persistentManifest(page);
  const preview = await previewSource(form);
  await startTest(form);
  await expect(aiDialog(page)).toBeVisible();
  await expect(aiDialog(page).getByRole('alert')).toContainText('huggingface.co', { timeout: 80_000 });
  expect(requested.length).toBeGreaterThan(0);
  await assertNoResult(page);
  const firstAttempt = requested.length;
  await aiDialog(page).getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect.poll(() => requested.length, { timeout: 30_000 }).toBeGreaterThan(firstAttempt);
  await expect(aiDialog(page).getByRole('alert')).toContainText('모델 다운로드');
  await assertNoResult(page);
  expect(await persistentManifest(page)).toEqual(before);
  await aiDialog(page).getByRole('button', { name: '닫기', exact: true }).click();
  await expect(aiDialog(page)).toHaveCount(0);
  expect(await previewSource(form)).toBe(preview);
  await expect(form.getByLabel('상품명')).toHaveValue('배경 제거 실패 검증 제품');
  await expect(form.getByRole('button', { name: '배경 수동 지우기', exact: true })).toHaveCount(0);
});

test('실제 모델 요청 대기 중 중복 방지 · Escape/닫기 취소 · 늦은 실패로 결과 창 재생성 안 함', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  let requests = 0;
  const held: { route: Route; release: () => void }[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route(modelUrl, async (route) => {
    requests++;
    await new Promise<void>((resolve) => held.push({ route, release: resolve }));
    await route.abort('aborted').catch(() => undefined);
  });
  const releaseRequests = () => {
    for (const request of held.splice(0)) request.release();
  };
  try {
    const form = await openUploadedProduct(page);
    const before = await persistentManifest(page);
    const preview = await previewSource(form);
    for (const closeBy of ['Escape', 'button']) {
      const previousRequests = requests;
      await startTest(form);
      await expect(aiDialog(page)).toBeVisible();
      await expect.poll(() => requests, { timeout: 80_000 }).toBeGreaterThan(previousRequests);
      await expect(aiDialog(page).getByRole('progressbar', { name: '모델 다운로드 진행' })).toBeVisible();
      await expect(page.locator('button[aria-label="정면 사진 AI 배경 제거 테스트"]')).toBeDisabled();
      await assertNoResult(page);
      await expect(aiDialog(page).getByRole('button', { name: '다시 시도', exact: true })).toHaveCount(0);
      expect(requests).toBe(previousRequests + 1);
      if (closeBy === 'Escape') await page.keyboard.press('Escape');
      else await aiDialog(page).getByRole('button', { name: '취소하고 닫기', exact: true }).click();
      await expect(aiDialog(page)).toHaveCount(0);
      releaseRequests();
      await expect(
        form.getByRole('button', { name: '정면 사진 AI 배경 제거 테스트', exact: true }),
      ).toBeEnabled();
      expect(await previewSource(form)).toBe(preview);
      expect(await persistentManifest(page)).toEqual(before);
    }
    await expect(aiDialog(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    releaseRequests();
    await context.unrouteAll({ behavior: 'wait' });
  }
});

test('Web Worker 미지원 환경 안내·재시도와 모바일 닫기 · 모델 요청 없음', async ({ page, context }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() =>
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined }),
  );
  let requests = 0;
  await context.route(modelUrl, async (route) => {
    requests++;
    await route.abort('internetdisconnected');
  });
  const form = await openUploadedProduct(page);
  const before = await persistentManifest(page);
  await startTest(form);
  const dialog = aiDialog(page);
  await expect(dialog.getByRole('alert')).toContainText('Web Worker를 지원하지 않아요');
  await assertNoResult(page);
  await dialog.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('최신 Chrome 또는 Edge');
  const box = await dialog.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  const footerButton = await dialog
    .getByRole('button', { name: '투명 PNG 다운로드', exact: true })
    .boundingBox();
  expect(footerButton!.y + footerButton!.height).toBeLessThanOrEqual(844);
  const uploadButton = await dialog
    .getByRole('button', { name: '투명 PNG 업로드', exact: true })
    .boundingBox();
  expect(uploadButton!.x + uploadButton!.width).toBeLessThanOrEqual(390);
  expect(uploadButton!.y + uploadButton!.height).toBeLessThanOrEqual(844);
  await dialog.screenshot({ path: info.outputPath('unsupported-worker-mobile.png') });
  expect(requests).toBe(0);
  expect(await persistentManifest(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(aiDialog(page)).toHaveCount(0);
  await expect(form.getByRole('button', { name: '배경 수동 지우기', exact: true })).toHaveCount(0);
});
