import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { seedTestTiles, uploadBathroomPhoto } from '../tests/helpers/catalog-fixtures.mjs';
import { BACKGROUND_MODEL_FILES } from '../src/lib/background-removal/model';
import { PRODUCT3D_FILES } from '../src/lib/product3d/model';
import { MOGE_ARTIFACT } from '../src/lib/reconstruction/moge-browser/artifact';

// UI only: scripted Workers replay the progress messages each model sends. No model is downloaded
// and no inference or cloud AI runs; the percentage maths is unit tested in tests/ai-progress.test.ts.
let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(120000);

const captures = resolve('test-results/ai-model-loading-progress');
mkdirSync(captures, { recursive: true });
type Kind = 'background' | 'product3d' | 'moge' | 'segmentation';
type MockWindow = Window & {
  __mockJobs: { kind: Kind; send: (data: Record<string, unknown>) => void }[];
  __mockUnnamed: boolean;
};

/** Named AI workers are always scripted; unnamed ones (DeepLab) only after `mockUnnamed`. */
async function installScriptedWorkers(page: Page) {
  await page.addInitScript(() => {
    const target = window as unknown as MockWindow;
    target.__mockJobs = [];
    target.__mockUnnamed = false;
    const NativeWorker = Worker;
    class ScriptedWorker extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      stopped = false;
      constructor(private kind: Kind) {
        super();
      }
      postMessage(message: { id: number }) {
        target.__mockJobs.push({
          kind: this.kind,
          send: (data) => {
            if (!this.stopped)
              this.onmessage?.(new MessageEvent('message', { data: { ...data, id: message.id } }));
          },
        });
      }
      terminate() {
        this.stopped = true;
      }
    }
    const names: Record<string, Kind> = {
      'sjn-background-removal': 'background',
      'sjn-product3d': 'product3d',
      'sjn-moge2': 'moge',
    };
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: function (url: string | URL, options?: WorkerOptions) {
        const kind = options?.name ? names[options.name] : target.__mockUnnamed ? 'segmentation' : undefined;
        return kind ? new ScriptedWorker(kind) : new NativeWorker(url, options);
      },
    });
  });
}
async function send(page: Page, kind: Kind, data: Record<string, unknown>) {
  await expect
    .poll(() =>
      page.evaluate((k) => (window as unknown as MockWindow).__mockJobs.some((job) => job.kind === k), kind),
    )
    .toBe(true);
  await page.evaluate(
    ({ kind, data }) =>
      (window as unknown as MockWindow).__mockJobs
        .filter((job) => job.kind === kind)
        .at(-1)!
        .send(data),
    { kind, data },
  );
}
const jobCount = (page: Page, kind: Kind) =>
  page.evaluate(
    (k) => (window as unknown as MockWindow).__mockJobs.filter((job) => job.kind === k).length,
    kind,
  );
async function segmentationResult(page: Page) {
  await page.evaluate(() =>
    (window as unknown as MockWindow).__mockJobs
      .filter((job) => job.kind === 'segmentation')
      .at(-1)!
      .send({
        type: 'result',
        result: { width: 32, height: 24, objects: [], floor: new Uint8Array(768), wall: new Uint8Array(768) },
      }),
  );
}

async function percentOf(progress: Locator) {
  return Number(await progress.getByRole('progressbar').getAttribute('aria-valuenow'));
}
/** The bar's aria values and the big number agree, and the value only grows. */
async function expectPercent(progress: Locator, previous: number) {
  const bar = progress.getByRole('progressbar');
  await expect(bar).toHaveAttribute('aria-valuemin', '0');
  await expect(bar).toHaveAttribute('aria-valuemax', '100');
  await expect.poll(() => percentOf(progress)).toBeGreaterThan(previous);
  // Estimated steps keep rising every 250 ms: read the three values from one moment, not in turns.
  const snapshot = () =>
    progress.evaluate((element) => {
      const meter = element.querySelector('[role="progressbar"]')!;
      return {
        now: Number(meter.getAttribute('aria-valuenow')),
        text: meter.getAttribute('aria-valuetext') ?? '',
        big: element.querySelector('[data-testid="model-loading-percent"]')?.textContent ?? '',
      };
    });
  await expect
    .poll(async () => {
      const s = await snapshot();
      return s.big === `${s.now}%` && s.text.includes(`${s.now}%`) && s.now > previous;
    })
    .toBe(true);
  return (await snapshot()).now;
}
async function capture(page: Page, name: string, progress: Locator) {
  await progress.screenshot({ path: resolve(captures, `${name}.png`) });
  void page;
}
async function expectNoOverflow(page: Page, progress: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = await progress.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
}

