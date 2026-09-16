import {
  SHOWER_INSTALLATION_CONTRACT,
  SHOWER_INSTALLATION_PROMPT_REVISION,
  validateShowerInstallationReceipt,
  type ShowerInstallationReceipt,
} from '../src/lib/reconstruction/shower-installation-observation';
import { targetExistenceSha256 } from '../src/lib/reconstruction/target-existence-observation';
import { CLOUD_GEMMA_APPEARANCE_METADATA } from '../src/lib/reconstruction/cloud-gemma-appearance';
import { CLOUD_GEMMA_GROUPED_INVENTORY_METADATA } from '../src/lib/reconstruction/cloud-gemma-inventory';
import {
  validateCloudFixtureCropReceipt,
  type CloudFixtureCropReceipt,
} from '../src/lib/reconstruction/cloud-fixture-crops';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { DesignDocument, ProjectDocument } from '../src/lib/types';
import { getActiveDesign } from '../src/lib/designs';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
import {
  CLOUD_GEMMA_MODEL,
  CLOUD_GEMMA_REVISION,
  CLOUD_GEMMA_IDENTITY,
} from '../src/lib/reconstruction/cloud-gemma-contract';
import {
  EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  EXTENDED_INVENTORY_PROMPT_REVISION,
} from '../src/lib/reconstruction/inventory-observation';
import {
  MOGE_ARTIFACT,
  MOGE_PREPROCESS_VERSION,
  MOGE_NUM_TOKENS,
  MOGE_RUNTIME_VERSION,
} from '../src/lib/reconstruction/moge-browser/artifact';
import { MOGE_POSTPROCESS_VERSION } from '../src/lib/reconstruction/moge-browser/postprocess';
import { MOGE_PLANES_VERSION } from '../src/lib/reconstruction/moge-browser/planes';

