import { expect, test, type Page, type Locator } from '@playwright/test';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import type { MaterialVersion } from '../src/lib/types';
import { getActiveDesign } from '../src/lib/designs';
import { savedProject } from '../tests/helpers/editor-actions';
import { calculateMaterialUsage } from '../src/lib/material-usage';

// These tests replay an ACTUAL TripoSR mesh through the production viewport and
// persistence. The Worker response is controlled, so these are not inference tests.
const meshDirectory = path.resolve(
  process.env.SJN_PRODUCT3D_MESH ?? 'test-results/front-alignment-toilet/photograph',
);
const sourceFile = path.resolve(
  process.env.SJN_PRODUCT3D_SOURCE ?? 'test-results/multiview-quality-toilet-after/source.png',
);
const hasFixture = existsSync(path.join(meshDirectory, 'mesh-positions.bin')) && existsSync(sourceFile);
const output = path.resolve('test-results/product3d-validation');
type Pose = { objectQuaternion: number[]; cameraQuaternion: number[]; zoom: number };
type Controls = {
  workers: number;
  pngExports: number;
  failAssetWrite: boolean;
  contexts: number;
  contextsLost: number;
  drawCalls: number;
  release?: () => void;
  releaseBackground?: () => void;
  fail?: () => void;
};
type State = Window & { product3dTest: Controls };

