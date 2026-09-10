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
    .getByLabel('+ 제품 방향 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'failure-only.png', mimeType: 'image/png', buffer });
  await expect(form.getByLabel('+ 제품 방향 이미지 올리기', { exact: true })).toBeEnabled();
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
  await expect(form.getByRole('button', { name: '배경 수동 지우기', exact: true })).toBeEnabled();
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
  await dialog.screenshot({ path: info.outputPath('unsupported-worker-mobile.png') });
  expect(requests).toBe(0);
  expect(await persistentManifest(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(aiDialog(page)).toHaveCount(0);
  await expect(form.getByRole('button', { name: '배경 수동 지우기', exact: true })).toBeEnabled();
});

test('수동 지우기 실제 획·적용 후 AI 입력은 원본 대신 편집된 투명 사진을 유지', async ({ page, context }) => {
  await page.addInitScript(() =>
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined }),
  );
  let requests = 0;
  await context.route(modelUrl, async (route) => {
    requests++;
    await route.abort('internetdisconnected');
  });
  const form = await openUploadedProduct(page);
  const uploadPreview = await previewSource(form);
  await form.getByRole('button', { name: '배경 수동 지우기', exact: true }).click();
  const manual = page.getByRole('dialog', { name: '제품 배경 수동 지우기', exact: true });
  const canvas = manual.getByLabel('배경 제거 브러시 편집 화면', { exact: true });
  await expect(canvas).toBeVisible();
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect!.x + rect!.width * 0.25, rect!.y + rect!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(rect!.x + rect!.width * 0.45, rect!.y + rect!.height * 0.5, { steps: 4 });
  await page.mouse.up();
  await expect(manual.getByRole('button', { name: '한 획 취소', exact: true })).toBeEnabled();
  await manual.getByRole('button', { name: '편집 결과 적용', exact: true }).click();
  await expect(manual).toHaveCount(0);
  await expect.poll(() => previewSource(form)).not.toBe(uploadPreview);

  const edited = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gongganmiri-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const assets = await new Promise<
      { id: string; sourceAssetId?: string; derivation?: string; blob: Blob; width: number; height: number }[]
    >((resolve, reject) => {
      const request = db.transaction('assets').objectStore('assets').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const asset = assets.find((item) => item.derivation === 'manual-alpha');
    if (!asset) throw new Error('수동 지우기 결과에 manual-alpha 메타데이터가 없습니다.');
    const original = assets.find((item) => item.id === asset.sourceAssetId);
    if (!original) throw new Error('수동 편집 결과의 업로드 원본을 찾을 수 없습니다.');
    const digest = async (blob: Blob) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
    const bitmap = await createImageBitmap(asset.blob);
    const pixels = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = pixels.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return {
      width: asset.width,
      height: asset.height,
      derivation: asset.derivation,
      removedAlpha: ctx.getImageData(20, 24, 1, 1).data[3],
      retainedAlpha: ctx.getImageData(60, 2, 1, 1).data[3],
      digest: await digest(asset.blob),
      originalDigest: await digest(original.blob),
    };
  });
  expect(edited.derivation).toBe('manual-alpha');
  expect(edited.removedAlpha).toBe(0);
  expect(edited.retainedAlpha).toBe(255);
  expect(edited.digest).not.toBe(edited.originalDigest);
  const afterManual = await persistentManifest(page);
  await startTest(form);
  const dialog = aiDialog(page);
  await expect(dialog.getByRole('alert')).toContainText('Web Worker를 지원하지 않아요');
  await expect(dialog.getByText('수동 배경 지우기를 적용한 사진', { exact: true })).toBeVisible();
  const originalInput = dialog.getByTestId('background-removal-original');
  await expect(originalInput).toBeVisible();
  const input = await originalInput.evaluate(async (image: HTMLImageElement) => {
    const blob = await (await fetch(image.src)).blob();
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    return { digest, width: image.naturalWidth, height: image.naturalHeight };
  });
  expect(input).toEqual({ digest: edited.digest, width: edited.width, height: edited.height });
  await assertNoResult(page);
  expect(requests).toBe(0);
  expect(await persistentManifest(page)).toEqual(afterManual);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(form.getByRole('button', { name: '배경 수동 지우기', exact: true })).toBeEnabled();
});