// UI/transport integration ONLY: authored observations, HTTP and Worker boundaries mocked.
// Never run external AI, download a model, or present these images as reconstruction quality evidence.
test.use({ channel: 'chrome', serviceWorkers: 'block', actionTimeout: 15000 });
const cloudPath = '**/api/reconstruction/cloud';
const dialog = (page: Page) => page.getByRole('dialog', { name: '사진으로 비교 공간 만들기', exact: true });
const aiRadio = (page: Page) => page.getByRole('radio', { name: /^AI 정밀 분석/ });
const basicRadio = (page: Page) => page.getByRole('radio', { name: /^브라우저 기본 분석/ });
// Existing document migration materializes optional empty/default fields; compare the complete semantic design.
const comparableDesign = (design: DesignDocument) => ({
  ...design,
  renderRevision: design.renderRevision ?? design.revision,
  materialUsage: design.materialUsage ?? {
    version: 1,
    assignments: {},
    areas: {},
    quantities: {},
    aggregateAreas: [],
  },
});
const inventory = () => ({
  ...CLOUD_GEMMA_GROUPED_INVENTORY_METADATA,
  provider: 'cloudflare-workers-ai',
  modelId: CLOUD_GEMMA_MODEL,
  modelRevision: CLOUD_GEMMA_REVISION,
  modelIdentity: CLOUD_GEMMA_IDENTITY,
  outputContract: EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  promptRevision: EXTENDED_INVENTORY_PROMPT_REVISION,
  rawText: JSON.stringify({
    sanitary: [],
    mirrors_storage: [],
    partitions: [],
    showers_shelves: [],
    openings: [],
  }),
  measurement: {
    requestMs: 12,
    inputWidth: 320,
    inputHeight: 240,
    inferenceMs: 10,
    modelLoadMs: 0,
    modelDownload: 'provider-managed',
    memoryScope: 'MOCK HTTP: no actual inference',
    inferenceCalls: 1,
    inputTokens: 23,
    outputTokens: 5,
  },
});
async function setup(
  page: Page,
  opts: {
    unavailable?: boolean;
    fail?: boolean;
    pending?: boolean;
    nonEmpty?: boolean;
    corruptBoardReceipt?: boolean;
    shower?: boolean;
    corruptShowerReceipt?: boolean;
  } = {},
) {
  const appearanceReceipts: CloudFixtureCropReceipt[] = [];
  const showerReceipts: ShowerInstallationReceipt[] = [];
  const fixtureKind = opts.shower ? 'shower' : 'toilet';
  const posts: string[] = [],
    forbidden: string[] = [];
  await page.route(/https:\/\/(huggingface\.co|cdn\.jsdelivr\.net|.*\.workers\.ai)\//, (route) => {
    forbidden.push(route.request().url());
    return route.abort();
  });
  await page.route(/\/models\/|\.(onnx|ort)(?:[.?/]|$)/, (route) => {
    forbidden.push('Unexpected model file request: ' + route.request().url());
    return route.abort();
  });
  await page.route('**/api/reconstruction-lab/engine', (route) =>
    route.fulfill({ json: { available: false, reason: '개발 모델 미연결' } }),
  );
  await page.route('**/api/reconstruction/local**', (route) => {
    if (route.request().method() !== 'GET') forbidden.push(route.request().url());
    return route.fulfill({ json: { available: false, reason: '개발 모델 미연결' } });
  });
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(cloudPath, async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        status: opts.unavailable ? 503 : 200,
        json: { available: !opts.unavailable, cacheScope: 'mock-ui-tests', reason: '테스트: AI 바인딩 없음' },
      });
    posts.push(
      route
        .request()
        .postData()
        ?.match(/name="operation"\r\n\r\n([^\r]+)/)?.[1] ?? 'unknown',
    );
    if (opts.pending) await wait;
    if (opts.fail)
      return route.fulfill({
        status: 429,
        json: { error: '테스트: 일일 AI 사용 한도에 도달했어요.', code: 'quota_exhausted', retryable: false },
      });
    if (opts.nonEmpty) {
      const request = route.request();
      const form = await new Response(new Uint8Array(request.postDataBuffer()!), {
        headers: { 'Content-Type': request.headers()['content-type'] },
      }).formData();
      const operation = form.get('operation');
      const common = inventory();
      if (operation === 'inventory-extended')
        return route.fulfill({
          json: {
            ...common,
            rawText: JSON.stringify({
              mirrors_storage: [],
              partitions: [],
              openings: [],
              [opts.shower ? 'sanitary' : 'showers_shelves']: [],
              [opts.shower ? 'showers_shelves' : 'sanitary']: [
                {
                  kind: fixtureKind,
                  bbox_2d: [300, 250, 900, 650],
                  view: 'direct',
                  basin: null,
                  note: 'Authored mock fixture, not inferred from photo',
                },
              ],
            }),
          },
        });
      if (operation === 'shower-installation') {
        const receipt = await validateShowerInstallationReceipt(JSON.parse(String(form.get('receipt'))));
        const full = form.get('photo') as Blob,
          crop = form.get('crop') as Blob;
        expect(await targetExistenceSha256(new Uint8Array(await full.arrayBuffer()))).toBe(
          receipt.normalizedFullSha256,
        );
        expect(await targetExistenceSha256(new Uint8Array(await crop.arrayBuffer()))).toBe(
          receipt.cropSha256,
        );
        showerReceipts.push(receipt);
        const echoed = structuredClone(receipt);
        if (opts.corruptShowerReceipt) echoed.cropSha256 = '0'.repeat(64);
        return route.fulfill({
          json: {
            ...common,
            outputContract: SHOWER_INSTALLATION_CONTRACT,
            promptRevision: SHOWER_INSTALLATION_PROMPT_REVISION,
            receipt: echoed,
            rawText: JSON.stringify({
              schemaVersion: 1,
              note: 'Authored mock open pipe and temporary line with no installed shower head or finished control. This is not image inference.',
              view: 'direct',
              scope: 'multiple-targets',
              installationState: 'unfinished-plumbing',
              visibleHardware: {
                recognizableSprayHeadBody: 'absent',
                sprayOutletFace: 'absent',
                headMountOrSupport: 'absent',
                finishedUserControl: 'absent',
                flexibleWaterHose: 'present',
                unfinishedPipeEnd: 'present',
                looseServiceLoop: 'absent',
              },
            }),
          },
        });
      }
      const source = JSON.parse(form.get('inventory') as string) as {
        candidates: { id: string; bounds: { left: number; top: number; right: number; bottom: number } }[];
      };
      const ids = source.candidates.map((candidate) => candidate.id);
      if (operation === 'installation')
        return route.fulfill({
          json: {
            ...common,
            outputContract: 'fixture-installation-v2',
            promptRevision: 2,
            rawText: JSON.stringify({
              observations: ids.map((id) => ({
                id,
                note: 'Authored mock floor support',
                lower_support: opts.shower ? 'whole_fixture_suspended_with_gap' : 'full_base_on_floor',
                wall_connection: opts.shower ? 'visible_joint' : 'not_visible',
              })),
            }),
          },
        });
      if (operation === 'appearance') {
        const photo = form.get('photo'),
          board = form.get('appearanceBoard');
        expect(photo).toBeInstanceOf(Blob);
        expect(board).toBeInstanceOf(Blob);
        const receipt = await validateCloudFixtureCropReceipt(
          JSON.parse(form.get('appearanceReceipt') as string),
          new Uint8Array(await (photo as Blob).arrayBuffer()),
          new Uint8Array(await (board as Blob).arrayBuffer()),
          source.candidates,
        );
        expect(receipt.layout.tiles.map((tile) => tile.id)).toEqual(ids);
        expect(receipt.layout.boardImage).toEqual({ width: 1020, height: 1024 });
        appearanceReceipts.push(receipt);
        const echoed = structuredClone(receipt);
        if (opts.corruptBoardReceipt) echoed.boardSha256 = '0'.repeat(64);
        return route.fulfill({
          json: {
            ...common,
            ...CLOUD_GEMMA_APPEARANCE_METADATA,
            outputContract: 'fixed-candidate-appearance-v1',
            promptRevision: 1,
            appearanceReceipt: echoed,
            rawText: JSON.stringify({
              schemaVersion: 1,
              observations: ids.map((id) => ({
                id,
                note: 'Authored mock toilet observation',
                kind: fixtureKind,
                context: 'physical',
                sameObjectAs: null,
                shape: 'unknown',
                counterSupport: 'unknown',
                pedestalShape: 'unknown',
              })),
            }),
          },
        });
      }
      if (operation === 'shower-detail')
        return route.fulfill({
          json: {
            ...common,
            outputContract: 'fixed-shower-detail-v1',
            promptRevision: 1,
            modelInputSha256: await targetExistenceSha256(
              new Uint8Array(await (form.get('photo') as Blob).arrayBuffer()),
            ),
            rawText: JSON.stringify({
              schemaVersion: 1,
              observations: ids.map((id) => ({
                id,
                note: 'Authored mock head label; independent installation observation may conflict',
                kind: 'shower',
                context: 'physical',
                style: 'hand-spray',
                observedPart: 'handset',
                visibleParts: {
                  handheldHead: 'present',
                  overheadHead: 'absent',
                  verticalRail: 'absent',
                  hose: 'present',
                },
              })),
            }),
          },
        });
      if (operation === 'layout')
        return route.fulfill({
          json: {
            ...common,
            outputContract: 'fixture-layout-v1',
            promptRevision: 2,
            rawText: JSON.stringify({
              observations: ids.map((id) => ({
                id,
                note: 'Authored mock layout',
                wall: 'back',
                orientation: 'toward-camera',
              })),
              relations: [],
            }),
          },
        });
      forbidden.push('Unexpected mocked operation: ' + String(operation));
      return route.abort();
    }
    return route.fulfill({ json: inventory() });
  });
  return { posts, forbidden, appearanceReceipts, showerReceipts, release: () => release?.() };
}
async function photo(page: Page, label = '테스트할 사진') {
  const buffer = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#ada99b' } })
    .png()
    .toBuffer();
  const input =
    label === 'reconstruction-upload' ? page.getByTestId(label) : page.getByLabel(label, { exact: true });
  await input.setInputFiles({ name: 'MOCK-ui-photo.png', mimeType: 'image/png', buffer });
}
async function openCreate(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}
async function fakeWorkers(page: Page, pending = false) {
  await page.addInitScript(
    ({ artifact, preprocess, postprocess, planes, runtime, tokens, pending }) => {
      const stats = { jobs: [] as string[], modes: [] as string[], terminated: 0 };
      Object.assign(window, { __mockAnalysisWorkers: stats });
      class MockWorker extends EventTarget {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror = null;
        onmessageerror = null;
        stopped = false;
        kind: string;
        constructor(url: string | URL, options?: WorkerOptions) {
          super();
          this.kind = options?.name === 'sjn-moge2' ? 'moge' : 'segmentation';
          // Production Next hashes worker URLs. Never escape to a real worker in this mock suite.
          void url;
          if (options?.name && options.name !== 'sjn-moge2')
            throw new Error('Unexpected mock worker name: ' + options.name);
        }
        terminate() {
          if (!this.stopped) stats.terminated++;
          this.stopped = true;
        }
        postMessage(message: {
          id: number;
          mode?: string;
          geometry?: { metadata: { image: { width: number; height: number } } };
        }) {
          stats.jobs.push(this.kind);
          if (message.mode) stats.modes.push(message.mode);
          const send = (data: unknown) => {
            if (!this.stopped) this.onmessage?.(new MessageEvent('message', { data }));
          };
          if (this.kind === 'segmentation') {
            queueMicrotask(() =>
              send({
                type: 'result',
                id: message.id,
                result: {
                  width: 32,
                  height: 24,
                  objects: [],
                  floor: new Uint8Array(768),
                  wall: new Uint8Array(768),
                },
              }),
            );
            return;
          }
          send({
            type: 'progress',
            id: message.id,
            progress: { stage: 'inference', message: '모의 워커 UI 경계 검증 중' },
          });
          if (pending) return;
          const source = message.geometry!.metadata.image,
            ratio = Math.min(1, 512 / Math.max(source.width, source.height));
          const width = Math.round(source.width * ratio),
            height = Math.round(source.height * ratio),
            n = width * height;
          const mask = new Uint8Array(n).fill(1),
            depth = new Float32Array(n).fill(2),
            points = new Float32Array(n * 3),
            normal = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) normal[i * 3 + 2] = -1;
          const floor = new Int16Array(n),
            wall = new Int16Array(n);
          floor[1] = 2;
          wall[2] = 11;
          queueMicrotask(() =>
            send({
              type: 'result',
              id: message.id,
              result: {
                raw: { width, height, points, normal, mask: new Float32Array(n).fill(1), metricScale: 1 },
                dense: {
                  width,
                  height,
                  points,
                  normal,
                  depth,
                  mask,
                  intrinsics: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
                  diagnostics: {
                    revision: postprocess,
                    focal: 1,
                    shift: 0,
                    samples: 4096,
                    iterations: 1,
                    residualMeanSquare: 0,
                    converged: true,
                    metricScale: 1,
                    validPixels: n,
                    forceProjection: true,
                    applyMask: true,
                    scale: 'model-estimated-metres',
                    focalSampling: '64x64-torch-nearest-floor-not-semantic-pixel-centres',
                  },
                },
                planes: {
                  floor: null,
                  walls: [],
                  evidence: { revision: planes, source: 'MOCK Worker: no actual geometry inference' },
                  labels: { width, height, floor, wall, excluded: new Uint8Array(n) },
                },
                backend: message.mode === 'wasm' ? 'wasm' : 'webgpu',
                requestedMode: message.mode,
                cacheSource: 'cache',
                timings: {
                  downloadMs: 0,
                  cacheMs: 1,
                  initializationMs: 2,
                  preprocessingMs: 1,
                  inferenceMs: 10,
                  postprocessingMs: 2,
                  planeExtractionMs: 3,
                  totalMs: 19,
                },
                metadata: {
                  artifact,
                  runtimeVersion: runtime,
                  preprocessVersion: preprocess,
                  sourceWidth: source.width,
                  sourceHeight: source.height,
                  inputWidth: width,
                  inputHeight: height,
                  numTokens: tokens,
                  precision: 'fp32',
                  wasmThreads: 1,
                  crossOriginIsolated: false,
                  memoryBytes: null,
                },
              },
            }),
          );
        }
      }
      window.Worker = MockWorker as unknown as typeof Worker;
    },
    {
      artifact: MOGE_ARTIFACT,
      preprocess: MOGE_PREPROCESS_VERSION,
      postprocess: MOGE_POSTPROCESS_VERSION,
      planes: MOGE_PLANES_VERSION,
      runtime: MOGE_RUNTIME_VERSION,
      tokens: MOGE_NUM_TOKENS,
      pending,
    },
  );
}
async function savedProject(page: Page) {
  const id = page.url().split('/').at(-1)!;
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('gongganmiri-v1');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const r = db.transaction('projects').objectStore('projects').get(id);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  }, id);
}