async function installReplay(page: Page) {
  test.skip(!hasFixture, 'Requires the documented real TripoSR mesh and transparent source fixture.');
  const encoded = Object.fromEntries(
    ['positions', 'indices', 'colors'].map((field) => [
      field,
      readFileSync(path.join(meshDirectory, `mesh-${field}.bin`)).toString('base64'),
    ]),
  );
  const source = [...readFileSync(sourceFile)];
  await page.addInitScript(
    ({ encoded, source }) => {
      const state = ((window as unknown as State).product3dTest = {
        workers: 0,
        pngExports: 0,
        failAssetWrite: false,
        contexts: 0,
        contextsLost: 0,
        drawCalls: 0,
      } as Controls);
      const Original = Worker;
      class ReplayWorker extends EventTarget {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror = null;
        onmessageerror = null;
        constructor(readonly name: string) {
          super();
        }
        postMessage(message: { id: number }) {
          const send = (data: unknown) => this.onmessage?.(new MessageEvent('message', { data }));
          if (this.name === 'sjn-background-removal') {
            state.releaseBackground = () =>
              send({
                type: 'result',
                id: message.id,
                result: {
                  blob: new Blob([new Uint8Array(source)], { type: 'image/png' }),
                  width: 2048,
                  height: 2048,
                  analysisWidth: 512,
                  analysisHeight: 512,
                  backend: 'wasm',
                  precision: 'fp32',
                  downloadMs: 0,
                  initializationMs: 0,
                  processingMs: 1,
                  inferenceMs: 1,
                  cacheSource: 'memory',
                },
              });
            return;
          }
          send({
            type: 'progress',
            id: message.id,
            progress: { stage: 'reconstructing', message: '검증용 실제 메시 응답 대기' },
          });
          const decode = (field: string) =>
            Uint8Array.from(atob(encoded[field]), (c) => c.charCodeAt(0)).buffer;
          state.release = () =>
            send({
              type: 'mesh',
              id: message.id,
              mesh: {
                positions: new Float32Array(decode('positions')),
                indices: new Uint32Array(decode('indices')),
                colors: new Float32Array(decode('colors')),
              },
              timings: {
                downloadMs: 0,
                initializationMs: 0,
                processingMs: 0,
                cacheSource: 'cache',
                backend: 'webgpu',
                modelId: 'actual-mesh-replay',
                modelRevision: 'actual-mesh-replay',
              },
            });
          state.fail = () =>
            send({ type: 'error', id: message.id, message: '검증용 GPU/CPU 실행 불가', retryCpu: false });
        }
        // Deliberately retain onmessage: tests inject a late reply after termination.
        terminate() {}
      }
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        value: function (url: string | URL, options?: WorkerOptions) {
          if (options?.name === 'sjn-product3d') {
            state.workers++;
            return new ReplayWorker(options.name);
          }
          if (options?.name === 'sjn-background-removal') return new ReplayWorker(options.name);
          return new Original(url, options);
        },
      });
      for (const method of ['add', 'put'] as const) {
        const original = IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method] = function (value, key) {
          if (state.failAssetWrite && this.name === 'assets')
            throw new DOMException('검증용 저장 공간 부족', 'QuotaExceededError');
          return key === undefined ? original.call(this, value) : original.call(this, value, key);
        };
      }
      for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
        const drawElements = prototype.drawElements;
        prototype.drawElements = function (...args) {
          if ((this.canvas as HTMLCanvasElement).dataset?.testid === 'product3d-canvas') state.drawCalls++;
          return drawElements.apply(this, args);
        };
      }
      const originalContext = HTMLCanvasElement.prototype.getContext;
      const knownContexts = new WeakSet<object>();
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...args: unknown[]
      ) {
        const context = originalContext.apply(this, [type, ...args] as Parameters<typeof originalContext>);
        if (context && (type === 'webgl' || type === 'webgl2') && !knownContexts.has(context)) {
          knownContexts.add(context);
          state.contexts++;
          this.addEventListener('webglcontextlost', () => {
            state.contextsLost++;
          });
        }
        return context;
      } as typeof originalContext;
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        state.pngExports++;
        return toBlob.call(this, callback, type, quality);
      };
    },
    { encoded, source },
  );
}
async function openForm(page: Page, photoCount = 1) {
  page.on('pageerror', (error) => console.log('PRODUCT3D PAGE ERROR', error.message));
  await installReplay(page);
  await page.goto('http://127.0.0.1:3000/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  const name = `360 검증 ${Date.now()}`;
  await form.getByLabel('상품명').fill(name);
  await form.getByLabel('+ 제품 이미지 올리기', { exact: true }).setInputFiles(
    Array.from({ length: photoCount }, (_, i) => ({
      name: `source-${i}.png`,
      mimeType: 'image/png',
      buffer: readFileSync(sourceFile),
    })),
  );
  await expect(form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })).toHaveCount(
    photoCount,
  );
  await form.getByLabel('촬영 방향 1', { exact: true }).fill('정면');
  if (photoCount > 1) await form.getByLabel('촬영 방향 2', { exact: true }).fill('오른쪽 측면');
  return { form, name };
}
async function openViewer(form: Locator, direction = '정면', saved = false) {
  await form
    .getByRole('button', {
      name: `${direction} 사진 ${saved ? '360° 각도 편집' : 'AI 360° 입체화'}`,
      exact: true,
    })
    .click();
  return form.page().getByRole('dialog', { name: '360° 제품 편집', exact: true });
}
async function reconstruct(page: Page, dialog: Locator) {
  await dialog.getByRole('button', { name: '입체화 시작', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as unknown as State).product3dTest.release))
    .toBe('function');
  await page.evaluate(() => (window as unknown as State).product3dTest.release?.());
  await expect(dialog.getByTestId('product3d-canvas')).toBeVisible();
  await expect
    .poll(async () => {
      if (await dialog.getByRole('alert').count())
        throw new Error(
          await dialog
            .getByRole('alert')
            .allTextContents()
            .then((v) => v.join(' | ')),
        );
      return dialog.getByRole('button', { name: '화면 맞춤', exact: true }).isEnabled();
    })
    .toBe(true);
  await expect(dialog.getByRole('button', { name: '이 각도 추가', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: /대표/ })).toHaveCount(0);
}
async function pose(dialog: Locator): Promise<Pose> {
  return JSON.parse((await dialog.getByTestId('product3d-pose').getAttribute('data-pose')) ?? '{}');
}
async function drag(page: Page, locator: Locator, dx: number, dy: number) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 20 });
  await page.mouse.up();
}
async function selectProduct(dialog: Locator) {
  const canvas = dialog.getByTestId('product3d-canvas');
  const box = (await canvas.boundingBox())!;
  // The actual fixture is centered; lower-middle avoids the bowl opening.
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.65 } });
  await expect(dialog.getByTestId('product3d-handle-top')).toBeVisible();
}
async function versions(page: Page, name: string) {
  return page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('gongganmiri-v1');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<MaterialVersion[]>((resolve, reject) => {
        const req = db.transaction('versions').objectStore('versions').getAll();
        req.onsuccess = () =>
          resolve(
            req.result
              .filter((v: MaterialVersion) => v.name === name)
              .sort((a: MaterialVersion, b: MaterialVersion) => a.version - b.version),
          );
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, name);
}
async function updateSelectedAndClose(dialog: Locator) {
  await dialog.getByRole('button', { name: '선택한 각도 수정', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '선택한 각도 수정', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function saveForm(form: Locator, update = false) {
  await form.getByRole('button', { name: update ? '새 버전 저장' : '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
}
async function png(dialog: Locator, destination: string) {
  const pending = dialog.page().waitForEvent('download');
  await dialog.getByRole('button', { name: '투명 PNG 다운로드', exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBe(null);
  mkdirSync(path.dirname(destination), { recursive: true });
  const downloaded = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of downloaded!) chunks.push(Buffer.from(chunk));
  writeFileSync(destination, Buffer.concat(chunks));
  const { data, info } = await sharp(destination).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0,
    transparent = 0,
    borderOpaque = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * 4 + 3];
      if (alpha === 0) transparent++;
      if (alpha > 200) opaque++;
      if ((x < 3 || y < 3 || x >= info.width - 3 || y >= info.height - 3) && alpha > 0) borderOpaque++;
    }
  expect([info.width, info.height]).toEqual([1024, 1024]);
  expect(opaque).toBeGreaterThan(10_000);
  expect(transparent).toBeGreaterThan(100_000);
  expect(borderOpaque).toBe(0);
  return { opaque, transparent, borderOpaque };
}

test('실제 메시 재생: 자유 회전·상하 뒤집기·기울기 손잡이·작업 단위 undo·PNG', async ({ page }) => {
  const { form } = await openForm(page);
  const dialog = await openViewer(form);
  await reconstruct(page, dialog);
  const initial = await pose(dialog);
  const baseline = await page.evaluate(() => ({ ...(window as unknown as State).product3dTest }));
  await selectProduct(dialog);
  await drag(page, dialog.getByTestId('product3d-handle-top'), 45, 0);
  const top = await pose(dialog);
  expect(top.objectQuaternion).not.toEqual(initial.objectQuaternion);
  top.cameraQuaternion.forEach((n, i) => expect(n).toBeCloseTo(initial.cameraQuaternion[i], 10));
  await dialog.getByRole('button', { name: '실행 취소', exact: true }).click();
  const undone = await pose(dialog);
  for (const field of ['objectQuaternion', 'cameraQuaternion'] as const)
    undone[field].forEach((n, i) => expect(n).toBeCloseTo(initial[field][i], 10));
  await expect(dialog.getByRole('button', { name: '실행 취소', exact: true })).toBeDisabled();
  await drag(page, dialog.getByTestId('product3d-handle-bottom'), -45, 0);
  const bottom = await pose(dialog);
  const qdot = Math.abs(top.objectQuaternion.reduce((sum, n, i) => sum + n * bottom.objectQuaternion[i], 0));
  expect(qdot).toBeGreaterThan(0.998);
  await dialog.getByRole('button', { name: '기울기 초기화', exact: true }).click();
  await drag(page, dialog.getByTestId('product3d-canvas'), 250, -350);
  expect((await pose(dialog)).cameraQuaternion).not.toEqual(initial.cameraQuaternion);
  expect((await pose(dialog)).objectQuaternion).toEqual(initial.objectQuaternion);
  // Repeated pole-crossing drags must remain finite, not clamp or snap upright.
  const orbitPoses: Pose[] = [];
  for (let i = 0; i < 8; i++) {
    await drag(page, dialog.getByTestId('product3d-canvas'), 0, -240);
    orbitPoses.push(await pose(dialog));
  }
  const up = ([x, y, z, w]: number[]) => [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
  const initialUp = up(initial.cameraQuaternion);
  const upDots = orbitPoses.map((p) =>
    up(p.cameraQuaternion).reduce((sum, n, i) => sum + n * initialUp[i], 0),
  );
  expect(Math.min(...upDots)).toBeLessThan(-0.5);
  const flipped = await pose(dialog);
  expect(flipped.cameraQuaternion.every(Number.isFinite)).toBe(true);
  await dialog.getByRole('button', { name: '시점 초기화', exact: true }).click();
  await selectProduct(dialog);
  const beforeKeyboard = await pose(dialog);
  await dialog.getByTestId('product3d-handle-top').focus();
  await dialog.getByTestId('product3d-handle-top').press('ArrowRight');
  expect((await pose(dialog)).objectQuaternion).not.toEqual(beforeKeyboard.objectQuaternion);
  for (const color of ['흰색', '검은색', '체크무늬'])
    await dialog.getByRole('button', { name: color, exact: true }).click();
  for (let i = 0; i < 6; i++) await dialog.getByRole('button', { name: '확대', exact: true }).click();
  const beforeExport = await page.evaluate(() => (window as unknown as State).product3dTest);
  expect(beforeExport.workers).toBe(baseline.workers);
  expect(beforeExport.pngExports).toBe(baseline.pngExports);
  const pixels = await png(dialog, path.join(output, 'selected-zoomed-export.png'));
  await dialog.screenshot({ path: path.join(output, 'selected-zoomed-ui.png') });
  await dialog.getByRole('button', { name: '화면 맞춤', exact: true }).click();
  await dialog.getByTestId('product3d-canvas').click({ position: { x: 5, y: 5 } });
  await expect(dialog.getByTestId('product3d-handle-top')).toBeHidden();
  await dialog.getByRole('button', { name: '검은색', exact: true }).click();
  await png(dialog, path.join(output, 'unselected-fitted-black-export.png'));
  expect(
    readFileSync(path.join(output, 'unselected-fitted-black-export.png')).equals(
      readFileSync(path.join(output, 'selected-zoomed-export.png')),
    ),
  ).toBe(true);

  writeFileSync(
    path.join(output, 'interaction.json'),
    JSON.stringify({ initial, top, bottom, qdot, flipped, pixels, workers: beforeExport.workers }, null, 2),
  );
});

test('실제 메시 재생: 선택 사진만 교체·불변 버전·저장 자세 재진입 무추론', async ({ page }) => {
  const { form: create, name } = await openForm(page, 2);
  await saveForm(create);
  const original = (await versions(page, name))[0];
  await page
    .locator('article')
    .filter({ hasText: name })
    .getByRole('button', { name: '정보 수정', exact: true })
    .click();
  let form = page.getByRole('dialog', { name: '자재 수정', exact: true });
  let dialog = await openViewer(form);
  await reconstruct(page, dialog);
  await drag(page, dialog.getByTestId('product3d-canvas'), 140, -95);
  await selectProduct(dialog);
  await drag(page, dialog.getByTestId('product3d-handle-top'), 25, 0);
  const editedPose = await pose(dialog);
  await updateSelectedAndClose(dialog);
  await expect(form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })).toHaveCount(
    2,
  );
  await expect(form.getByLabel('촬영 방향 1', { exact: true })).toHaveValue('정면');
  await expect(form.getByLabel('촬영 방향 2', { exact: true })).toHaveValue('오른쪽 측면');
  await saveForm(form, true);
  const saved = await versions(page, name);
  expect(saved[0]).toEqual(original);
  expect(saved).toHaveLength(2);
  expect(saved[1].views[1]).toEqual(original.views[1]);
  expect(saved[1].views[0].assetId).not.toBe(original.views[0].assetId);
  expect(saved[1].views[0].product3d).toBeTruthy();
  await page.reload();
  await page
    .locator('article')
    .filter({ hasText: name })
    .getByRole('button', { name: '정보 수정', exact: true })
    .click();
  form = page.getByRole('dialog', { name: '자재 수정', exact: true });
  const modelRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('.onnx')) modelRequests.push(req.url());
  });
  dialog = await openViewer(form, '정면', true);
  await expect(dialog.getByTestId('product3d-canvas')).toBeVisible();
  const reopenedPose = await pose(dialog);
  for (const field of ['objectQuaternion', 'cameraQuaternion'] as const)
    reopenedPose[field].forEach((n, i) => expect(n).toBeCloseTo(editedPose[field][i], 10));
  expect(reopenedPose.zoom).toBeCloseTo(editedPose.zoom, 10);
  expect(await page.evaluate(() => (window as unknown as State).product3dTest.workers)).toBe(0);
  expect(modelRequests).toEqual([]);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  for (let i = 0; i < 4; i++) {
    dialog = await openViewer(form, '정면', true);
    await expect(dialog.getByRole('button', { name: '화면 맞춤', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as State).product3dTest;
        return state.contexts - state.contextsLost;
      }),
    )
    .toBe(0);
  expect(await page.evaluate(() => (window as unknown as State).product3dTest.workers)).toBe(0);
  dialog = await openViewer(form, '오른쪽 측면');
  await reconstruct(page, dialog);
  await updateSelectedAndClose(dialog);
  await saveForm(form, true);
  const last = (await versions(page, name)).at(-1)!;
  expect(last.views[0]).toEqual(saved[1].views[0]);
  expect(last.views[1].assetId).not.toBe(original.views[1].assetId);
});

test('실제 메시 재생: 저장 용량 실패 후 사진·결과 보존과 재시도', async ({ page }) => {
  const { form } = await openForm(page);
  const source = await form
    .getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })
    .getAttribute('src');
  const dialog = await openViewer(form);
  await reconstruct(page, dialog);
  await page.evaluate(() => {
    (window as unknown as State).product3dTest.failAssetWrite = true;
  });
  await dialog.getByRole('button', { name: '선택한 각도 수정', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/저장|공간|교체/);
  await expect(dialog.getByTestId('product3d-canvas')).toBeVisible();
  expect(
    await form
      .getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })
      .getAttribute('src'),
  ).toBe(source);
  await page.evaluate(() => {
    (window as unknown as State).product3dTest.failAssetWrite = false;
  });
  await updateSelectedAndClose(dialog);
  expect(await page.evaluate(() => (window as unknown as State).product3dTest.workers)).toBe(1);
});

