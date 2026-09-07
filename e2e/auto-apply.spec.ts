import { getActiveDesign } from '../src/lib/designs';
import { seedTestTiles, uploadBathroomPhoto } from '../tests/helpers/catalog-fixtures.mjs';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProjectDocument } from '../src/lib/types';

test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(180000);

async function attachEvidence(info: TestInfo, name: string, data: { body: Buffer; contentType: string }) {
  const directory = resolve('test-results/auto-apply-qa');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, name);
  await writeFile(path, data.body);
  await info.attach(name, { path, contentType: data.contentType });
}

const landmarks = [
  { name: 'wall', x: 0.54, y: 0.35 },
  { name: 'floor', x: 0.46, y: 0.87 },
  { name: 'toilet', x: 0.65, y: 0.68 },
  { name: 'mirror', x: 0.37, y: 0.31 },
];

async function readProject(page: Page): Promise<ProjectDocument> {
  const id = page.url().split('/').at(-1)!;
  return page.evaluate(
    (projectId) =>
      new Promise<ProjectDocument>((resolve, reject) => {
        const request = indexedDB.open('gongganmiri-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const get = database.transaction('projects').objectStore('projects').get(projectId);
          get.onerror = () => {
            database.close();
            reject(get.error);
          };
          get.onsuccess = () => {
            database.close();
            resolve(get.result);
          };
        };
      }),
    id,
  );
}

async function readyProject(page: Page) {
  await page.goto('/');
  await seedTestTiles(page);
  await uploadBathroomPhoto(page);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  await expect(page.locator('.editor-error')).toHaveCount(0);
  return readProject(page);
}

async function imagePixels(page: Page) {
  return page.locator('[data-testid="canvas-frame"] canvas').evaluate((element, points) => {
    const image = element as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = image.width;
    copy.height = image.height;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    return points.map((point) => [
      ...ctx.getImageData(Math.floor(point.x * image.width), Math.floor(point.y * image.height), 1, 1).data,
    ]);
  }, landmarks);
}

const difference = (a: number[], b: number[]) =>
  Math.max(...a.slice(0, 3).map((value, i) => Math.abs(value - b[i])));
const materialButton = (page: Page, name: string) =>
  page.locator('button.material-tile').filter({ hasText: name });