test('cloud binding selects new profile without preloading models and exposes actual photo transfer', async ({
  page,
}) => {
  const state = await setup(page);
  await fakeWorkers(page);
  await openCreate(page);
  await expect(aiRadio(page)).toBeChecked();
  await expect(dialog(page).getByText(/설비 분석용 사진은 Cloudflare로 전송해요/)).toBeVisible();
  await expect(dialog(page).getByText(/형상 모델은 시작 버튼을 누를 때 준비/)).toBeVisible();
  expect(state.posts).toEqual([]);
  expect(state.forbidden).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { __mockAnalysisWorkers: { jobs: string[] } }).__mockAnalysisWorkers.jobs,
    ),
  ).toEqual([]);
});

test('missing AI binding gives explicit reason and leaves browser basic available', async ({ page }) => {
  const state = await setup(page, { unavailable: true });
  await openCreate(page);
  await expect(aiRadio(page)).toBeDisabled();
  await expect(basicRadio(page)).toBeChecked();
  await expect(dialog(page).getByText(/테스트: AI 바인딩 없음/)).toBeVisible();
  await photo(page, 'reconstruction-upload');
  await expect(dialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true })).toBeEnabled();
  expect(state.posts).toEqual([]);
});

test('Gemma-only performance result JSON preserves usage and downloads without local models or project writes', async ({
  page,
}, info) => {
  const state = await setup(page);
  await fakeWorkers(page);
  await page.goto('/reconstruction-performance');
  await photo(page);
  await page.getByLabel('테스트 종류').selectOption('gemma');
  await expect(page.getByLabel('MoGe 실행 방식')).toBeDisabled();
  await page.getByRole('button', { name: '테스트 실행', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('분석 완료');
  await expect(page.getByAltText('테스트 원본')).toBeVisible();
  const nextDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '결과 JSON 다운로드' }).click();
  const download = await nextDownload;
  const target = info.outputPath('mock-gemma-report.json');
  await download.saveAs(target);
  const report = JSON.parse(await readFile(target, 'utf8'));
  expect(report).toMatchObject({
    kind: 'gemma',
    modelId: CLOUD_GEMMA_MODEL,
    measurement: { inferenceCalls: 1, inputTokens: 23, outputTokens: 5 },
  });
  expect(report.measurement.memoryScope).toContain('MOCK');
  expect(state.posts).toEqual(['inventory-extended']);
  expect(state.forbidden).toEqual([]);
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name))).not.toContain(
    'gongganmiri-v1',
  );
  // Same photo: real browser transport cache is exercised, HTTP model mock is not called again.
  await page.getByRole('button', { name: '테스트 실행', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('분석 완료');
  expect(state.posts).toHaveLength(1);
});