test('모의 응답: 중복 방지·실패 재시도·취소 후 늦은 메시 폐기', async ({ page }) => {
  const { form } = await openForm(page);
  const source = await form
    .getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })
    .getAttribute('src');
  const dialog = await openViewer(form);
  await dialog.getByRole('button', { name: '입체화 시작', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as unknown as State).product3dTest.fail))
    .toBe('function');
  await page.evaluate(() => (window as unknown as State).product3dTest.fail?.());
  await expect(dialog.getByRole('alert')).toContainText('검증용 GPU/CPU 실행 불가');
  await dialog.getByRole('button', { name: /다시 시도|재시도/ }).click();
  await expect(dialog.getByRole('button', { name: '선택한 각도 수정', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: /생성 취소|입체화 취소/ }).click();
  await page.evaluate(() => (window as unknown as State).product3dTest.release?.());
  await expect(dialog.getByTestId('product3d-canvas')).toHaveCount(0);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  expect(
    await form
      .getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })
      .getAttribute('src'),
  ).toBe(source);
});

test('실제 메시 재생: 모바일 조작·반복 열기·드래그 프레임 성능', async ({ page }) => {
  const { form } = await openForm(page);
  const dialog = await openViewer(form);
  await reconstruct(page, dialog);
  const canvas = dialog.getByTestId('product3d-canvas');
  await page.evaluate(() => {
    const samples: number[] = [];
    const state = window as Window & { frameProbe?: { samples: number[]; active: boolean } };
    state.frameProbe = { samples, active: true };
    (window as unknown as State).product3dTest.drawCalls = 0;
    (window as Window & { product3dProbeStarted?: number }).product3dProbeStarted = performance.now();
    let previous = performance.now();
    const frame = (now: number) => {
      if (!state.frameProbe?.active) return;
      samples.push(now - previous);
      previous = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  for (let i = 0; i < 8; i++) await drag(page, canvas, (i % 2 ? -1 : 1) * 230, 90);
  const measurements = await page.evaluate(() => {
    const state = window as Window & { frameProbe?: { samples: number[]; active: boolean } };
    state.frameProbe!.active = false;
    const samples = state.frameProbe!.samples.slice(2);
    const averageMs = samples.reduce((a, b) => a + b, 0) / samples.length;
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      averageMs,
      rafFps: 1000 / averageMs,
      fps:
        ((window as unknown as State).product3dTest.drawCalls * 1000) /
        (performance.now() - (window as Window & { product3dProbeStarted?: number }).product3dProbeStarted!),
      renderCalls: (window as unknown as State).product3dTest.drawCalls,
      frames: samples.length,
      over33ms: samples.filter((n) => n > 33.34).length,
      userAgent: navigator.userAgent,
      gpu: gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable',
      hardwareConcurrency: navigator.hardwareConcurrency,
    };
  });
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'performance.json'), JSON.stringify(measurements, null, 2));
  expect(measurements.frames).toBeGreaterThan(30);
  expect(measurements.fps).toBeGreaterThanOrEqual(30);
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('button', { name: '시점 초기화', exact: true }).click();
  await selectProduct(dialog);
  await dialog.getByTestId('product3d-handle-top').focus();
  await dialog.getByTestId('product3d-handle-top').press('ArrowLeft');
  await expect(dialog.getByRole('button', { name: '선택한 각도 수정', exact: true })).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  const touchBox = (await canvas.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const tx = touchBox.x + touchBox.width * 0.35,
    ty = touchBox.y + touchBox.height * 0.45;
  const beforeTouch = await pose(dialog);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty, id: 1 }] });
  for (let i = 1; i <= 10; i++)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: tx + i * 5, y: ty - i * 3, id: 1 }],
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect((await pose(dialog)).cameraQuaternion).not.toEqual(beforeTouch.cameraQuaternion);
  const beforePinch = (await pose(dialog)).zoom;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: tx - 20, y: ty, id: 1 },
      { x: tx + 20, y: ty, id: 2 },
    ],
  });
  for (let i = 1; i <= 10; i++)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: tx - 20 - i * 3, y: ty, id: 1 },
        { x: tx + 20 + i * 3, y: ty, id: 2 },
      ],
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect((await pose(dialog)).zoom).not.toBe(beforePinch);
  await cdp.detach();
  await dialog.screenshot({ path: path.join(output, 'mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('실제 메시 재생: 배경 제거 결과 연결·선택 원본 유지', async ({ page }) => {
  const { form } = await openForm(page);
  await form.getByRole('button', { name: '정면 사진 AI 배경 제거 테스트', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as unknown as State).product3dTest.releaseBackground))
    .toBe('function');
  await page.evaluate(() => (window as unknown as State).product3dTest.releaseBackground?.());
  const background = page.getByRole('dialog', { name: 'AI 배경 제거 테스트', exact: true });
  await background.getByRole('button', { name: '360° 입체화', exact: true }).click();
  await expect(background).toHaveCount(0);
  const dialog = page.getByRole('dialog', { name: '360° 제품 편집', exact: true });
  await reconstruct(page, dialog);
  await updateSelectedAndClose(dialog);
  await expect(form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })).toHaveCount(
    1,
  );
});