test('벽 탭과 차콜 클릭만으로 실제 감지 후 벽에 적용하고, 바닥은 캐시로 적용하며 실행 취소한다', async ({
  page,
}, testInfo) => {
  const modelRequests: string[] = [];
  const pageErrors: string[] = [];
  page.context().on('request', (request) => {
    if (/\/models\/deeplab-ade20k\//.test(request.url())) modelRequests.push(request.url());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const before = await readyProject(page);
  expect(getActiveDesign(before)!.scene.surfaces).toEqual([]);
  const beforePixels = await imagePixels(page);

  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await materialButton(page, '차콜 스톤').click();
  await expect(page.getByTestId('auto-detection-status')).toBeVisible();
  await expect(page.getByTestId('auto-detection-status')).toHaveCount(0, { timeout: 120000 });
  await expect
    .poll(
      async () =>
        getActiveDesign(await readProject(page))!.scene.surfaces.some(
          (surface) => surface.kind === 'wall' && !!surface.materialVersionId,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  const wall = await readProject(page);
  const wallSurfaces = getActiveDesign(wall)!.scene.surfaces.filter((surface) => surface.kind === 'wall');
  expect(wallSurfaces.length).toBeGreaterThan(0);
  expect(wallSurfaces.every((surface) => !!surface.materialVersionId && !surface.calibrated)).toBe(true);
  expect(new Set(wallSurfaces.map((surface) => surface.materialVersionId)).size).toBe(1);
  expect(
    getActiveDesign(wall)!
      .scene.surfaces.filter((surface) => surface.kind === 'floor')
      .every((surface) => !surface.materialVersionId),
  ).toBe(true);
  expect(getActiveDesign(wall)!.history.past).toHaveLength(getActiveDesign(before)!.history.past.length + 1);
  expect(getActiveDesign(wall)!.history.past.at(-1)?.scene).toEqual(getActiveDesign(before)!.scene);
  expect(wall.editRevision).toBe(before.editRevision + 1);
  expect(modelRequests.length).toBeGreaterThan(0);
  expect(modelRequests.every((url) => new URL(url).hostname === '127.0.0.1')).toBe(true);
  await expect
    .poll(async () => difference((await imagePixels(page))[0], beforePixels[0]))
    .toBeGreaterThan(30);
  const wallPixels = await imagePixels(page);
  for (const index of [1, 2, 3])
    expect(
      difference(wallPixels[index], beforePixels[index]),
      `${landmarks[index].name} remains original after wall application`,
    ).toBeLessThanOrEqual(3);
  await attachEvidence(testInfo, 'automatic-wall.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  const requestsAfterWall = modelRequests.length;
  const idsAfterWall = getActiveDesign(wall)!.scene.surfaces.map((surface) => surface.id);

  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await materialButton(page, '웜 샌드').click();
  await expect
    .poll(
      async () =>
        getActiveDesign(await readProject(page))!.scene.surfaces.some(
          (surface) => surface.kind === 'floor' && !!surface.materialVersionId,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect(page.getByTestId('auto-detection-status')).toHaveCount(0);
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  const floor = await readProject(page);
  expect(getActiveDesign(floor)!.scene.surfaces.map((surface) => surface.id)).toEqual(idsAfterWall);
  expect(getActiveDesign(floor)!.scene.surfaces.filter((surface) => surface.kind === 'wall')).toEqual(
    wallSurfaces,
  );
  expect(modelRequests).toHaveLength(requestsAfterWall);
  expect(floor.editRevision).toBe(wall.editRevision + 1);
  await expect
    .poll(async () => difference((await imagePixels(page))[1], beforePixels[1]))
    .toBeGreaterThan(20);
  const floorPixels = await imagePixels(page);
  for (const index of [0, 2, 3])
    expect(
      difference(floorPixels[index], wallPixels[index]),
      `${landmarks[index].name} remains unchanged after floor application`,
    ).toBeLessThanOrEqual(3);

  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect
    .poll(async () => getActiveDesign(await readProject(page))!.scene)
    .toEqual(getActiveDesign(wall)!.scene);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect
    .poll(async () => getActiveDesign(await readProject(page))!.scene)
    .toEqual(getActiveDesign(before)!.scene);
  await expect(page.getByTestId('auto-detection-status')).toHaveCount(0);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await expect
    .poll(async () => getActiveDesign(await readProject(page))!.scene)
    .toEqual(getActiveDesign(wall)!.scene);
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await materialButton(page, '클라우드 화이트').click();
  await expect
    .poll(async () =>
      getActiveDesign(await readProject(page))!
        .scene.surfaces.filter((surface) => surface.kind === 'wall')
        .every((surface) => surface.materialVersionId !== wallSurfaces[0].materialVersionId),
    )
    .toBe(true);
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  const changed = await readProject(page);
  expect(getActiveDesign(changed)!.scene.surfaces.map((surface) => surface.id)).toEqual(idsAfterWall);
  expect(
    getActiveDesign(changed)!
      .scene.surfaces.filter((surface) => surface.kind === 'floor')
      .every((surface) => !surface.materialVersionId),
  ).toBe(true);
  expect(modelRequests).toHaveLength(requestsAfterWall);
  expect(pageErrors).toEqual([]);
  await attachEvidence(testInfo, 'automatic-apply-report.json', {
    body: Buffer.from(
      JSON.stringify(
        {
          beforePixels,
          wallPixels,
          floorPixels,
          landmarks,
          modelRequests,
          surfaces: getActiveDesign(wall)!.scene.surfaces.map((surface) => ({
            id: surface.id,
            kind: surface.kind,
            vertices:
              surface.mask.polygon.length +
              (surface.mask.polygons ?? []).reduce((sum, polygon) => sum + polygon.length, 0),
            holes: surface.mask.holes?.length ?? 0,
          })),
          documentBytes: Buffer.byteLength(JSON.stringify(changed)),
          pageErrors,
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });
});

test('모델 실패 때 장면을 보존하고 다시 누르면 실제 분석을 재시도한다', async ({ page }, testInfo) => {
  const blockedModelRequests: string[] = [];
  const pageErrors: string[] = [];
  let blockModel = true;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.context().route(/\/models\/deeplab-ade20k\/model\.json(?:\?|$)/, async (route) => {
    if (blockModel) {
      blockedModelRequests.push(route.request().url());
      await route.abort('failed');
    } else await route.continue();
  });
  const before = await readyProject(page);
  const beforePixels = await imagePixels(page);
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await materialButton(page, '차콜 스톤').click();
  await expect(page.locator('.editor-error')).toBeVisible({ timeout: 120000 });
  await expect(page.getByTestId('auto-detection-status')).toHaveCount(0);
  await expect(materialButton(page, '차콜 스톤')).toBeEnabled();
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  const failed = await readProject(page);
  expect(blockedModelRequests.length).toBeGreaterThan(0);
  expect(failed).toEqual(before);
  expect(await imagePixels(page)).toEqual(beforePixels);
  await expect(page.getByRole('button', { name: '실행 취소', exact: true })).toBeDisabled();
  const failureMessage = await page.locator('.editor-error').innerText();
  await attachEvidence(testInfo, 'automatic-detection-failure.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  blockModel = false;
  await materialButton(page, '차콜 스톤').click();
  await expect(page.getByTestId('auto-detection-status')).toBeVisible();
  await expect(page.getByTestId('auto-detection-status')).toHaveCount(0, { timeout: 120000 });
  await expect
    .poll(
      async () =>
        getActiveDesign(await readProject(page))!.scene.surfaces.some(
          (surface) => surface.kind === 'wall' && !!surface.materialVersionId,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect(page.locator('.editor-error')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  await attachEvidence(testInfo, 'automatic-detection-failure.json', {
    body: Buffer.from(
      JSON.stringify(
        {
          blockedModelRequests,
          failureMessage,
          unchangedScene: true,
          unchangedHistory: true,
          unchangedEditRevision: true,
          pendingStateCleared: true,
          realInferenceRetrySucceeded: true,
          pageErrors,
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });
});

test('분석 중 Escape 취소는 늦은 실제 결과를 적용하지 않고 다음 클릭에 캐시를 재사용한다', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  const modelRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const state = window as unknown as { completedDetectionReplies: number };
    state.completedDetectionReplies = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.addEventListener('message', (event: MessageEvent<{ type?: string }>) => {
          if (event.data?.type === 'result') state.completedDetectionReplies++;
        });
      }
    };
  });
  let resumeModel = () => {};
  const modelGate = new Promise<void>((resolve) => {
    resumeModel = resolve;
  });
  await page.context().route(/\/models\/deeplab-ade20k\/model\.json(?:\?|$)/, async (route) => {
    modelRequests.push(route.request().url());
    await modelGate;
    await route.continue();
  });
  try {
    const before = await readyProject(page);
    await page.getByRole('button', { name: '벽 타일', exact: true }).click();
    await materialButton(page, '차콜 스톤').click();
    await expect.poll(() => modelRequests.length, { timeout: 30000 }).toBeGreaterThan(0);
    await expect(page.getByTestId('auto-detection-status')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('auto-detection-status')).toHaveCount(0);
    expect(await readProject(page)).toEqual(before);
    resumeModel();
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { completedDetectionReplies: number }).completedDetectionReplies,
          ),
        { timeout: 120000 },
      )
      .toBe(1);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(await readProject(page)).toEqual(before);
    await expect(page.getByTestId('auto-detection-status')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '실행 취소', exact: true })).toBeDisabled();
    const requestsBeforeRetry = modelRequests.length;
    await materialButton(page, '차콜 스톤').click();
    await expect
      .poll(
        async () =>
          getActiveDesign(await readProject(page))!.scene.surfaces.some(
            (surface) => surface.kind === 'wall' && !!surface.materialVersionId,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    expect(modelRequests).toHaveLength(requestsBeforeRetry);
    expect(
      await page.evaluate(
        () => (window as unknown as { completedDetectionReplies: number }).completedDetectionReplies,
      ),
    ).toBe(1);
    expect(pageErrors).toEqual([]);
    await attachEvidence(testInfo, 'automatic-detection-cancel.json', {
      body: Buffer.from(
        JSON.stringify(
          {
            cancelledBeforeModelLoad: true,
            realLateResultReceived: true,
            lateResultDidNotChangeScene: true,
            retryUsedCachedResult: true,
            modelRequests,
            pageErrors,
          },
          null,
          2,
        ),
      ),
      contentType: 'application/json',
    });
  } finally {
    resumeModel();
  }
});