test('MoGe mode selection renders depth/normal/plane previews with transparent absence, never as inference proof', async ({
  page,
}) => {
  const state = await setup(page);
  await fakeWorkers(page);
  await page.goto('/reconstruction-performance');
  await photo(page);
  for (const mode of ['webgpu', 'wasm', 'auto']) {
    await page.getByLabel('MoGe 실행 방식').selectOption(mode);
    await page.getByRole('button', { name: '테스트 실행', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('분석 완료');
    for (const kind of ['depth', 'normal', 'planes'])
      await expect(page.getByLabel(kind + ' preview')).toBeVisible();
    await expect(page.getByText(/실행 메모리: 측정 불가/)).toBeVisible();
  }
  const pixels = await page
    .getByLabel('planes preview')
    .evaluate((node) =>
      Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 3, 1).data),
    );
  expect(pixels).toEqual([0, 0, 0, 255, 54, 187, 116, 255, 80, 108, 210, 255]);
  const stats = await page.evaluate(
    () =>
      (window as unknown as { __mockAnalysisWorkers: { modes: string[]; jobs: string[] } })
        .__mockAnalysisWorkers,
  );
  expect(stats.modes).toEqual(['webgpu', 'wasm', 'auto']);
  expect(stats.jobs.filter((job) => job === 'segmentation')).toHaveLength(1);
  expect(state.posts).toEqual([]);
  expect(state.forbidden).toEqual([]);
});