async function openProductForm(page: Page, transparent = false) {
  await page.goto('/admin/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption(transparent ? 'toilet' : 'basin');
  await form.getByLabel('상품명').fill('로딩 진행률 검증 제품');
  const buffer = transparent
    ? await sharp(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect x="24" y="16" width="48" height="64" fill="#f2f1ec"/></svg>',
        ),
      )
        .png()
        .toBuffer()
    : await sharp({ create: { width: 64, height: 48, channels: 4, background: '#a9bec0' } })
        .png()
        .toBuffer();
  await form
    .getByLabel('+ 제품 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'progress.png', mimeType: 'image/png', buffer });
  await expect(
    form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
  ).toBeVisible();
  await expect(form.getByLabel('+ 제품 이미지 올리기', { exact: true })).toBeEnabled();
  return form;
}

for (const width of [1440, 390])
  test(`배경 제거: 실행 모듈부터 초기화까지 전체 %·MB, 완료 뒤 처리 단계로 전환 (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await installScriptedWorkers(page);
    const form = await openProductForm(page);
    await form.getByRole('button', { name: '정면 사진 AI 배경 제거 테스트', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'AI 배경 제거 테스트', exact: true });
    const progress = dialog.getByTestId('model-loading-progress');
    // The runtime step starts before the worker exists; the bar keeps its old accessible name.
    await expect(dialog.getByRole('progressbar', { name: '모델 다운로드 진행' })).toBeVisible();
    const total = BACKGROUND_MODEL_FILES.fp16.bytes;
    let value = await percentOf(progress);
    await send(page, 'background', {
      type: 'progress',
      progress: {
        stage: 'download',
        message: 'FP16 AI 모델 다운로드 중',
        loadedBytes: total * 0.25,
        totalBytes: total,
      },
    });
    value = await expectPercent(progress, value);
    await expect(progress).toContainText(
      `${((total * 0.25) / 1_048_576).toFixed(1)} / ${(total / 1_048_576).toFixed(1)} MB`,
    );
    await expect(progress).toContainText('처음 한 번만 내려받아요');
    await send(page, 'background', {
      type: 'progress',
      progress: {
        stage: 'download',
        message: 'FP16 AI 모델 다운로드 중',
        loadedBytes: total * 0.75,
        totalBytes: total,
      },
    });
    value = await expectPercent(progress, value);
    await capture(page, `background-removal-${width}`, progress);
    if (width === 390) await expectNoOverflow(page, progress);
    await send(page, 'background', {
      type: 'progress',
      progress: { stage: 'initializing', message: '모델 준비 중' },
    });
    value = await expectPercent(progress, value);
    expect(value).toBeLessThanOrEqual(99);
    await send(page, 'background', {
      type: 'progress',
      progress: { stage: 'processing', message: '이미지 처리 중' },
    });
    await expect(progress.getByTestId('model-loading-percent')).toHaveText('100%');
    await expect(progress).toHaveCount(0);
    await expect(dialog.getByRole('status')).toContainText('이미지 처리 중');
  });

test('배경 제거: 모델 준비 중 취소하면 표시가 바로 사라진다', async ({ page }) => {
  await installScriptedWorkers(page);
  const form = await openProductForm(page);
  await form.getByRole('button', { name: '정면 사진 AI 배경 제거 테스트', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 배경 제거 테스트', exact: true });
  await expect(dialog.getByTestId('model-loading-progress')).toBeVisible();
  await dialog.getByRole('button', { name: '취소하고 닫기', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('model-loading-progress')).toHaveCount(0);
});

test('360° 입체화: 세 모델 파일 합산 %, 추론 사이 단계 문구, 캐시 안내, 취소', async ({ page }) => {
  await installScriptedWorkers(page);
  const form = await openProductForm(page, true);
  await form.getByRole('button', { name: '정면 사진 AI 360° 입체화', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '360° 제품 편집', exact: true });
  await dialog.getByRole('button', { name: '입체화 시작', exact: true }).click();
  await send(page, 'product3d', {
    type: 'progress',
    progress: { stage: 'loading-runtime', message: '실행 모듈' },
  });
  const progress = dialog.getByTestId('model-loading-progress');
  await expect(dialog.getByRole('progressbar', { name: '입체화 모델 다운로드' })).toBeVisible();
  let value = await percentOf(progress);
  const encoder = PRODUCT3D_FILES.encoder.bytes;
  await send(page, 'product3d', {
    type: 'progress',
    progress: {
      stage: 'download',
      part: 'encoder',
      message: '저장된 사진 분석 모델을 불러오는 중',
      loadedBytes: encoder,
      totalBytes: encoder,
      source: 'cache',
    },
  });
  value = await expectPercent(progress, value);
  await expect(progress).toContainText('저장된 모델을 불러오는 중이에요.');
  await send(page, 'product3d', {
    type: 'progress',
    progress: { stage: 'initializing', part: 'encoder', message: '사진 분석 모델을 GPU에 준비하고 있어요.' },
  });
  await send(page, 'product3d', {
    type: 'progress',
    progress: { stage: 'encoding', message: '형태와 색상 분석 중' },
  });
  // Between model files the percentage holds and the current inference stage is shown.
  await expect(dialog.getByRole('status')).toContainText('형태와 색상 분석 중');
  await expect(progress).toBeVisible();
  const backbone = PRODUCT3D_FILES.backbone.bytes;
  await send(page, 'product3d', {
    type: 'progress',
    progress: {
      stage: 'download',
      part: 'backbone',
      message: '제품 형태 복원 모델 다운로드 중',
      loadedBytes: backbone / 2,
      totalBytes: backbone,
    },
  });
  await expectPercent(progress, value);
  await capture(page, 'product3d-1440', progress);
  await dialog.getByRole('button', { name: '생성 취소', exact: true }).click();
  await expect(progress).toHaveCount(0);
});

async function openCreate(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '사진으로 비교 공간 만들기', exact: true });
  await dialog.getByTestId('reconstruction-upload').setInputFiles(resolve('public/examples/bathroom.png'));
  return dialog;
}
async function deeplabLoading(page: Page, container: Locator, sequence?: string) {
  await send(page, 'segmentation', { type: 'model-progress', phase: 'runtime' });
  const progress = container.getByTestId('model-loading-progress');
  await expect(progress).toBeVisible();
  if (sequence) await expect(progress).toContainText(sequence);
  let value = await percentOf(progress);
  await send(page, 'segmentation', { type: 'model-progress', phase: 'download', fraction: 0.3 });
  value = await expectPercent(progress, value);
  await send(page, 'segmentation', { type: 'model-progress', phase: 'download', fraction: 0.9 });
  value = await expectPercent(progress, value);
  expect(value).toBeLessThanOrEqual(99);
  return progress;
}

test('사진으로 시작: DeepLab 준비 %, 완료 뒤 기존 단계 문구, 초안 생성까지', async ({ page }) => {
  await installScriptedWorkers(page);
  const dialog = await openCreate(page);
  await page.evaluate(() => ((window as unknown as MockWindow).__mockUnnamed = true));
  await dialog.getByRole('button', { name: '자동 초안 만들기' }).click();
  const progress = await deeplabLoading(page, dialog);
  await expect(dialog.getByTestId('reconstruction-progress')).toBeVisible();
  await capture(page, 'reconstruction-dialog-1440', progress);
  await send(page, 'segmentation', { type: 'model-progress', phase: 'ready' });
  await expect(progress).toHaveCount(0);
  await send(page, 'segmentation', { type: 'stage', message: '사진 크기와 방향 확인 중' });
  await expect(dialog.getByTestId('reconstruction-progress')).toHaveText('사진 크기와 방향 확인 중');
  await segmentationResult(page);
  await expect(page).toHaveURL(/\/projects\//, { timeout: 45000 });

  // 사진 다시 분석: the same display in the rebuild dialog, cancelled mid-way.
  await page.getByRole('button', { name: '기존 공간 수정', exact: true }).click();
  await page.getByRole('button', { name: '사진 다시 분석', exact: true }).click();
  const rebuild = page.getByRole('dialog', { name: 'Before 사진 다시 분석', exact: true });
  const earlier = await jobCount(page, 'segmentation');
  await rebuild.getByRole('button', { name: 'Before 다시 만들기', exact: true }).click();
  // Reanalysis starts a new DeepLab job; do not script the finished one.
  await expect.poll(() => jobCount(page, 'segmentation')).toBeGreaterThan(earlier);
  const again = await deeplabLoading(page, rebuild);
  await capture(page, 'reconstruction-rebuild-1440', again);
  await rebuild.getByRole('button', { name: '취소', exact: true }).click();
  await expect(rebuild).toHaveCount(0);
  await expect(page.getByTestId('model-loading-progress')).toHaveCount(0);
});

test('사진으로 시작 390px: 표시가 넘치지 않고 취소하면 사라진다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installScriptedWorkers(page);
  const dialog = await openCreate(page);
  await page.evaluate(() => ((window as unknown as MockWindow).__mockUnnamed = true));
  await dialog.getByRole('button', { name: '자동 초안 만들기' }).click();
  const progress = await deeplabLoading(page, dialog);
  await expectNoOverflow(page, progress);
  await capture(page, 'reconstruction-dialog-390', progress);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByTestId('model-loading-progress')).toHaveCount(0);
});

test('실험실: DeepLab 1/2 → MoGe 2/2 순서 표시와 취소', async ({ page }) => {
  await installScriptedWorkers(page);
  await page.goto('/reconstruction-performance');
  await page.evaluate(() => ((window as unknown as MockWindow).__mockUnnamed = true));
  await page
    .getByLabel('테스트할 사진', { exact: true })
    .setInputFiles(resolve('public/examples/bathroom.png'));
  await page.getByLabel('테스트 종류', { exact: true }).selectOption('geometry');
  await page.getByRole('button', { name: '테스트 실행', exact: true }).click();
  const main = page.locator('body');
  await deeplabLoading(page, main, 'AI 모델 준비 1/2');
  await send(page, 'segmentation', { type: 'model-progress', phase: 'ready' });
  await segmentationResult(page);
  await send(page, 'moge', {
    type: 'progress',
    progress: { stage: 'checking', message: '저장된 모델 확인 중' },
  });
  await send(page, 'moge', {
    type: 'progress',
    progress: {
      stage: 'downloading',
      message: 'MoGe 모델 다운로드 중',
      loaded: MOGE_ARTIFACT.bytes * 0.4,
      total: MOGE_ARTIFACT.bytes,
    },
  });
  const moge = main.getByTestId('model-loading-progress');
  await expect(moge).toContainText('AI 모델 준비 2/2');
  await expect(moge).toContainText('깊이 분석 AI 모델(MoGe)');
  await expect.poll(() => percentOf(moge)).toBeGreaterThan(30);
  await capture(page, 'lab-moge-1440', moge);
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByTestId('model-loading-progress')).toHaveCount(0);
});

test('편집기 사진 자동 분석: 토스트 안 compact % 표시와 취소', async ({ page }) => {
  await installScriptedWorkers(page);
  await page.goto('/');
  await seedTestTiles(page);
  await uploadBathroomPhoto(page);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await page.evaluate(() => ((window as unknown as MockWindow).__mockUnnamed = true));
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '차콜 스톤' }).click();
  const toast = page.getByTestId('auto-detection-status');
  const progress = await deeplabLoading(page, toast);
  await capture(page, 'editor-toast-1440', progress);
  await toast.getByRole('button', { name: '영역 찾기 취소', exact: true }).click();
  await expect(page.getByTestId('model-loading-progress')).toHaveCount(0);
});