test('실제 메시 재생: 저장 메시 유실 시 자동 AI 금지·재생성 안내', async ({ page }) => {
  const { form, name } = await openForm(page);
  const dialog = await openViewer(form);
  await reconstruct(page, dialog);
  await updateSelectedAndClose(dialog);
  await saveForm(form);
  const saved = (await versions(page, name))[0];
  await page.evaluate(async (assetId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('gongganmiri-v1');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('assets', 'readwrite');
      tx.objectStore('assets').delete(assetId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, saved.views[0].product3d!.meshAssetId);
  await page.reload();
  await page
    .locator('article')
    .filter({ hasText: name })
    .getByRole('button', { name: '정보 수정', exact: true })
    .click();
  const edit = page.getByRole('dialog', { name: '자재 수정', exact: true });
  const reopened = await openViewer(edit, '정면', true);
  await expect(reopened.getByRole('alert')).toContainText(/형상|입체|메시|찾을|불러|없/);
  expect(await page.evaluate(() => (window as unknown as State).product3dTest.workers)).toBe(0);
  await expect(reopened.getByRole('button', { name: /입체화 시작|다시 입체화|재생성/ })).toBeVisible();
});

test('실제 메시 재생: WebGL 초기화 실패 안내·원본 보존', async ({ page }) => {
  const { form } = await openForm(page);
  const source = await form
    .getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })
    .getAttribute('src');
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...args: unknown[]
    ) {
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') return null;
      return original.apply(this, [type, ...args] as Parameters<typeof original>);
    } as typeof original;
  });
  const dialog = await openViewer(form);
  await dialog.getByRole('button', { name: '입체화 시작', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as unknown as State).product3dTest.release))
    .toBe('function');
  await page.evaluate(() => (window as unknown as State).product3dTest.release?.());
  await expect(dialog.getByRole('alert')).toContainText(/WebGL|그래픽|GPU|표시/);
  await expect(dialog.getByRole('button', { name: '선택한 각도 수정', exact: true })).toBeDisabled();
  expect(
    await form
      .getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })
      .getAttribute('src'),
  ).toBe(source);
});