test('cancel terminates a pending geometry worker and prevents duplicate runs and results', async ({
  page,
}) => {
  const state = await setup(page);
  await fakeWorkers(page, true);
  await page.goto('/reconstruction-performance');
  await photo(page);
  await page.getByRole('button', { name: '테스트 실행', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('모의 워커 UI 경계 검증 중');
  await expect(page.getByRole('button', { name: '테스트 실행', exact: true })).toBeDisabled();
  await expect(page.getByLabel('테스트할 사진')).toBeDisabled();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('분석을 취소했어요.');
  await expect(page.getByRole('button', { name: '테스트 실행', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '결과 JSON 다운로드' })).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __mockAnalysisWorkers: { terminated: number } }).__mockAnalysisWorkers
          .terminated,
    ),
  ).toBe(2);
  expect(state.posts).toEqual([]);
});

test('quota failure is visible, not retried automatically, and does not silently select basic', async ({
  page,
}) => {
  const state = await setup(page, { fail: true });
  await fakeWorkers(page);
  await openCreate(page);
  await photo(page, 'reconstruction-upload');
  await expect(aiRadio(page)).toBeChecked();
  await dialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true }).click();
  await expect(dialog(page).getByText(/테스트: 일일 AI 사용 한도/)).toBeVisible({ timeout: 30000 });
  await expect(aiRadio(page)).toBeChecked();
  await expect(dialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true })).toBeEnabled();
  expect(state.posts).toEqual(['inventory-extended']);
  expect(state.forbidden).toEqual([]);
});

test('normal create and Before reanalysis persist the cloud profile and keep After empty with mocked observations', async ({
  page,
}) => {
  const state = await setup(page);
  await fakeWorkers(page);
  await openCreate(page);
  await photo(page, 'reconstruction-upload');
  await expect(aiRadio(page)).toBeChecked();
  await dialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 45000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  const saved = await savedProject(page);
  expect(saved).toMatchObject({
    shared: {
      comparison: {
        review: {
          analysisProfile: 'cloud-browser-v1',
          analysisSummary: { profile: 'cloud-browser-v1', modelId: CLOUD_GEMMA_MODEL },
        },
      },
    },
  });
  const designs = saved.designs as Array<{ scene: { fixtures: unknown[] } }>;
  expect(designs[0].scene.fixtures).toEqual([]);
  await page.getByRole('button', { name: '기존 공간 수정', exact: true }).click();
  await page.getByRole('button', { name: '사진 다시 분석', exact: true }).click();
  await expect(aiRadio(page)).toBeChecked();
  await page.getByRole('button', { name: 'Before 다시 만들기', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Before 사진 다시 분석', exact: true })).toHaveCount(0, {
    timeout: 45000,
  });
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  expect(((await savedProject(page)).designs as DesignDocument[]).map(comparableDesign)).toEqual(
    (saved.designs as DesignDocument[]).map(comparableDesign),
  );
  expect(state.posts).toEqual(['inventory-extended']);
  expect(state.forbidden).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  expect(await savedProject(page)).toMatchObject({
    shared: { comparison: { review: { analysisProfile: 'cloud-browser-v1' } } },
  });
});

