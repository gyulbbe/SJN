import { expect, test, type Locator, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { BACKGROUND_MODEL_CACHE, backgroundModelUrl } from '../src/lib/background-removal/model';

const fp16Url = backgroundModelUrl('fp16');
const fp32Url = backgroundModelUrl('fp32');

type QaState = {
  injectGpuFailure: boolean;
  deviceFailures: number;
  encodingBlocked: boolean;
  workerStarts: number;
  latestProgress?: { stage: string; message: string; loadedBytes?: number; totalBytes?: number };
  bootstrapError?: string;
  blockedWorker?: Worker;
};

test.use({ channel: 'chrome', launchOptions: { args: [] } });

/** Only fault injection and a timing gate: all model bytes, inference and PNG encoding remain real. */
function workerFaultHooks() {
  const scope = globalThis as unknown as {
    postMessage(message: unknown): void;
    addEventListener(type: string, callback: (event: MessageEvent) => void): void;
  };
  try {
    const gpu = (
      navigator as unknown as {
        gpu?: {
          requestAdapter(...options: unknown[]): Promise<{ requestDevice(): Promise<unknown> } | null>;
        };
      }
    ).gpu;
    if (!gpu) throw new Error('Cache fault test needs Worker WebGPU support.');
    const requestAdapter = gpu.requestAdapter.bind(gpu);
    Object.defineProperty(gpu, 'requestAdapter', {
      configurable: true,
      value: async (...options: unknown[]) => {
        const adapter = await requestAdapter(...options);
        if (adapter)
          Object.defineProperty(adapter, 'requestDevice', {
            configurable: true,
            value() {
              scope.postMessage({ __sjnCacheQa: 'device-failure' });
              return Promise.reject(
                new DOMException('QA forced GPU device initialization failure', 'OperationError'),
              );
            },
          });
        return adapter;
      },
    });
    let releasePng: (() => void) | undefined;
    scope.addEventListener('message', (event) => {
      if (event.data?.__sjnReleasePng) releasePng?.();
    });
    const encode = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = async function (options?: ImageEncodeOptions) {
      scope.postMessage({ __sjnCacheQa: 'before-png' });
      await new Promise<void>((resolve) => {
        releasePng = resolve;
      });
      return encode.call(this, options);
    };
  } catch (error) {
    scope.postMessage({
      __sjnCacheQa: 'bootstrap-error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function injectGpuDeviceFailure(page: Page) {
  await page.addInitScript(() => {
    const state: QaState = {
      injectGpuFailure: true,
      deviceFailures: 0,
      encodingBlocked: false,
      workerStarts: 0,
    };
    let lastProgressKey = '';
    (window as unknown as { __sjnBackgroundCacheQa: QaState }).__sjnBackgroundCacheQa = state;
    const NativeWorker = window.Worker;
    class DiagnosticWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        // Keep the native URL, hash and worker type. Turbopack relies on all three.
        super(scriptURL, options);
        if (options?.name === 'sjn-background-removal') {
          state.workerStarts++;
          this.addEventListener('message', (event) => {
            if (event.data?.type === 'progress') {
              state.latestProgress = event.data.progress;
              const { stage, message, loadedBytes, totalBytes } = event.data.progress;
              const key = `${message}:${Math.floor((loadedBytes ?? 0) / (32 * 1024 * 1024))}`;
              if (key !== lastProgressKey) {
                lastProgressKey = key;
                console.info(
                  '[background-cache-qa]',
                  JSON.stringify({ stage, message, loadedBytes, totalBytes }),
                );
              }
            }
            if (event.data?.__sjnCacheQa === 'device-failure') state.deviceFailures++;
            if (event.data?.__sjnCacheQa === 'bootstrap-error') state.bootstrapError = event.data.message;
            if (event.data?.__sjnCacheQa === 'before-png') {
              state.encodingBlocked = true;
              state.blockedWorker = this;
              console.info('[background-cache-qa] actual CPU inference complete; PNG encoding gate reached');
            }
          });
        }
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: DiagnosticWorker });
  });
  await page.route(
    (url) =>
      url.pathname.includes('/turbopack-worker-') || /\/workers\/worker-[\w-]+\.js$/.test(url.pathname),
    async (route) => {
      const inject = await page.evaluate(
        () =>
          (window as unknown as { __sjnBackgroundCacheQa: QaState }).__sjnBackgroundCacheQa.injectGpuFailure,
      );
      if (!inject) return route.continue();
      const response = await route.fetch();
      // Instrument only the worker entry; model files and runtime output are never replaced.
      await route.fulfill({
        response,
        body: `(${workerFaultHooks.toString()})();\n${await response.text()}`,
      });
    },
  );
}

async function cacheKeys(page: Page) {
  return page.evaluate(async (cacheName) => {
    if (!(await caches.has(cacheName))) return [];
    return (await (await caches.open(cacheName)).keys()).map((request) => request.url).sort();
  }, BACKGROUND_MODEL_CACHE);
}

async function qaState(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as { __sjnBackgroundCacheQa: QaState }).__sjnBackgroundCacheQa;
    return {
      deviceFailures: state.deviceFailures,
      encodingBlocked: state.encodingBlocked,
      workerStarts: state.workerStarts,
      latestProgress: state.latestProgress,
      bootstrapError: state.bootstrapError,
    };
  });
}

