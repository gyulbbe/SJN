import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

// UI/state regression only: this suite injects a controlled Worker PNG response.
// It does not claim model-quality coverage; background-removal.spec.ts runs real inference separately.
test.use({ channel: 'chrome' });
const aiDialog = (page: Page) => page.getByRole('dialog', { name: 'AI 배경 제거 테스트', exact: true });
const previewImages = (page: Page) =>
  page.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true });
type TestControls = {
  releaseBackgroundResult?: () => void;
  holdAssetDecode?: boolean;
  releaseAssetDecode?: () => void;
  failAssetPut?: boolean;
};

async function installControlledWorker(page: Page) {
  const png = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect x="16" y="8" width="32" height="32" fill="white"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await page.addInitScript(
    (bytes) => {
      const controls = window as Window & TestControls;
      const NativeWorker = Worker;
      class ControlledWorker extends EventTarget {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror = null;
        onmessageerror = null;
        stopped = false;
        postMessage(message: { id: number }) {
          this.onmessage?.(
            new MessageEvent('message', {
              data: {
                type: 'progress',
                id: message.id,
                progress: { stage: 'processing', message: '테스트용 결과 전달 대기' },
              },
            }),
          );
          controls.releaseBackgroundResult = () => {
            if (this.stopped) return;
            this.onmessage?.(
              new MessageEvent('message', {
                data: {
                  type: 'result',
                  id: message.id,
                  result: {
                    blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
                    width: 64,
                    height: 48,
                    analysisWidth: 512,
                    analysisHeight: 512,
                    backend: 'wasm',
                    precision: 'fp32',
                    downloadMs: 0,
                    initializationMs: 1,
                    processingMs: 5,
                    inferenceMs: 4,
                    cacheSource: 'memory',
                  },
                },
              }),
            );
          };
        }
        terminate() {
          this.stopped = true;
        }
      }
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        value: function (url: string | URL, options?: WorkerOptions) {
          return options?.name === 'sjn-background-removal'
            ? new ControlledWorker()
            : new NativeWorker(url, options);
        },
      });
      const nativeDecode = createImageBitmap.bind(globalThis);
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: async (...args: Parameters<typeof createImageBitmap>) => {
          if (controls.holdAssetDecode) {
            controls.holdAssetDecode = false;
            await new Promise<void>((resolve) => {
              controls.releaseAssetDecode = resolve;
            });
          }
          return nativeDecode(...args);
        },
      });
      const nativePut = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (value, key) {
        if (controls.failAssetPut && this.name === 'assets')
          throw new DOMException('테스트 저장 공간 부족', 'QuotaExceededError');
        return key === undefined ? nativePut.call(this, value) : nativePut.call(this, value, key);
      };
    },
    [...png],
  );
}

