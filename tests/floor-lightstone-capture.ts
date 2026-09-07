import { getActiveDesign } from '../src/lib/designs';
import { seedTestTiles, uploadBathroomPhoto } from './helpers/catalog-fixtures.mjs';
/** Visual diagnosis only. Run against localhost:3000 with node --experimental-strip-types. */
import { chromium, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { ProjectDocument, Surface } from '../src/lib/types';

const directory = 'test-results/floor-lightstone-qa';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 2048, height: 1536 } });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));

async function stored(page: Page) {
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

async function setDocument(document: ProjectDocument) {
  await page.evaluate(
    (document) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('gongganmiri-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('projects', 'readwrite');
          tx.objectStore('projects').put(document);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    document,
  );
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
}

async function capture(shading: number) {
  const name = `lightstone-shading-${String(shading).replace('.', '')}`;
  await page.screenshot({ path: `${directory}/${name}-ui.png` });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  await (await download).saveAs(`${directory}/${name}-after.png`);
  await expect(page.getByRole('dialog', { name: '이미지 내보내기' })).toHaveCount(0);
  const { width, height } = await sharp(`${directory}/${name}-after.png`).metadata();
  assert.deepEqual([width, height], [1536, 1024]);
  return { shading, image: `${name}-after.png`, width, height };
}

try {
  await mkdir(directory, { recursive: true });
  await page.goto('http://127.0.0.1:3000');
  await seedTestTiles(page);
  await uploadBathroomPhoto(page);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await page.getByRole('button', { name: /라이트 스톤/ }).click();
  await expect
    .poll(async () => getActiveDesign((await stored(page)))!.scene.surfaces.filter((s) => s.materialVersionId).length, {
      timeout: 120000,
    })
    .toBeGreaterThan(0);
  await expect(page.getByTestId('auto-detection-status')).toHaveCount(0);
  const legacy = await stored(page);
  const floor = getActiveDesign(legacy)!.scene.surfaces.find((surface) => surface.kind === 'floor')!;
  const rectangle = (x: number, y: number, right: number, bottom: number) => [
    { x, y },
    { x: right, y },
    { x: right, y: bottom },
    { x, y: bottom },
  ];
  const quad: Surface['quad'] = [
    { x: 0.263328095874329, y: 0.7195682226409042 },
    { x: 0.720575122367539, y: 0.7195682226409042 },
    { x: 0.9197718467804226, y: 0.9957262368267515 },
    { x: 0.11770321779975879, y: 0.9957262368267515 },
  ];
  floor.mask = { polygon: quad, strokes: [] };
  floor.quad = quad;
  floor.tile.shading = 0.25;
  floor.widthMm = 2200;
  floor.heightMm = 2400;
  getActiveDesign(legacy)!.scene.protection = {
    polygon: rectangle(0.58, 0.49, 0.73, 0.84),
    polygons: [rectangle(0.3, 0.45, 0.45, 0.79), rectangle(0.32, 0.15, 0.45, 0.42)],
    strokes: [],
  };
  legacy.name = '라이트 스톤 경계와 명암 시각 진단';
  await setDocument(legacy);
  await page.getByLabel('보호 경계도 함께 다듬기', { exact: true }).check();
  await page.getByRole('button', { name: '바닥 경계 다시 맞추기', exact: true }).click();
  await expect
    .poll(async () => (await stored(page)).editRevision, { timeout: 120000 })
    .toBeGreaterThan(legacy.editRevision);
  await expect(page.getByTestId('auto-detection-status')).toHaveCount(0);
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  const repaired = await stored(page);
  const repairedFloor = getActiveDesign(repaired)!.scene.surfaces.find((surface) => surface.kind === 'floor')!;
  const earlierQA = JSON.parse(await readFile('test-results/floor-refit-qa/floor-refit-report.json', 'utf8'));
  assert.deepEqual(repairedFloor.mask, earlierQA.afterMask);
  const results = [await capture(0.25)];
  const stronger = structuredClone(repaired);
  getActiveDesign(stronger)!.scene.surfaces.find((surface) => surface.kind === 'floor')!.tile.shading = 0.65;
  await setDocument(stronger);
  results.push(await capture(0.65));
  assert.deepEqual(errors, []);
  const report = {
    capturedAt: new Date().toISOString(),
    browser: await browser.version(),
    purpose: 'Visual diagnosis, actual UI PNG export; fresh browser; no user data touched.',
    exactSameMaskAsFloorRefitQA: true,
    material: '라이트 스톤 / TEST-STONE-01 / explicitly prepared personal test fixture',
    comparison:
      'Only floor.tile.shading differs; geometry, protection, texture, grout, color, seed and exposure are identical.',
    settings: {
      ...repairedFloor.tile,
      widthMm: repairedFloor.widthMm,
      heightMm: repairedFloor.heightMm,
      color: repairedFloor.color,
    },
    results,
    errors,
  };
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  await writeFile(`${directory}/repaired-scene.json`, JSON.stringify(getActiveDesign(repaired)!.scene, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
