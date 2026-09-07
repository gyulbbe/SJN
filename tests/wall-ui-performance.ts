import { getActiveDesign } from '../src/lib/designs';
import { seedTestTiles, uploadBathroomPhoto } from './helpers/catalog-fixtures.mjs';
/** Real UI benchmark: next dev on port 3000, then node --experimental-strip-types tests/wall-ui-performance.ts. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { MaterialVersion, ProjectDocument } from '../src/lib/types';

const directory = 'test-results/wall-ui-performance';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
const pageErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const report: Record<string, unknown> = {
  measuredAt: new Date().toISOString(),
  browser: await browser.version(),
  runtime: process.version,
  environment: 'Windows / installed Chrome headless / next dev / isolated temporary browser context',
  launchArgs: ['--enable-webgl', '--ignore-gpu-blocklist'],
  compositorSha256: createHash('sha256')
    .update(await readFile('src/lib/render/compositor.ts'))
    .digest('hex'),
  photoSha256: createHash('sha256')
    .update(await readFile('public/examples/bathroom.png'))
    .digest('hex'),
};

async function readProject(): Promise<ProjectDocument> {
  return page.evaluate(
    (id) =>
      new Promise<ProjectDocument>((resolve, reject) => {
        const request = indexedDB.open('gongganmiri-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction('projects').objectStore('projects').get(id);
          get.onerror = () => {
            db.close();
            reject(get.error);
          };
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
        };
      }),
    page.url().split('/').at(-1)!,
  );
}

try {
  await mkdir(directory, { recursive: true });
  await page.goto('http://127.0.0.1:3000');
  await seedTestTiles(page);
  await uploadBathroomPhoto(page);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  assert.equal(getActiveDesign((await readProject()))!.scene.surfaces.length, 0);

  // Actual two-click automatic detection: no manually supplied masks, seams or quads.
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  const detectionStarted = Date.now();
  await page.locator('button.material-tile').filter({ hasText: '클라우드 화이트' }).click();
  await expect(page.getByTestId('auto-detection-status')).toBeVisible();
  await expect(page.getByTestId('auto-detection-status')).toHaveCount(0, { timeout: 120000 });
  await expect
    .poll(
      async () =>
        getActiveDesign((await readProject()))!.scene.surfaces.filter(
          (surface) => surface.kind === 'wall' && surface.materialVersionId,
        ).length,
    )
    .toBe(3);
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await expect(page.locator('.editor-error')).toHaveCount(0);
  report.automaticSceneReadyMs = Date.now() - detectionStarted;
  const before = await readProject();
  assert.equal(getActiveDesign(before)!.scene.fixtures.length, 0);
  assert.equal(getActiveDesign(before)!.scene.surfaces.filter((surface) => surface.kind === 'floor').length, 1);
  assert.ok(
    getActiveDesign(before)!.scene.surfaces
      .filter((surface) => surface.kind === 'floor')
      .every((surface) => !surface.materialVersionId),
  );

  const materialId = getActiveDesign(before)!.scene.surfaces.find((surface) => surface.materialVersionId)!.materialVersionId!;
  const material = await page.evaluate(
    (id) =>
      new Promise<MaterialVersion>((resolve, reject) => {
        const request = indexedDB.open('gongganmiri-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction('versions').objectStore('versions').get(id);
          get.onerror = () => {
            db.close();
            reject(get.error);
          };
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
        };
      }),
    materialId,
  );
  assert.equal(material.name, '클라우드 화이트');
  assert.equal(
    new Set(
      getActiveDesign(before)!.scene.surfaces
        .filter((surface) => surface.materialVersionId)
        .map((surface) => surface.materialVersionId),
    ).size,
    1,
  );
  report.scene = {
    source: 'public/examples/bathroom.png',
    creation:
      'Fresh example project; wall tile tab then Cloud White tile; actual bundled model inference and automatic three-wall geometry',
    sourcePixels: [getActiveDesign(before)!.scene.imageWidth, getActiveDesign(before)!.scene.imageHeight],
    surfaces: getActiveDesign(before)!.scene.surfaces.map((surface) => ({
      name: surface.name,
      kind: surface.kind,
      applied: !!surface.materialVersionId,
      quad: surface.quad,
      widthMm: surface.widthMm,
      heightMm: surface.heightMm,
      calibrated: surface.calibrated,
      tile: surface.tile,
      maskContours: (surface.mask.polygon.length ? 1 : 0) + (surface.mask.polygons?.length ?? 0),
      maskHoles: surface.mask.holes?.length ?? 0,
      maskVertices:
        surface.mask.polygon.length +
        (surface.mask.polygons ?? []).reduce((sum, points) => sum + points.length, 0) +
        (surface.mask.holes ?? []).reduce((sum, points) => sum + points.length, 0),
    })),
    material: {
      name: material.name,
      widthMm: material.widthMm,
      heightMm: material.heightMm,
      textureVariants: material.textureAssetIds.length,
    },
    fixtures: getActiveDesign(before)!.scene.fixtures.length,
    protectionContours:
      (getActiveDesign(before)!.scene.protection.polygon.length ? 1 : 0) + (getActiveDesign(before)!.scene.protection.polygons?.length ?? 0),
    globalColorBefore: getActiveDesign(before)!.scene.color,
  };

  await page.getByRole('button', { name: '전체 공간', exact: true }).click();
  await page.getByLabel('노출', { exact: true }).scrollIntoViewIfNeeded();
  const measurement = await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="노출"]')!;
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="canvas-frame"] canvas')!;
    const gl = canvas.getContext('webgl2')!;
    if (!input || !canvas || !gl) throw new Error('Actual exposure input or WebGL canvas missing');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    let changedValues = 0;
    const drive = (value: number) => {
      const next = value.toFixed(2);
      if (Number(input.value) !== Number(next)) changedValues++;
      nativeSet.call(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    // Warm material, masks, pooled wall shading and actual React update path before timing.
    const warmStarted = performance.now();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        drive(Math.sin((performance.now() - warmStarted) / 200) * 0.18);
        if (performance.now() - warmStarted >= 1500) {
          clearInterval(timer);
          resolve();
        }
      }, 16);
    });
    const warmupMs = performance.now() - warmStarted;
    changedValues = 0;
    const rafTimes: number[] = [],
      drawTimes: number[] = [],
      inputToDraw: number[] = [],
      longTasks: number[] = [];
    const originalDrawElements = gl.drawElements.bind(gl);
    const originalDrawArrays = gl.drawArrays.bind(gl);
    const originalBind = gl.bindFramebuffer.bind(gl);
    let defaultTarget = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === null;
    let lastInput = performance.now(),
      active = true,
      inputs = 0;
    gl.bindFramebuffer = (target, framebuffer) => {
      if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) defaultTarget = framebuffer === null;
      originalBind(target, framebuffer);
    };
    const record = () => {
      if (active && defaultTarget) {
        const now = performance.now();
        drawTimes.push(now);
        inputToDraw.push(now - lastInput);
      }
    };
    gl.drawElements = (mode, count, type, offset) => {
      originalDrawElements(mode, count, type, offset);
      record();
    };
    gl.drawArrays = (mode, first, count) => {
      originalDrawArrays(mode, first, count);
      record();
    };
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: 'longtask', buffered: false });
    const started = performance.now();
    const frame = (timestamp: number) => {
      if (active) {
        rafTimes.push(timestamp);
        requestAnimationFrame(frame);
      }
    };
    requestAnimationFrame(frame);
    let duration: number;
    try {
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          lastInput = performance.now();
          inputs++;
          drive(Math.sin((lastInput - started) / 340) * 0.45);
          if (lastInput - started >= 5000) {
            clearInterval(timer);
            resolve();
          }
        }, 16);
      });
      duration = performance.now() - started;
    } finally {
      active = false;
      for (const entry of observer.takeRecords()) longTasks.push(entry.duration);
      observer.disconnect();
      gl.drawElements = originalDrawElements;
      gl.drawArrays = originalDrawArrays;
      gl.bindFramebuffer = originalBind;
    }
    const changed = changedValues;
    drive(0);
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    input.blur();
    const percentile = (values: number[], fraction: number) =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length * fraction)] ?? null;
    const rafGaps = rafTimes.slice(1).map((time, index) => time - rafTimes[index]);
    const drawGaps = drawTimes.slice(1).map((time, index) => time - drawTimes[index]);
    return {
      gpu,
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      viewport: [innerWidth, innerHeight],
      devicePixelRatio,
      canvasBacking: [canvas.width, canvas.height],
      canvasDisplay: [canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height],
      warmupMs,
      durationMs: duration,
      inputEvents: inputs,
      inputValueChanges: changed,
      renderedCanvasSubmissions: drawTimes.length,
      submittedCanvasRate: (drawTimes.length / duration) * 1000,
      submissionGapP95Ms: percentile(drawGaps, 0.95),
      submissionGapMaxMs: Math.max(0, ...drawGaps),
      lastInputToDrawP95Ms: percentile(inputToDraw, 0.95),
      longTaskCount: longTasks.length,
      longTaskMaxMs: Math.max(0, ...longTasks),
      rafCallbacks: rafTimes.length,
      rafCallbackRate: (rafTimes.length / duration) * 1000,
      rafGapP95Ms: percentile(rafGaps, 0.95),
      rafGapMaxMs: Math.max(0, ...rafGaps),
    };
  });
  report.measurement = measurement;
  report.methodology = {
    control:
      'Whole-space exposure slider, native HTMLInputElement setter and bubbling input events; sine -0.45 to +0.45, 0.01 step, timer approximately 16ms',
    timing:
      'At least 1500ms actual slider warmup, then at least 5000ms actual React/Zustand UI updates and final default-framebuffer draw calls',
    count:
      'Compositor has one final default-framebuffer output draw per complete render; intermediate surface passes are excluded',
    limitations: [
      'Submission rate is not GPU completion or physical display presentation FPS.',
      '1920x1080 is the browser viewport; actual renderer backing resolution is recorded separately.',
      'rAF callback rate measures browser scheduling only, not app-rendered frames.',
      'Last-input-to-draw is age of the most recent generated event, not verified per-event end-to-end latency.',
      'One warmed five-second sample on this PC in development mode; no cross-device performance guarantee.',
      'Repeated quantized input values can cause fewer state updates than generated events.',
    ],
  };
  assert.ok(
    !/swiftshader|llvmpipe|software/i.test(measurement.gpu),
    `Native GPU required: ${measurement.gpu}`,
  );
  assert.ok(measurement.renderedCanvasSubmissions > 10, 'Actual input must cause final canvas submissions');
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  await expect.poll(async () => getActiveDesign((await readProject()))!.scene.color.exposure).toBe(0);
  await expect(page.locator('.editor-error')).toHaveCount(0);
  await page.screenshot({ path: `${directory}/desktop-editor.png`, fullPage: true });
  report.pageErrors = pageErrors;
  assert.deepEqual(pageErrors, []);
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log('WALL_UI_PERFORMANCE', JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.pageErrors = pageErrors;
  await page.screenshot({ path: `${directory}/failure.png`, fullPage: true }).catch(() => {});
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  throw error;
} finally {
  await browser.close();
}