async function awaitResult(page: Page, dialog: Locator) {
  await expect
    .poll(
      async () => {
        if ((await qaState(page)).bootstrapError) return 'bootstrap-error';
        if (await dialog.getByRole('alert').count()) return 'error';
        if (await dialog.getByRole('button', { name: '투명 PNG 다운로드', exact: true }).isEnabled())
          return 'ready';
        return 'pending';
      },
      { timeout: 840_000, intervals: [500, 1000, 2000] },
    )
    .not.toBe('pending');
  expect((await qaState(page)).bootstrapError).toBeUndefined();
  if (await dialog.getByRole('alert').count()) throw new Error(await dialog.getByRole('alert').innerText());
  await expect(dialog).toContainText('CPU · WASM / FP32');
}

async function pngBytes(dialog: Locator) {
  const image = dialog.getByTestId('background-removal-result');
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1536);
  return Buffer.from(
    await image.evaluate(async (element) => {
      const bytes = new Uint8Array(await (await fetch((element as HTMLImageElement).src)).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return btoa(binary);
    }),
    'base64',
  );
}

test('GPU 준비 실패 → 실제 CPU PNG 성공 후 FP16 정리 → GPU 복구해도 저장된 FP32 우선 재사용', async ({
  page,
}, info) => {
  test.skip(
    process.env.SJN_AI_BACKGROUND_CACHE !== '1',
    'SJN_AI_BACKGROUND_CACHE=1로 실제 FP16+FP32 모델과 CPU 추론을 검증합니다.',
  );
  test.setTimeout(1_800_000);
  const modelRequests: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('[background-cache-qa]'))
      console.info(new Date().toISOString(), message.text());
  });
  page.on('request', (request) => {
    if (request.url() === fp16Url || request.url() === fp32Url) modelRequests.push(request.url());
  });
  await injectGpuDeviceFailure(page);
  await page.goto('/materials');
  const capabilities = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    return { adapter: !!adapter, fp16: !!adapter?.features.has('shader-f16') };
  });
  expect(capabilities, 'This opt-in fault test requires an FP16-capable hardware WebGPU adapter.').toEqual({
    adapter: true,
    fp16: true,
  });
  expect(await cacheKeys(page)).toEqual([]);
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  await form.getByLabel('상품명').fill('실제 캐시 전환 검증');
  await form
    .getByLabel('+ 제품 이미지 올리기', { exact: true })
    .setInputFiles(path.resolve('test-results/background-removal/fixtures/white-toilet.jpg'));
  await expect(form.getByRole('button', { name: /AI 배경 제거 테스트/ })).toBeEnabled();
  await form.getByRole('button', { name: /AI 배경 제거 테스트/ }).click();
  let dialog = page.getByRole('dialog', { name: 'AI 배경 제거 테스트', exact: true });
  await expect(dialog).toBeVisible();

  await expect
    .poll(
      async () => {
        const qa = await qaState(page);
        if (qa.bootstrapError) return 'bootstrap-error';
        if (await dialog.getByRole('alert').count()) return 'error';
        return qa.encodingBlocked ? 'png-pending' : 'pending';
      },
      { timeout: 840_000, intervals: [500, 1000, 2000] },
    )
    .not.toBe('pending');
  const beforeEncoding = await qaState(page);
  expect(beforeEncoding.bootstrapError).toBeUndefined();
  if (await dialog.getByRole('alert').count()) throw new Error(await dialog.getByRole('alert').innerText());
  expect(beforeEncoding.deviceFailures).toBeGreaterThan(0);
  expect(beforeEncoding.encodingBlocked).toBe(true);
  // FP16 remains recoverable until CPU output PNG encoding actually succeeds.
  expect(await cacheKeys(page)).toEqual([fp16Url, fp32Url].sort());
  await expect(dialog.getByRole('button', { name: '투명 PNG 다운로드', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    (
      window as unknown as { __sjnBackgroundCacheQa: QaState }
    ).__sjnBackgroundCacheQa.blockedWorker!.postMessage({ __sjnReleasePng: true });
  });
  await awaitResult(page, dialog);
  const firstPng = await pngBytes(dialog);
  expect(await sharp(firstPng).metadata()).toMatchObject({
    format: 'png',
    width: 1536,
    height: 2048,
    hasAlpha: true,
  });
  await writeFile(info.outputPath('cpu-fallback-result.png'), firstPng);
  await expect.poll(() => cacheKeys(page)).toEqual([fp32Url]);
  expect(modelRequests).toEqual([fp16Url, fp32Url]);
  const firstSummary = await dialog.innerText();
  console.info('[background-cache-qa] first actual CPU PNG ready; FP16 deleted, FP32 retained');
  await dialog.screenshot({ path: info.outputPath('cpu-fallback-result.png-ui.png') });
  await dialog.getByRole('button', { name: /닫기/ }).click();
  await expect(dialog).toHaveCount(0);

  // A new, unmodified worker sees the real GPU again, but persisted FP32 must win.
  await page.evaluate(() => {
    const state = (window as unknown as { __sjnBackgroundCacheQa: QaState }).__sjnBackgroundCacheQa;
    state.injectGpuFailure = false;
    state.encodingBlocked = false;
    state.blockedWorker = undefined;
  });
  const requestsBeforeSecond = modelRequests.length;
  await form.getByRole('button', { name: /AI 배경 제거 테스트/ }).click();
  dialog = page.getByRole('dialog', { name: 'AI 배경 제거 테스트', exact: true });
  await awaitResult(page, dialog);
  await expect(dialog.getByTestId('background-removal-download-time')).toHaveText('0.00초');
  await expect(dialog).toContainText('브라우저 캐시 사용');
  expect(modelRequests.length - requestsBeforeSecond).toBe(0);
  expect(await cacheKeys(page)).toEqual([fp32Url]);
  expect((await qaState(page)).deviceFailures).toBe(beforeEncoding.deviceFailures);
  console.info('[background-cache-qa] second actual CPU PNG ready; zero additional model requests');
  const secondPng = await pngBytes(dialog);
  expect(await sharp(secondPng).metadata()).toMatchObject({
    format: 'png',
    width: 1536,
    height: 2048,
    hasAlpha: true,
  });
  await writeFile(info.outputPath('cpu-cache-reused-result.png'), secondPng);
  await dialog.screenshot({ path: info.outputPath('cpu-cache-reused-ui.png') });
  await writeFile(
    info.outputPath('cache-policy-measurements.json'),
    JSON.stringify(
      {
        capabilities,
        gpuFailureCount: beforeEncoding.deviceFailures,
        workerStarts: (await qaState(page)).workerStarts,
        modelRequests,
        secondRunModelRequests: modelRequests.length - requestsBeforeSecond,
        remainingCache: await cacheKeys(page),
        firstSummary,
        secondSummary: await dialog.innerText(),
        browser: await page.evaluate(() => navigator.userAgent),
      },
      null,
      2,
    ),
  );
});