test('mock cloud project supports user Before history, edited After preservation, reentry and clean PNG', async ({
  page,
  context,
  baseURL,
}, info) => {
  test.setTimeout(180000);
  info.annotations.push({
    type: 'mock-only',
    description:
      'Authored empty Gemma observations and fake DeepLab/MoGe Workers; user edits only, no actual AI or quality claim.',
  });
  const state = await setup(page);
  await fakeWorkers(page);
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const origin = new URL(baseURL!).origin;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  const project = async () => (await savedProject(page)) as unknown as ProjectDocument;
  const save = async () => {
    await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  };
  const changed = async (revision: number) => {
    await expect.poll(async () => (await project()).editRevision).toBeGreaterThan(revision);
    await save();
    return project();
  };
  const before = (document: ProjectDocument) => document.shared.comparison!.before;
  const designs = (document: ProjectDocument) => document.designs.map(comparableDesign);
  const downloadComparison = async (name: string) => {
    await expect(page.locator('.canvas-loading')).toHaveCount(0);
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    const exporting = page.getByRole('dialog', { name: '이미지 내보내기', exact: true });
    await exporting.getByRole('combobox', { name: '이미지 구성', exact: true }).selectOption('compare');
    await exporting.getByRole('combobox', { name: '파일 형식', exact: true }).selectOption('image/png');
    const pending = page.waitForEvent('download');
    await exporting.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    const path = info.outputPath(name + '.png');
    await download.saveAs(path);
    await expect(exporting).toHaveCount(0);
    return sharp(await readFile(path))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  };

  await page.goto('/');
  // Only an isolated test catalog is seeded; observations and project content are never injected.
  await seedTestTiles(page);
  await openCreate(page);
  await photo(page, 'reconstruction-upload');
  await expect(aiRadio(page)).toBeChecked();
  await dialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 45000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await save();
  const automatic = await project(),
    projectUrl = page.url();
  expect(automatic.shared.comparison!.review!.analysisProfile).toBe('cloud-browser-v1');
  expect(before(automatic).fixtures).toEqual([]);
  expect(getActiveDesign(automatic)!.scene.fixtures).toEqual([]);
  expect(getActiveDesign(automatic)!.scene.surfaces.every((surface) => !surface.materialVersionId)).toBe(
    true,
  );

  await page.getByRole('button', { name: '기존 공간 수정', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Before 초안 보정' });
  if (!(await panel.isVisible())) await page.getByRole('button', { name: '초안 보정', exact: true }).click();
  await panel.getByRole('button', { name: '변기 추가', exact: true }).click();
  const userAdded = await changed(automatic.editRevision);
  expect(before(userAdded).fixtures).toHaveLength(1);
  expect(before(userAdded).fixtures[0].reconstruction?.provenance?.kind).toBe('user');
  expect(designs(userAdded)).toEqual(designs(automatic));
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  const undone = await changed(userAdded.editRevision);
  expect(before(undone)).toEqual(before(automatic));
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  const redone = await changed(undone.editRevision);
  expect(before(redone)).toEqual(before(userAdded));
  expect(designs(redone)).toEqual(designs(automatic));
  await expect(page.getByRole('button', { name: '내보내기', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'After 꾸미기로 돌아가기', exact: true }).click();
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  const floorId = getActiveDesign(redone)!.scene.surfaces.find((surface) => surface.roomFace === 'floor')!.id;
  await page.getByLabel('타일 적용 위치', { exact: true }).selectOption(floorId);
  await page.locator('button.material-tile').filter({ hasText: '차콜 스톤' }).click();
  const tiled = await changed(redone.editRevision);
  expect(
    getActiveDesign(tiled)!.scene.surfaces.find((surface) => surface.id === floorId)?.materialVersionId,
  ).toBeTruthy();
  expect(before(tiled)).toEqual(before(userAdded));
  const usage = page.getByTestId('usage-row').filter({ hasText: '차콜 스톤' });
  const price = usage.getByLabel('차콜 스톤 단가 (원)', { exact: true });
  await price.fill('32000');
  await price.press('Enter');
  const priced = await changed(tiled.editRevision);
  const afterDesign = getActiveDesign(priced)!;
  expect(afterDesign.materialUsage).toBeDefined();
  expect(afterDesign.materialUsage).not.toEqual(getActiveDesign(automatic)!.materialUsage);
  expect(designs(priced)).not.toEqual(designs(automatic));
  const usageTotal = await page.getByTestId('usage-total').innerText();
  expect(usageTotal).not.toBe('0원');

  await page.getByRole('button', { name: '기존 공간 수정', exact: true }).click();
  await page.getByRole('button', { name: '사진 다시 분석', exact: true }).click();
  const rebuilding = page.getByRole('dialog', { name: 'Before 사진 다시 분석', exact: true });
  await expect(aiRadio(page)).toBeChecked();
  await rebuilding.getByRole('button', { name: 'Before 다시 만들기', exact: true }).click();
  await expect(rebuilding).toHaveCount(0, { timeout: 45000 });
  const rebuilt = await changed(priced.editRevision);
  expect(before(rebuilt).fixtures).toEqual([]);
  expect(rebuilt.shared.comparison!.review!.analysisProfile).toBe('cloud-browser-v1');
  expect(designs(rebuilt)).toEqual(designs(priced));
  expect(rebuilt.shared.comparison!.referenceOriginalAssetId).toBe(
    automatic.shared.comparison!.referenceOriginalAssetId,
  );
  expect(rebuilt.shared.comparison!.room).toEqual(automatic.shared.comparison!.room);
  expect(rebuilt.shared.comparison!.aspect).toBe(automatic.shared.comparison!.aspect);
  expect([before(rebuilt).imageWidth, before(rebuilt).imageHeight]).toEqual([
    before(priced).imageWidth,
    before(priced).imageHeight,
  ]);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  const rebuildUndone = await changed(rebuilt.editRevision);
  expect(rebuildUndone.shared.comparison).toEqual(priced.shared.comparison);
  expect(designs(rebuildUndone)).toEqual(designs(priced));
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  const rebuildRedone = await changed(rebuildUndone.editRevision);
  expect(rebuildRedone.shared.comparison).toEqual(rebuilt.shared.comparison);
  expect(designs(rebuildRedone)).toEqual(designs(priced));

  await page.goto('/');
  await page.goto(projectUrl);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await save();
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await save();
  const reopened = await project();
  expect(reopened.shared.comparison).toEqual(rebuilt.shared.comparison);
  expect(designs(reopened)).toEqual(designs(priced));
  expect(reopened.shared.comparison!.review!.analysisProfile).toBe('cloud-browser-v1');
  await expect(page.getByTestId('usage-total')).toHaveText(usageTotal);

  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await page.getByLabel('타일 적용 위치', { exact: true }).selectOption(floorId);
  const selectedPng = await downloadComparison('mock-selected-floor-comparison');
  await page.getByLabel('타일 적용 위치', { exact: true }).selectOption('all');
  const cleanPng = await downloadComparison('mock-clean-comparison');
  expect(selectedPng.info).toEqual(cleanPng.info);
  expect(selectedPng.data.equals(cleanPng.data)).toBe(true);
  const { width, height, channels } = cleanPng.info;
  expect(width).toBeGreaterThan(500);
  expect(height).toBeGreaterThan(100);
  let samples = 0,
    different = 0;
  const panelWidth = Math.floor(width / 2);
  for (let y = 0; y < height; y += 4)
    for (let x = 0; x < panelWidth; x += 4) {
      const a = (y * width + x) * channels,
        b = (y * width + panelWidth + x) * channels;
      samples++;
      if ([0, 1, 2].some((c) => Math.abs(cleanPng.data[a + c] - cleanPng.data[b + c]) > 12)) different++;
    }
  expect(different / samples).toBeGreaterThan(0.01);
  expect((await project()).editRevision).toBe(reopened.editRevision);
  expect(state.posts).toEqual(['inventory-extended']);
  expect(state.forbidden).toEqual([]);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  await info.attach('mock-only-project-flow', {
    contentType: 'application/json',
    body: JSON.stringify(
      {
        scope:
          'MOCK HTTP and Worker boundaries; user-added Before toilet and After tile, no actual AI inference or quality evidence',
        actualAiCalls: 0,
        mockPosts: state.posts,
        automatic,
        userAdded,
        priced,
        rebuilt,
        reopened,
        png: {
          width,
          height,
          beforeAfterDifferentSampleRatio: different / samples,
          selectionUiExcluded: true,
        },
        errors,
        external,
      },
      null,
      2,
    ),
  });
  await page.screenshot({ path: info.outputPath('mock-cloud-project-reopened.png'), fullPage: true });
});
test('full performance path shows original and Before without saving a project, including mobile layout', async ({
  page,
}, info) => {
  const state = await setup(page);
  await fakeWorkers(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/reconstruction-performance');
  await photo(page);
  await page.getByLabel('테스트 종류').selectOption('full');
  await page.getByLabel('MoGe 실행 방식').selectOption('wasm');
  await page.getByRole('button', { name: '테스트 실행', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('분석 완료', { timeout: 45000 });
  await expect(page.getByAltText('테스트 원본')).toBeVisible();
  await expect(page.getByAltText('재구성 Before')).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '결과 JSON 다운로드' }).click();
  const target = info.outputPath('mock-full-flow-report.json');
  await (await downloaded).saveAs(target);
  expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({
    kind: 'full',
    profile: 'cloud-browser-v1',
    projectSaved: false,
  });
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name))).not.toContain(
    'gongganmiri-v1',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.posts).toEqual(['inventory-extended']);
  expect(state.forbidden).toEqual([]);
});

test('invalid room size prevents inference and an explicit correction restores the run action', async ({
  page,
}) => {
  const state = await setup(page);
  await fakeWorkers(page);
  await page.goto('/reconstruction-performance');
  await photo(page);
  await page.getByRole('spinbutton', { name: '가로 (mm)', exact: true }).fill('0');
  await expect(page.getByRole('alert').filter({ hasText: '500~20,000mm' })).toBeVisible();
  await expect(page.getByRole('button', { name: '테스트 실행', exact: true })).toBeDisabled();
  await page.getByRole('spinbutton', { name: '가로 (mm)', exact: true }).fill('1800');
  await expect(page.getByRole('button', { name: '테스트 실행', exact: true })).toBeEnabled();
  expect(state.posts).toEqual([]);
});

for (const corruptBoardReceipt of [false, true]) {
  test(`mock full cloud appearance ${corruptBoardReceipt ? 'rejects a substituted' : 'validates and echoes the actual'} crop board receipt`, async ({
    page,
  }, info) => {
    info.annotations.push({
      type: 'mock-only',
      description:
        'Authored fixture observations and fake model Workers. Real browser canvas/transport validation only; actual AI calls=0.',
    });
    const state = await setup(page, { nonEmpty: true, corruptBoardReceipt });
    await fakeWorkers(page);
    await page.goto('/reconstruction-performance');
    await photo(page);
    await page.getByLabel('테스트 종류').selectOption('full');
    await page.getByLabel('MoGe 실행 방식').selectOption('wasm');
    await page.getByRole('button', { name: '테스트 실행', exact: true }).click();
    if (corruptBoardReceipt) {
      await expect(page.getByText('설비 형태 관측을 검증하지 못했어요.', { exact: false })).toBeVisible({
        timeout: 45000,
      });
      await expect(page.getByRole('status')).not.toHaveText('분석 완료');
      await expect(page.getByAltText('재구성 Before')).toHaveCount(0);
      expect(state.posts).toEqual(['inventory-extended', 'installation', 'appearance']);
    } else {
      await expect(page.getByRole('status')).toHaveText('분석 완료', { timeout: 45000 });
      await expect(page.getByAltText('재구성 Before')).toBeVisible();
      expect(state.posts).toEqual(['inventory-extended', 'installation', 'appearance', 'layout']);
    }
    expect(state.appearanceReceipts).toHaveLength(1);
    expect(state.forbidden).toEqual([]);
    await info.attach('mock-appearance-board-receipt', {
      contentType: 'application/json',
      body: JSON.stringify(
        { actualAiCalls: 0, corruptBoardReceipt, posts: state.posts, receipt: state.appearanceReceipts[0] },
        null,
        2,
      ),
    });
  });
}

for (const corruptShowerReceipt of [false, true]) {
  test(`mock shower installedness ${corruptShowerReceipt ? 'rejects a substituted crop receipt' : 'retains the original candidate and holds unfinished plumbing'}`, async ({
    page,
  }, info) => {
    info.annotations.push({
      type: 'mock-only',
      description:
        'Authored JSON and synthetic photo. Browser canvas/transport/placement integration only; actual AI calls=0. Not a GPU performance benchmark.',
    });
    const state = await setup(page, { nonEmpty: true, shower: true, corruptShowerReceipt });
    await fakeWorkers(page);
    await page.goto('/reconstruction-performance');
    await photo(page);
    await page.getByLabel('테스트 종류').selectOption('full');
    await page.getByLabel('MoGe 실행 방식').selectOption('wasm');
    await page.getByRole('button', { name: '테스트 실행', exact: true }).click();
    if (corruptShowerReceipt) {
      await expect(
        page.getByText('샤워 설치 상태 입력과 원문을 검증하지 못했어요.', { exact: false }),
      ).toBeVisible({ timeout: 45000 });
      await expect(page.getByAltText('재구성 Before')).toHaveCount(0);
      expect(state.posts).toEqual([
        'inventory-extended',
        'installation',
        'appearance',
        'shower-detail',
        'shower-installation',
      ]);
    } else {
      await expect(page.getByRole('status')).toHaveText('분석 완료', { timeout: 45000 });
      await expect(page.getByAltText('재구성 Before')).toBeVisible();
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: '결과 JSON 다운로드' }).click();
      const path = info.outputPath('mock-shower-installation-report.json');
      await (await pending).saveAs(path);
      const result = JSON.parse(await readFile(path, 'utf8'));
      expect(result.quality.inventory.understanding.candidates).toHaveLength(1);
      expect(result.quality.showerDetails.observations[0].visibleParts.handheldHead).toBe('present');
      expect(result.quality.showerInstallation.decisions[0]).toMatchObject({
        action: 'hold',
        proposedAfter: { placement: 'hold-for-review' },
      });
      expect(result.quality.showerInstallation.observations[0].rawText).toContain('Authored mock');
      expect(result.review.candidates[0]).toMatchObject({
        status: 'unplaced',
        requiresReview: true,
        warning: expect.stringContaining('미설치'),
      });
      expect(state.posts).toEqual([
        'inventory-extended',
        'installation',
        'appearance',
        'shower-detail',
        'shower-installation',
        'layout',
      ]);
    }
    expect(state.showerReceipts).toHaveLength(1);
    expect(state.forbidden).toEqual([]);
    await info.attach('mock-shower-installedness-receipt', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          actualAiCalls: 0,
          performanceMeasured: false,
          corruptShowerReceipt,
          posts: state.posts,
          receipt: state.showerReceipts[0],
        },
        null,
        2,
      ),
    });
  });
}