async function productVersions(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gongganmiri-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<import('../src/lib/types').MaterialVersion[]>((resolve, reject) => {
        const request = db.transaction('versions').objectStore('versions').getAll();
        request.onsuccess = () =>
          resolve(
            request.result
              .filter((v: { name: string }) => v.name === 'AI 적용 검증 제품')
              .sort((a: { version: number }, b: { version: number }) => a.version - b.version),
          );
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}

async function openSavedProduct(page: Page) {
  await page.goto('/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
  await form.getByLabel('상품명').fill('AI 적용 검증 제품');
  for (const [i, background] of ['#739789', '#dfc1a3'].entries()) {
    const buffer = await sharp({ create: { width: 64, height: 48, channels: 4, background } })
      .png()
      .toBuffer();
    await form
      .getByLabel('+ 제품 이미지 올리기', { exact: true })
      .setInputFiles({ name: `direction-${i}.png`, mimeType: 'image/png', buffer });
    await expect(previewImages(page)).toHaveCount(i + 1);
    await expect(form.getByLabel('+ 제품 이미지 올리기', { exact: true })).toBeEnabled();
  }
  await form.getByLabel('촬영 방향 2', { exact: true }).fill('오른쪽 측면');
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: '정보 수정', exact: true }).first().click();
  return page.getByRole('dialog', { name: '자재 수정', exact: true });
}

async function releaseResult(page: Page) {
  await expect
    .poll(() => page.evaluate(() => typeof (window as Window & TestControls).releaseBackgroundResult))
    .toBe('function');
  await page.evaluate(() => (window as Window & TestControls).releaseBackgroundResult?.());
  await expect(aiDialog(page).getByRole('button', { name: '투명 PNG 업로드', exact: true })).toBeEnabled();
}

async function imagePixels(image: ReturnType<typeof previewImages>) {
  return image.evaluate(async (element: HTMLImageElement) => {
    const blob = await (await fetch(element.src)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return {
      width: canvas.width,
      height: canvas.height,
      edge: ctx.getImageData(0, 0, 1, 1).data[3],
      center: ctx.getImageData(32, 24, 1, 1).data[3],
    };
  });
}

test('모의 결과 UI: 선택 방향에만 PNG 적용 · 준비/저장 중 중복 방지 · 저장 후 새 버전·재진입', async ({
  page,
}) => {
  await installControlledWorker(page);
  let form = await openSavedProduct(page);
  const beforeVersions = await productVersions(page);
  const beforeSources = await previewImages(page).evaluateAll((images) =>
    images.map((image) => (image as HTMLImageElement).src),
  );
  await form.getByRole('button', { name: '오른쪽 측면 사진 AI 배경 제거 테스트', exact: true }).click();
  const dialog = aiDialog(page);
  const apply = dialog.getByRole('button', { name: '투명 PNG 업로드', exact: true });
  await expect(apply).toBeDisabled();
  await releaseResult(page);
  await expect(dialog.getByRole('button', { name: '투명 PNG 다운로드', exact: true })).toBeEnabled();
  expect(await productVersions(page)).toEqual(beforeVersions);
  await page.evaluate(() => {
    (window as Window & TestControls).holdAssetDecode = true;
  });
  await apply.click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as Window & TestControls).releaseAssetDecode))
    .toBe('function');
  await expect(dialog.getByRole('button', { name: /업로드 중|적용 중|투명 PNG 업로드/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as Window & TestControls).releaseAssetDecode?.());
  await expect(dialog).toHaveCount(0);
  expect(await previewImages(page).first().getAttribute('src')).toBe(beforeSources[0]);
  await expect.poll(() => previewImages(page).nth(1).getAttribute('src')).not.toBe(beforeSources[1]);
  expect(await imagePixels(previewImages(page).nth(1))).toEqual({
    width: 64,
    height: 48,
    edge: 0,
    center: 255,
  });
  expect(await productVersions(page)).toEqual(beforeVersions);
  await expect(form.getByLabel('촬영 방향 2', { exact: true })).toHaveValue('오른쪽 측면');
  await form.getByRole('button', { name: '새 버전 저장', exact: true }).click();
  await expect(form).toHaveCount(0);
  const versions = await productVersions(page);
  expect(versions).toHaveLength(2);
  expect(versions[0]).toEqual(beforeVersions[0]);
  expect(versions[1].views[0]).toEqual(versions[0].views[0]);
  expect(versions[1].views[1].assetId).not.toBe(versions[0].views[1].assetId);
  expect(versions[1].views[1].anchor).toEqual(versions[0].views[1].anchor);
  await page.reload();
  await page.getByRole('button', { name: '정보 수정', exact: true }).first().click();
  form = page.getByRole('dialog', { name: '자재 수정', exact: true });
  await expect(previewImages(page)).toHaveCount(2);
  expect(await imagePixels(previewImages(page).nth(1))).toEqual({
    width: 64,
    height: 48,
    edge: 0,
    center: 255,
  });
  await expect(form.getByRole('button', { name: '배경 수동 지우기', exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: '오른쪽 측면 사진 AI 배경 제거 테스트', exact: true }).click();
  await expect(aiDialog(page).getByTestId('background-removal-original')).toBeVisible();
  expect(await imagePixels(aiDialog(page).getByTestId('background-removal-original'))).toEqual({
    width: 64,
    height: 48,
    edge: 0,
    center: 255,
  });
  await aiDialog(page).getByRole('button', { name: '취소하고 닫기', exact: true }).click();
});

test('모의 결과 UI: PNG 적용 저장 실패 시 창·원본 유지, 같은 결과로 재시도', async ({ page }) => {
  await installControlledWorker(page);
  const form = await openSavedProduct(page);
  const versions = await productVersions(page);
  const source = await previewImages(page).nth(1).getAttribute('src');
  await form.getByRole('button', { name: '오른쪽 측면 사진 AI 배경 제거 테스트', exact: true }).click();
  await releaseResult(page);
  await page.evaluate(() => {
    (window as Window & TestControls).failAssetPut = true;
  });
  const dialog = aiDialog(page);
  await dialog.getByRole('button', { name: '투명 PNG 업로드', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('background-removal-result')).toBeVisible();
  expect(await previewImages(page).nth(1).getAttribute('src')).toBe(source);
  expect(await productVersions(page)).toEqual(versions);
  await expect(dialog.getByRole('button', { name: '투명 PNG 다운로드', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    (window as Window & TestControls).failAssetPut = false;
  });
  await dialog.getByRole('button', { name: '투명 PNG 업로드', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => previewImages(page).nth(1).getAttribute('src')).not.toBe(source);
});

test('모의 결과 UI: 업로드 없이 결과 창 닫으면 현재 방향 사진과 저장 버전 유지', async ({ page }) => {
  await installControlledWorker(page);
  const form = await openSavedProduct(page);
  const versions = await productVersions(page);
  const sources = await previewImages(page).evaluateAll((images) =>
    images.map((image) => (image as HTMLImageElement).src),
  );
  await form.getByRole('button', { name: '오른쪽 측면 사진 AI 배경 제거 테스트', exact: true }).click();
  await releaseResult(page);
  await aiDialog(page).getByRole('button', { name: '닫기', exact: true }).click();
  await expect(aiDialog(page)).toHaveCount(0);
  expect(
    await previewImages(page).evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src)),
  ).toEqual(sources);
  expect(await productVersions(page)).toEqual(versions);
});