// Real inference: no Worker/model/image response is mocked. Only file transport
// redirects to a local HTTP stream of the pinned, already-downloaded ONNX files.
test('실제 AI opt-in: 프로덕션 Worker 추론→360 뷰어→PNG·각도 변경', async ({ page, context }) => {
  test.skip(
    process.env.SJN_PRODUCT3D_REAL !== '1',
    'SJN_PRODUCT3D_REAL=1 requires pinned models in tmp/multiview-model and a supported device.',
  );
  test.setTimeout(1_500_000);
  const models = path.resolve(process.env.SJN_PRODUCT3D_MODELS ?? 'tmp/multiview-model');
  const runtime = path.resolve('node_modules/onnxruntime-web/dist');
  for (const file of ['encoder_fp16.onnx', 'backbone_fp16.onnx', 'decoder_fp16.onnx'])
    expect(existsSync(path.join(models, file))).toBe(true);
  expect(existsSync(sourceFile)).toBe(true);
  const served: { file: string; bytes: number }[] = [];
  const server = createServer((req, res) => {
    const name = path.basename(new URL(req.url!, 'http://localhost').pathname);
    const root = name.endsWith('.onnx') ? models : runtime;
    const file = path.join(root, name);
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const bytes = statSync(file).size;
    served.push({ file: name, bytes });
    res.writeHead(200, {
      'Content-Type': name.endsWith('.wasm')
        ? 'application/wasm'
        : name.endsWith('.mjs') || name.endsWith('.js')
          ? 'text/javascript'
          : 'application/octet-stream',
      'Content-Length': bytes,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local model server did not start.');
  const origin = `http://127.0.0.1:${address.port}`;
  await context.route('https://huggingface.co/**', (route) =>
    route.fulfill({
      status: 307,
      headers: {
        location: `${origin}/${path.basename(new URL(route.request().url()).pathname)}`,
        'access-control-allow-origin': '*',
      },
    }),
  );
  await context.route('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/**', (route) =>
    route.fulfill({
      status: 307,
      headers: {
        location: `${origin}/${path.basename(new URL(route.request().url()).pathname)}`,
        'access-control-allow-origin': '*',
      },
    }),
  );
  const events: unknown[] = [];
  await page.exposeFunction('recordProduct3d', (event: unknown) => events.push(event));
  await page.addInitScript(() => {
    const Original = Worker;
    const observer = window as unknown as Window & { recordProduct3d(event: unknown): Promise<void> };
    class ObservedWorker extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name !== 'sjn-product3d') return;
        observer.recordProduct3d({ type: 'worker-start' });
        this.addEventListener('message', (e: MessageEvent) => {
          if (e.data.type === 'progress') observer.recordProduct3d(e.data);
          else if (e.data.type === 'mesh')
            observer.recordProduct3d({
              type: 'mesh',
              vertices: e.data.mesh.positions.length / 3,
              triangles: e.data.mesh.indices.length / 3,
              timings: e.data.timings,
            });
          else observer.recordProduct3d(e.data);
        });
      }
    }
    globalThis.Worker = ObservedWorker;
  });
  try {
    await page.goto('http://127.0.0.1:3000/materials');
    await page.getByRole('button', { name: '자재 등록', exact: true }).click();
    const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
    await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
    await form.getByLabel('상품명').fill(`실제 AI 360 ${Date.now()}`);
    await form.getByLabel('+ 제품 이미지 올리기', { exact: true }).setInputFiles(sourceFile);
    await form.getByLabel('촬영 방향 1', { exact: true }).fill('정면');
    const dialog = await openViewer(form);
    expect(served.filter((f) => f.file.endsWith('.onnx'))).toHaveLength(0);
    await dialog.getByRole('button', { name: '입체화 시작', exact: true }).click();
    await expect
      .poll(
        async () => {
          if (await dialog.getByRole('alert').count())
            throw new Error(await dialog.getByRole('alert').innerText());
          return dialog.getByRole('button', { name: '선택한 각도 수정', exact: true }).isEnabled();
        },
        { timeout: 1_200_000, intervals: [1000, 2500, 5000] },
      )
      .toBe(true);
    const pixels = await png(dialog, path.join(output, 'real-inference.png'));
    const servedBefore = served.length;
    const workersBefore = events.filter((e) => (e as { type: string }).type === 'worker-start').length;
    await drag(page, dialog.getByTestId('product3d-canvas'), 210, -140);
    await selectProduct(dialog);
    await drag(page, dialog.getByTestId('product3d-handle-top'), 30, 0);
    await png(dialog, path.join(output, 'real-inference-adjusted.png'));
    expect(served.length).toBe(servedBefore);
    expect(events.filter((e) => (e as { type: string }).type === 'worker-start')).toHaveLength(workersBefore);
    await dialog.screenshot({ path: path.join(output, 'real-inference-ui.png') });
    writeFileSync(
      path.join(output, 'real-inference.json'),
      JSON.stringify(
        {
          events,
          served,
          pixels,
          note: 'Pinned model bytes were streamed over localhost, not downloaded from the internet. Inference used the production Worker without response mocking.',
        },
        null,
        2,
      ),
    );
  } finally {
    mkdirSync(output, { recursive: true });
    writeFileSync(
      path.join(output, 'real-inference-progress.json'),
      JSON.stringify({ events, served }, null, 2),
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('실제 메시 재생: 저장 자세의 초기 WebGL 실패 후 뷰어 재시도 자세 유지', async ({ page }) => {
  const { form, name } = await openForm(page);
  let dialog = await openViewer(form);
  await reconstruct(page, dialog);
  await drag(page, dialog.getByTestId('product3d-canvas'), 120, -70);
  await selectProduct(dialog);
  await drag(page, dialog.getByTestId('product3d-handle-top'), 35, 0);
  await dialog.getByRole('button', { name: '확대', exact: true }).click();
  const savedPose = await pose(dialog);
  await updateSelectedAndClose(dialog);
  await saveForm(form);
  await page.reload();
  await page
    .locator('article')
    .filter({ hasText: name })
    .getByRole('button', { name: '정보 수정', exact: true })
    .click();
  await page.evaluate(() => {
    const state = window as Window & { rejectProductGl?: boolean };
    state.rejectProductGl = true;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...args: unknown[]
    ) {
      if (state.rejectProductGl && (type === 'webgl2' || type === 'webgl')) return null;
      return original.apply(this, [type, ...args] as Parameters<typeof original>);
    } as typeof original;
  });
  dialog = await openViewer(page.getByRole('dialog', { name: '자재 수정', exact: true }), '정면', true);
  await expect(dialog.getByRole('alert')).toContainText('WebGL');
  await page.evaluate(() => {
    (window as Window & { rejectProductGl?: boolean }).rejectProductGl = false;
  });
  await dialog.getByRole('button', { name: '뷰어 다시 열기', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '화면 맞춤', exact: true })).toBeEnabled();
  const recovered = await pose(dialog);
  for (const field of ['objectQuaternion', 'cameraQuaternion'] as const)
    recovered[field].forEach((n, i) => expect(n).toBeCloseTo(savedPose[field][i], 10));
  expect(recovered.zoom).toBeCloseTo(savedPose.zoom, 10);
  expect(await page.evaluate(() => (window as unknown as State).product3dTest.workers)).toBe(0);
});

async function addAngle(dialog: Locator, name: string) {
  const before = await dialog.getByTestId('product3d-angle-card').count();
  await expect(dialog.getByLabel('새 각도 이름 빠른 선택', { exact: true })).toBeVisible();
  await dialog.getByLabel('새 각도 이름 빠른 선택', { exact: true }).selectOption('왼쪽 사선');
  await expect(dialog.getByLabel('새 각도 이름', { exact: true })).toHaveValue('왼쪽 사선');
  await dialog.getByLabel('새 각도 이름', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '이 각도 추가', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('product3d-angle-card')).toHaveCount(before + 1);
  await expect(dialog.getByRole('button', { name: `${name} 각도 선택`, exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '이 각도 추가', exact: true })).toBeEnabled();
}
function closePose(actual: Pose, expected: Pose) {
  for (const field of ['objectQuaternion', 'cameraQuaternion'] as const)
    actual[field].forEach((n, i) => expect(n).toBeCloseTo(expected[field][i], 9));
  expect(actual.zoom).toBeCloseTo(expected.zoom, 9);
}

test('실제 메시 재생: 한 번 입체화로 세 각도 추가·공유 메시·개별 수정·이름·삭제·저장', async ({ page }) => {
  const { form: originalForm, name } = await openForm(page);
  await originalForm.getByLabel('기준 단가', { exact: true }).fill('350000');
  await saveForm(originalForm);
  const first = (await versions(page, name))[0];
  await page
    .locator('article')
    .filter({ hasText: name })
    .getByRole('button', { name: '정보 수정', exact: true })
    .click();
  const form = page.getByRole('dialog', { name: '자재 수정', exact: true });
  let dialog = await openViewer(form);
  await reconstruct(page, dialog);
  const firstPose = await pose(dialog);
  await addAngle(dialog, '왼쪽 25도');
  await drag(page, dialog.getByTestId('product3d-canvas'), 170, -65);
  const secondPose = await pose(dialog);
  expect(secondPose.cameraQuaternion).not.toEqual(firstPose.cameraQuaternion);
  await addAngle(dialog, '오른쪽 30도');
  await drag(page, dialog.getByTestId('product3d-canvas'), -90, 120);
  const thirdPose = await pose(dialog);
  expect(thirdPose.cameraQuaternion).not.toEqual(secondPose.cameraQuaternion);
  await addAngle(dialog, '위에서 본 모습');
  await expect(dialog.getByTestId('product3d-angle-card')).toHaveCount(4);
  expect(await page.evaluate(() => (window as unknown as State).product3dTest.workers)).toBe(1);
  await dialog.getByRole('button', { name: '왼쪽 25도 각도 선택', exact: true }).click();
  closePose(await pose(dialog), firstPose);
  await drag(page, dialog.getByTestId('product3d-canvas'), 55, 0);
  const changedFirstPose = await pose(dialog);
  await dialog.getByRole('button', { name: '선택한 각도 수정', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '선택한 각도 수정', exact: true })).toBeEnabled();
  await expect(dialog.getByTestId('product3d-angle-card')).toHaveCount(4);
  await dialog.getByRole('button', { name: '오른쪽 30도 각도 선택', exact: true }).click();
  closePose(await pose(dialog), secondPose);
  await dialog.getByRole('button', { name: '위에서 본 모습 각도 선택', exact: true }).click();
  closePose(await pose(dialog), thirdPose);
  await dialog.getByRole('button', { name: '왼쪽 25도 각도 선택', exact: true }).click();
  await dialog.getByRole('button', { name: '왼쪽 25도 이름 변경', exact: true }).click();
  await dialog.getByLabel('각도 이름 변경 빠른 선택', { exact: true }).selectOption('정면');
  await expect(dialog.getByLabel('각도 이름 변경', { exact: true })).toHaveValue('정면');
  await dialog.getByLabel('각도 이름 변경', { exact: true }).fill('시공 확인 각도');
  await dialog.getByRole('button', { name: '이름 저장', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '시공 확인 각도 각도 선택', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '정면 각도 선택', exact: true }).click();
  page.once('dialog', (prompt) => prompt.accept());
  await dialog.getByRole('button', { name: '정면 삭제', exact: true }).click();
  await expect(dialog.getByTestId('product3d-angle-card')).toHaveCount(3);
  await dialog.getByRole('button', { name: '시공 확인 각도 각도 선택', exact: true }).click();
  closePose(await pose(dialog), changedFirstPose);
  await drag(page, dialog.getByTestId('product3d-canvas'), 90, 80); // Do not apply this final draft pose.
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await saveForm(form, true);
  const all = await versions(page, name);
  expect(all[0]).toEqual(first);
  const last = all.at(-1)!;
  expect(last.views).toHaveLength(3);
  expect(last.views.map((v) => v.direction)).toEqual(['시공 확인 각도', '오른쪽 30도', '위에서 본 모습']);
  expect(new Set(last.views.map((v) => v.product3d?.meshAssetId)).size).toBe(1);
  expect(new Set(last.views.map((v) => v.product3d?.inputAssetId)).size).toBe(1);
  expect(new Set(last.views.map((v) => v.assetId)).size).toBe(3);
  closePose(last.views[0].product3d!.pose, changedFirstPose);
  closePose(last.views[1].product3d!.pose, secondPose);
  closePose(last.views[2].product3d!.pose, thirdPose);
  const blobHashes = await page.evaluate(
    async (ids) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open('gongganmiri-v1');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      try {
        const results = [];
        for (const id of ids) {
          const asset = await new Promise<{ blob: Blob }>((resolve, reject) => {
            const r = db.transaction('assets').objectStore('assets').get(id);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          results.push(
            Array.from(
              new Uint8Array(await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer())),
            ).join(','),
          );
        }
        return results;
      } finally {
        db.close();
      }
    },
    last.views.map((v) => v.assetId),
  );
  expect(new Set(blobHashes).size).toBe(3);
  await page.reload();
  await page
    .locator('article')
    .filter({ hasText: name })
    .getByRole('button', { name: '정보 수정', exact: true })
    .click();
  const reopenedForm = page.getByRole('dialog', { name: '자재 수정', exact: true });
  dialog = await openViewer(reopenedForm, '시공 확인 각도', true);
  await expect(dialog.getByRole('button', { name: '화면 맞춤', exact: true })).toBeEnabled();
  closePose(await pose(dialog), changedFirstPose);
  await dialog.getByRole('button', { name: '위에서 본 모습 각도 선택', exact: true }).click();
  closePose(await pose(dialog), thirdPose);
  expect(await page.evaluate(() => (window as unknown as State).product3dTest.workers)).toBe(0);
  await dialog.screenshot({ path: path.join(output, 'multiple-angles.png') });
  const gallery = dialog.getByRole('region', { name: '저장한 각도 사진', exact: true });
  await gallery.scrollIntoViewIfNeeded();
  await gallery.screenshot({ path: path.join(output, 'multiple-angles-gallery.png') });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await reopenedForm.getByRole('button', { name: '취소', exact: true }).click();
  expect(await versions(page, name)).toEqual(all);
});

test('여러 각도 자재: 공간에서 썸네일 변경 시 제품 ID·위치·배치 개수·단가 유지', async ({ page }) => {
  const { form, name } = await openForm(page, 2);
  await form.getByLabel('촬영 방향 1', { exact: true }).fill('앞에서 보기');
  await form.getByLabel('촬영 방향 2', { exact: true }).fill('옆에서 보기');
  await form.getByLabel('기준 단가', { exact: true }).fill('350000');
  await saveForm(form);
  const material = (await versions(page, name))[0];
  await page.goto('http://127.0.0.1:3000/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await savedProject(page);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  const emptyProject = await savedProject(page);
  await page.locator('button.material-tile').filter({ hasText: name }).click();
  await expect(page.getByLabel('제품 배율', { exact: true })).toBeVisible();
  const originalProject = await savedProject(page, emptyProject.editRevision);
  const originalDesign = getActiveDesign(originalProject)!;
  const original = originalDesign.scene.fixtures[0];
  const before = calculateMaterialUsage(
    originalDesign.scene,
    { [material.id]: material },
    originalDesign.materialUsage,
  );
  expect(before.total).toBe(350000);
  expect(before.rows[0].count).toBe(1);
  await expect(page.getByRole('combobox', { name: '제품 촬영 방향', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '옆에서 보기 각도 선택', exact: true }).click();
  const afterProject = await savedProject(page, originalProject.editRevision);
  const design = getActiveDesign(afterProject)!;
  const fixture = design.scene.fixtures[0];
  expect(design.scene.fixtures).toHaveLength(1);
  expect(fixture.id).toBe(original.id);
  expect(fixture.materialVersionId).toBe(original.materialVersionId);
  expect(fixture.position).toEqual(original.position);
  expect(fixture.roomPlacement?.u).toBe(original.roomPlacement?.u);
  expect(fixture.roomPlacement?.v).toBe(original.roomPlacement?.v);
  expect(fixture.viewIndex).toBe(1);
  expect(calculateMaterialUsage(design.scene, { [material.id]: material }, design.materialUsage)).toEqual(
    before,
  );
  await page.getByRole('button', { name: '앞에서 보기 각도 선택', exact: true }).click();
  const restored = getActiveDesign(await savedProject(page, afterProject.editRevision))!.scene.fixtures[0];
  expect(restored.id).toBe(original.id);
  expect(restored.viewIndex).toBe(0);
  expect(await page.evaluate(() => (window as unknown as State).product3dTest.workers)).toBe(0);
});
