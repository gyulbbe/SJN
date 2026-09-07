import { getActiveDesign } from '../src/lib/designs';
import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
import type { MaterialVersion, ProjectDocument, Point, Quad } from '../src/lib/types';

test.use({ channel: 'chrome', actionTimeout: 15000 });
const faults = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  faults.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(async ({ page }, info) => {
  await info.attach('uncaught-browser-errors', {
    body: JSON.stringify(faults.get(page)),
    contentType: 'application/json',
  });
  expect(faults.get(page)).toEqual([]);
});
const dialog = (page: Page) => page.getByRole('dialog', { name: '사진으로 비교 공간 만들기', exact: true });
async function stored(page: Page, explicitId?: string) {
  const id = explicitId || page.url().split('/').at(-1)!;
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gongganmiri-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = <T>(store: string, key?: string) =>
      new Promise<T>((resolve, reject) => {
        const table = database.transaction(store).objectStore(store);
        const request = key ? table.get(key) : table.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const project = await read<ProjectDocument>('projects', id);
    const projects = await read<ProjectDocument[]>('projects');
    const versions = await read<MaterialVersion[]>('versions');
    const assetIds = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = database.transaction('assets').objectStore('assets').getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return { project, projects, versions, assetIds };
  }, id);
}
async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
}
async function ready(page: Page) {
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 45000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await saved(page);
}
async function begin(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}
async function uploadReference(page: Page) {
  const buffer = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#b8a58f' } })
    .png()
    .toBuffer();
  await dialog(page)
    .getByTestId('reconstruction-upload')
    .setInputFiles({ name: '기존 공간.png', mimeType: 'image/png', buffer });
}
async function afterEditing(page: Page) {
  await expect(page.getByRole('button', { name: 'After', exact: true })).toHaveClass('active');
  await expect(page.getByText('AFTER · 실시간 미리보기', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '내보내기', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '견적서', exact: true })).toHaveCount(0);
}
async function beforeEditing(page: Page) {
  await page.getByRole('button', { name: '기존 공간 수정', exact: true }).click();
  await expect(page.getByText('BEFORE · 기존 공간 재구성 중', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'After', exact: true })).toBeEnabled();
}
async function manual(page: Page) {
  await begin(page);
  await uploadReference(page);
  await dialog(page).getByRole('button', { name: '분석 없이 직접 구성', exact: true }).click();
  await ready(page);
  await afterEditing(page);
  await beforeEditing(page);
}
async function pixels(page: Page, point: Point) {
  return page.locator('[data-testid="canvas-frame"] canvas').evaluate((element, point) => {
    const source = element as HTMLCanvasElement;
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(source, 0, 0);
    return [
      ...context.getImageData(Math.floor(point.x * canvas.width), Math.floor(point.y * canvas.height), 1, 1)
        .data,
    ];
  }, point);
}
function floorPoint(quad: Quad): Point {
  const u = 0.18,
    v = 0.82;
  return {
    x: (1 - v) * ((1 - u) * quad[0].x + u * quad[1].x) + v * ((1 - u) * quad[3].x + u * quad[2].x),
    y: (1 - v) * ((1 - u) * quad[0].y + u * quad[1].y) + v * ((1 - u) * quad[3].y + u * quad[2].y),
  };
}
const colorDistance = (a: number[], b: number[]) =>
  Math.max(...a.slice(0, 3).map((value, index) => Math.abs(value - b[index])));

test('실제 욕실 사진은 재구성 Before를 저장하고 빈 After 편집으로 바로 진입한다', async ({ page }, info) => {
  test.setTimeout(200000);
  const remote: string[] = [],
    modelReads: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (
      /^https?:/.test(url) &&
      new URL(url).hostname !== '127.0.0.1' &&
      new URL(url).hostname !== 'localhost'
    )
      remote.push(url);
    if (url.includes('/models/deeplab-ade20k/')) modelReads.push(url);
  });
  await begin(page);
  await dialog(page).getByTestId('reconstruction-upload').setInputFiles('public/examples/bathroom.png');
  await dialog(page).getByLabel('가로 (m)', { exact: true }).fill('3.2');
  await dialog(page).getByLabel('깊이 (m)', { exact: true }).fill('2.6');
  await dialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 160000 });
  await ready(page);
  const { project, versions, assetIds } = await stored(page);
  expect(project.schemaVersion).toBe(3);
  const comparison = project.shared.comparison!;
  expect(comparison.status).toBe('draft');
  expect(['complete', 'partial']).toContain(comparison.review!.analysis);
  expect(comparison.review!.candidates.length).toBeGreaterThan(0);
  expect(comparison.review!.planes.length).toBeGreaterThan(0);
  expect(comparison.review!.warnings.length).toBeGreaterThan(0);
  expect(comparison.before.surfaces.some((surface) => surface.materialVersionId)).toBe(true);
  expect(getActiveDesign(project)!.scene.room).toEqual(comparison.room);
  expect(comparison.before.room).toEqual(comparison.room);
  expect(comparison.room).toMatchObject({ widthMm: 3200, depthMm: 2600, heightMm: 2400 });
  expect(getActiveDesign(project)!.scene.fixtures).toEqual([]);
  expect(getActiveDesign(project)!.scene.surfaces.every((surface) => !surface.materialVersionId)).toBe(true);
  expect(comparison.referenceOriginalAssetId).not.toBe(getActiveDesign(project)!.scene.originalAssetId);
  expect(assetIds).toContain(comparison.referenceOriginalAssetId);
  expect(assetIds).toContain(comparison.referencePreviewAssetId);
  const versionIds = new Set(versions.map((version) => version.id));
  for (const fixture of comparison.before.fixtures) {
    expect(fixture.reconstruction).toBeDefined();
    expect(fixture.roomPlacement).toBeDefined();
    expect(versionIds.has(fixture.materialVersionId)).toBe(true);
  }
  await afterEditing(page);
  await expect(page.getByRole('button', { name: 'Before', exact: true })).toBeEnabled();
  const firstRevision = project.editRevision;
  const sample = floorPoint(
    getActiveDesign(project)!.scene.surfaces.find((surface) => surface.roomFace === 'floor')!.quad,
  );
  const blankAfter = await pixels(page, sample);
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect.poll(async () => colorDistance(await pixels(page, sample), blankAfter)).toBeGreaterThan(8);
  await page.getByRole('button', { name: 'After', exact: true }).click();
  await expect.poll(async () => colorDistance(await pixels(page, sample), blankAfter)).toBeLessThanOrEqual(2);
  expect((await stored(page)).project.editRevision).toBe(firstRevision);
  await page.screenshot({ path: info.outputPath('actual-photo-default-empty-after.png'), fullPage: true });
  await beforeEditing(page);
  await page.screenshot({ path: info.outputPath('actual-photo-before-draft.png'), fullPage: true });
  await info.attach('detected-review', {
    body: JSON.stringify(comparison.review, null, 2),
    contentType: 'application/json',
  });
  const reviewPanel = page.getByRole('complementary', { name: 'Before 초안 보정' });
  await expect(page.getByTestId('source-plane-canvas')).toHaveCount(0);
  await expect(reviewPanel.getByRole('button', { name: '사진 면 직접 지정', exact: true })).toHaveCount(0);
  const corrected = (await stored(page)).project;
  expect(corrected.shared.comparison!.review!.planes).toEqual(comparison.review!.planes);
  expect(getActiveDesign(corrected)!.scene).toEqual(getActiveDesign(project)!.scene);
  const candidate = corrected.shared.comparison!.review!.candidates.find((item) => item.status === 'placed');
  expect(candidate).toBeDefined();
  const fixture = corrected.shared.comparison!.before.fixtures.find(
    (item) => item.id === candidate!.fixtureId,
  )!;
  await reviewPanel.getByRole('button', { name: fixture.name, exact: true }).first().click();
  const revisedWidth = fixture.reconstruction!.widthMm + 37;
  await page.getByLabel('재구성 가로 (mm)', { exact: true }).fill(String(revisedWidth));
  await page.getByRole('button', { name: '재구성 설정 적용', exact: true }).click();
  await saved(page);
  await expect
    .poll(
      async () =>
        (await stored(page)).project.shared.comparison!.before.fixtures.find(
          (item) => item.id === fixture.id,
        )!.reconstruction!.widthMm,
    )
    .toBe(revisedWidth);
  const beforeDelete = (await stored(page)).project;
  await page.getByRole('button', { name: '제품 삭제', exact: true }).click();
  await saved(page);
  const deleted = (await stored(page)).project;
  expect(deleted.shared.comparison!.before.fixtures.some((item) => item.id === fixture.id)).toBe(false);
  expect(deleted.shared.comparison!.before.surfaces).toEqual(beforeDelete.shared.comparison!.before.surfaces);
  expect(getActiveDesign(deleted)!.scene).toEqual(getActiveDesign(project)!.scene);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await saved(page);
  expect((await stored(page)).project.shared.comparison!.before).toEqual(
    beforeDelete.shared.comparison!.before,
  );
  await page.getByRole('button', { name: 'After 꾸미기로 돌아가기', exact: true }).click();
  await saved(page);
  await expect(page.getByRole('button', { name: 'Before', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await page.getByRole('button', { name: 'After', exact: true }).click();
  await page.getByRole('button', { name: '기존 공간 수정', exact: true }).click();
  await expect(page.getByText('BEFORE · 기존 공간 재구성 중', { exact: true })).toBeVisible();
  expect(modelReads.some((url) => url.endsWith('model.json'))).toBe(true);
  expect(modelReads.some((url) => url.includes('group1-shard'))).toBe(true);
  expect(remote).toEqual([]);
});

test('직접 Before 재현 → 도기·타일 보정 → 빈 After·자재 내역 → 공통 크기·실행 취소·복제·비교 출력', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await manual(page);
  const original = (await stored(page)).project;
  expect(original.shared.comparison!.review!.analysis).toBe('manual');
  await page.getByRole('button', { name: '변기 추가', exact: true }).click();
  await saved(page);
  await expect
    .poll(async () => (await stored(page)).project.shared.comparison!.before.fixtures.length)
    .toBe(1);
  if (!(await page.getByRole('complementary', { name: 'Before 초안 보정' }).isVisible()))
    await page.getByRole('button', { name: '초안 보정', exact: true }).click();
  await page.getByRole('button', { name: '거울 추가', exact: true }).click();
  await saved(page);
  await expect
    .poll(async () => (await stored(page)).project.shared.comparison!.before.fixtures.length)
    .toBe(2);
  const beforeFixtures = (await stored(page)).project.shared.comparison!.before.fixtures;
  expect(beforeFixtures.map((fixture) => fixture.reconstruction!.kind).sort()).toEqual(['mirror', 'toilet']);
  expect(
    beforeFixtures.find((fixture) => fixture.reconstruction!.kind === 'mirror')!.projectedQuad,
  ).toHaveLength(4);
  // The reconstruction tile picker opens properties without any manual layer/area controls.
  if (!(await page.getByRole('complementary', { name: 'Before 초안 보정' }).isVisible()))
    await page.getByRole('button', { name: '초안 보정', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Before 초안 보정' })
    .getByRole('button', { name: '바닥', exact: true })
    .click();
  await page.getByLabel('재구성 대표 색상', { exact: true }).fill('#223355');
  await page.getByLabel('재구성 가로 (mm)', { exact: true }).fill('450');
  await page.getByLabel('재구성 높이 (mm)', { exact: true }).fill('450');
  await page.getByLabel('재구성 줄눈 (mm)', { exact: true }).fill('2');
  await page.getByRole('button', { name: '재구성 설정 적용', exact: true }).click();
  await saved(page);
  await expect
    .poll(
      async () =>
        (await stored(page)).project.shared.comparison!.before.surfaces.find((s) => s.roomFace === 'floor')
          ?.materialVersionId,
    )
    .toBeTruthy();
  const configured = (await stored(page)).project;
  const oldFloor = configured.shared.comparison!.before.surfaces.find(
    (surface) => surface.roomFace === 'floor',
  )!;
  expect(oldFloor.materialVersionId).toBeDefined();
  expect(getActiveDesign(configured)!.scene.surfaces.every((surface) => !surface.materialVersionId)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'After', exact: true }).click();
  await afterEditing(page);
  expect((await stored(page)).project.editRevision).toBe(configured.editRevision);
  expect((await stored(page)).project.shared.comparison!.before).toEqual(
    configured.shared.comparison!.before,
  );
  await beforeEditing(page);
  await page.getByRole('button', { name: 'After 꾸미기로 돌아가기', exact: true }).click();
  await saved(page);
  const confirmed = (await stored(page)).project;
  expect(confirmed.shared.comparison!.status).toBe('draft');
  expect(confirmed.editRevision).toBe(configured.editRevision);
  await afterEditing(page);
  expect(getActiveDesign(confirmed)!.scene.fixtures).toEqual([]);
  await expect(page.getByTestId('usage-row')).toHaveCount(0);
  await expect(page.getByTestId('usage-total')).toHaveText('0원');
  await saved(page);
  const sample = floorPoint(oldFloor.quad);
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect
    .poll(async () => (await pixels(page, sample))[2] - (await pixels(page, sample))[0])
    .toBeGreaterThan(15);
  const beforePixel = await pixels(page, sample);
  await page.getByRole('button', { name: 'After', exact: true }).click();
  await expect.poll(async () => colorDistance(await pixels(page, sample), beforePixel)).toBeGreaterThan(40);
  const afterPixel = await pixels(page, sample);
  const unchangedRevision = (await stored(page)).project.editRevision;
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await page.getByRole('button', { name: 'After', exact: true }).click();
  expect((await stored(page)).project.editRevision).toBe(unchangedRevision);
  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  const resize = page.getByRole('dialog', { name: '공간 크기 설정', exact: true });
  await resize.getByLabel('가로 (m)', { exact: true }).fill('3.6');
  await resize.getByRole('button', { name: '크기 적용', exact: true }).click();
  await expect(resize).toHaveCount(0);
  await saved(page);
  const resized = (await stored(page)).project;
  expect(getActiveDesign(resized)!.scene.room!.widthMm).toBe(3600);
  expect(resized.shared.comparison!.room).toEqual(getActiveDesign(resized)!.scene.room);
  expect(resized.shared.comparison!.before.room).toEqual(getActiveDesign(resized)!.scene.room);
  expect(resized.shared.comparison!.before.originalAssetId).toBe(
    getActiveDesign(resized)!.scene.originalAssetId,
  );
  expect(resized.shared.comparison!.before.fixtures.map((fixture) => fixture.roomPlacement)).toEqual(
    confirmed.shared.comparison!.before.fixtures.map((fixture) => fixture.roomPlacement),
  );
  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await resize.getByRole('button', { name: '크기 변경 직전 전체 복원', exact: true }).click();
  await saved(page);
  const undone = (await stored(page)).project;
  expect(getActiveDesign(undone)!.scene.room).toEqual(getActiveDesign(confirmed)!.scene.room);
  expect(undone.shared.comparison!.before).toEqual(confirmed.shared.comparison!.before);
  await page.reload();
  await ready(page);
  const persisted = (await stored(page)).project;
  expect(persisted.shared.comparison).toEqual(undone.shared.comparison);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: '이미지 내보내기', exact: true });
  await exportDialog.getByLabel('이미지 구성').selectOption('compare');
  const downloading = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  const downloaded = await downloading;
  const outputPath = info.outputPath('before-after-comparison.png');
  await downloaded.saveAs(outputPath);
  const { data: bytes, info: metadata } = await sharp(outputPath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(metadata.width).toBe(4096);
  expect(metadata.height).toBe(Math.round(4096 / (persisted.shared.comparison!.aspect * 2)));
  const imagePixel = (panel: number) => {
    const x = Math.floor(((panel + sample.x) * metadata.width) / 2),
      y = Math.floor(sample.y * metadata.height);
    const offset = (y * metadata.width + x) * metadata.channels;
    return [...bytes.subarray(offset, offset + 3)];
  };
  expect(colorDistance(imagePixel(0), imagePixel(1))).toBeGreaterThan(40);
  expect(colorDistance(imagePixel(0), beforePixel)).toBeLessThan(15);
  expect(colorDistance(imagePixel(1), afterPixel)).toBeLessThan(15);
  await page.screenshot({ path: info.outputPath('configured-before-after.png'), fullPage: true });
  await page.goto('/');
  await page.getByRole('button', { name: /복제$/ }).click();
  await page
    .getByRole('link')
    .filter({ has: page.getByRole('heading', { name: /복사본/ }) })
    .click();
  await ready(page);
  const copy = await stored(page);
  expect(copy.project.id).not.toBe(persisted.id);
  const withoutEntityIds = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (key, item) => (key === 'id' || key === 'fixtureId' ? undefined : item)),
    );
  expect(withoutEntityIds(copy.project.shared.comparison)).toEqual(
    withoutEntityIds(persisted.shared.comparison),
  );
  expect(withoutEntityIds(getActiveDesign(copy.project)!.scene)).toEqual(
    withoutEntityIds(getActiveDesign(persisted)!.scene),
  );
  expect(getActiveDesign(copy.project)!.scene.surfaces[0].id).not.toBe(
    getActiveDesign(persisted)!.scene.surfaces[0].id,
  );
  expect(copy.assetIds).toContain(persisted.shared.comparison!.referenceOriginalAssetId);
});

test('391px 사진 비교 생성: 필수 사진·잘못된 치수·취소·직접 생성', async ({ page }, info) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 391, height: 844 });
  await begin(page);
  await expect(dialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true })).toBeDisabled();
  for (const label of ['가로 (m)', '깊이 (m)', '높이 (m)'])
    await expect(dialog(page).getByLabel(label, { exact: true })).toHaveValue('2.4');
  await uploadReference(page);
  await dialog(page).getByLabel('가로 (m)', { exact: true }).fill('.4');
  await expect(dialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true })).toBeDisabled();
  await expect(dialog(page).getByRole('button', { name: '분석 없이 직접 구성', exact: true })).toBeDisabled();
  await dialog(page).getByLabel('가로 (m)', { exact: true }).fill('3');
  await dialog(page).getByLabel('높이 (m)', { exact: true }).fill('6.1');
  await expect(dialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true })).toBeDisabled();
  await dialog(page).getByLabel('높이 (m)', { exact: true }).fill('2.7');
  const box = await dialog(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(392);
  await page.screenshot({ path: info.outputPath('mobile-reconstruction-dialog.png'), fullPage: true });
  await dialog(page).getByRole('button', { name: '취소', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await stored(page, 'none')).projects).toEqual([]);
  await manual(page);
  await expect(page.getByRole('button', { name: 'After 꾸미기로 돌아가기', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'After 꾸미기로 돌아가기', exact: true }).click();
  await saved(page);
  await page.screenshot({ path: info.outputPath('mobile-empty-after.png'), fullPage: true });
  expect(getActiveDesign((await stored(page)).project)!.scene.fixtures).toEqual([]);
});

test('분석 중 취소하면 늦은 모델 결과가 새 프로젝트를 만들거나 덮어쓰지 않음', async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    const original = window.Worker;
    const state = window as unknown as { segmentationResults: number };
    state.segmentationResults = 0;
    window.Worker = class extends original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event) => {
          if (event.data?.type === 'result') state.segmentationResults++;
        });
      }
    };
  });
  let release = () => {},
    requested = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const modelRequested = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route('**/models/deeplab-ade20k/model.json', async (route) => {
    requested();
    await gate;
    await route.continue();
  });
  try {
    await begin(page);
    await dialog(page).getByTestId('reconstruction-upload').setInputFiles('public/examples/bathroom.png');
    await dialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true }).click();
    await modelRequested;
    await expect(dialog(page).getByRole('status')).toBeVisible();
    await dialog(page).getByRole('button', { name: '취소', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect((await stored(page, 'none')).projects).toEqual([]);
    release();
    // A separate manual creation is allowed while the cancelled inference finishes locally.
    await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
    await uploadReference(page);
    await dialog(page).getByLabel('가로 (m)', { exact: true }).fill('4');
    await dialog(page).getByRole('button', { name: '분석 없이 직접 구성', exact: true }).click();
    await ready(page);
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { segmentationResults: number }).segmentationResults),
        { timeout: 90000 },
      )
      .toBe(1);
    await saved(page);
    const result = await stored(page);
    expect(result.projects).toHaveLength(1);
    expect(result.project.shared.comparison!.review!.analysis).toBe('manual');
    expect(getActiveDesign(result.project)!.scene.room!.widthMm).toBe(4000);
    expect(result.project.shared.comparison!.before.fixtures).toEqual([]);
  } finally {
    release();
  }
});

test('기존 비교 프로젝트의 사진 재분석은 After·자재 내역을 보존하고 취소·실행 취소·재진입을 지원한다', async ({
  page,
}, info) => {
  test.setTimeout(240000);
  await begin(page);
  await dialog(page).getByTestId('reconstruction-upload').setInputFiles('public/examples/bathroom.png');
  await dialog(page).getByRole('button', { name: '분석 없이 직접 구성', exact: true }).click();
  await ready(page);
  await afterEditing(page);
  await beforeEditing(page);
  await page.getByRole('button', { name: '변기 추가', exact: true }).click();
  await expect
    .poll(async () => (await stored(page)).project.shared.comparison!.before.fixtures.length)
    .toBe(1);
  await page.getByRole('button', { name: 'After 꾸미기로 돌아가기', exact: true }).click();
  await saved(page);
  await expect(page.getByTestId('usage-row')).toHaveCount(0);
  await saved(page);
  await page.getByRole('button', { name: '기존 공간 수정', exact: true }).click();
  const original = (await stored(page)).project;
  await page.getByRole('button', { name: '사진 다시 분석', exact: true }).click();
  const rebuild = page.getByRole('dialog', { name: 'Before 사진 다시 분석', exact: true });
  await expect(rebuild).toBeVisible();
  await rebuild.getByRole('button', { name: '취소', exact: true }).click();
  expect((await stored(page)).project.editRevision).toBe(original.editRevision);
  await page.getByRole('button', { name: '사진 다시 분석', exact: true }).click();
  await rebuild.getByRole('button', { name: 'Before 다시 만들기', exact: true }).click();
  await expect(rebuild.getByRole('status')).toBeVisible();
  await expect(rebuild).toHaveCount(0, { timeout: 160000 });
  await saved(page);
  const improved = (await stored(page)).project;
  expect(getActiveDesign(improved)!.scene).toEqual(getActiveDesign(original)!.scene);
  expect(getActiveDesign(improved)!.materialUsage).toEqual(getActiveDesign(original)!.materialUsage);
  expect(improved.shared.comparison!.before.fixtures.length).toBeGreaterThan(1);
  expect(improved.shared.comparison!.referenceOriginalAssetId).toBe(
    original.shared.comparison!.referenceOriginalAssetId,
  );
  await page.screenshot({ path: info.outputPath('reanalyzed-before.png'), fullPage: true });
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await saved(page);
  expect((await stored(page)).project.shared.comparison!.before).toEqual(original.shared.comparison!.before);
  expect(getActiveDesign((await stored(page)).project)!.scene).toEqual(getActiveDesign(original)!.scene);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await saved(page);
  await page.reload();
  await ready(page);
  expect((await stored(page)).project.shared.comparison!.before).toEqual(improved.shared.comparison!.before);
  expect(getActiveDesign((await stored(page)).project)!.materialUsage).toEqual(
    getActiveDesign(original)!.materialUsage,
  );
  await afterEditing(page);
});

test('홈에 사진을 끌어 놓으면 참고 사진이 선택된 비교 생성창에서 시작해 After 편집으로 열린다', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true })).toBeEnabled();
  await page.getByText('기존 사진 위에 직접 편집하기', { exact: true }).click();
  await expect(page.getByRole('button', { name: '사진 위에 직접 편집', exact: true })).toBeVisible();
  const buffer = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#97adaa' } })
    .png()
    .toBuffer();
  const transfer = await page.evaluateHandle((bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], '드롭한 기존 공간.png', { type: 'image/png' }));
    return data;
  }, Array.from(buffer));
  await page.locator('.start-card').dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByText('드롭한 기존 공간.png', { exact: true })).toBeVisible();
  await expect(
    dialog(page).getByRole('img', { name: '재구성할 기존 공간 참고 사진', exact: true }),
  ).toBeVisible();
  expect((await stored(page, 'none')).projects).toEqual([]);
  await dialog(page).getByLabel('가로 (m)', { exact: true }).fill('3');
  await dialog(page).getByRole('button', { name: '분석 없이 직접 구성', exact: true }).click();
  await ready(page);
  await afterEditing(page);
  const created = (await stored(page)).project;
  expect(getActiveDesign(created)!.scene.room!.widthMm).toBe(3000);
  expect(created.shared.comparison!.referenceOriginalAssetId).toBeTruthy();
  expect(getActiveDesign(created)!.scene.fixtures).toEqual([]);
  expect(getActiveDesign(created)!.scene.surfaces.every((surface) => !surface.materialVersionId)).toBe(true);
  await page.reload();
  await ready(page);
  await afterEditing(page);
  expect((await stored(page)).project.shared.comparison).toEqual(created.shared.comparison);
  await page.screenshot({ path: info.outputPath('drop-photo-default-after.png'), fullPage: true });
});

test('사진 없는 기본 공간은 Before와 After 모두 비어 있고 After 자재 변경 뒤에도 Before가 유지된다', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await page.goto('/');
  await seedTestTiles(page);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await ready(page);
  await afterEditing(page);
  const initial = (await stored(page)).project;
  expect(initial.shared.comparison).toBeUndefined();
  expect(getActiveDesign(initial)!.scene.fixtures).toEqual([]);
  expect(getActiveDesign(initial)!.scene.surfaces.every((surface) => !surface.materialVersionId)).toBe(true);
  const sample = floorPoint(
    getActiveDesign(initial)!.scene.surfaces.find((surface) => surface.roomFace === 'floor')!.quad,
  );
  const blank = await pixels(page, sample);
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect.poll(async () => colorDistance(await pixels(page, sample), blank)).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'After', exact: true }).click();
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '차콜 스톤' }).click();
  await saved(page);
  await expect.poll(async () => colorDistance(await pixels(page, sample), blank)).toBeGreaterThan(30);
  const changed = (await stored(page)).project;
  expect(
    getActiveDesign(changed)!.scene.surfaces.find((surface) => surface.roomFace === 'floor')!
      .materialVersionId,
  ).toBeTruthy();
  expect(getActiveDesign(changed)!.scene.originalAssetId).toBe(
    getActiveDesign(initial)!.scene.originalAssetId,
  );
  expect(getActiveDesign(changed)!.scene.previewAssetId).toBe(getActiveDesign(initial)!.scene.previewAssetId);
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect.poll(async () => colorDistance(await pixels(page, sample), blank)).toBeLessThanOrEqual(2);
  expect((await stored(page)).project.editRevision).toBe(changed.editRevision);
  await page.screenshot({ path: info.outputPath('blank-base-before-after-tile-edit.png'), fullPage: true });
  await page.reload();
  await ready(page);
  await afterEditing(page);
  await expect.poll(async () => colorDistance(await pixels(page, sample), blank)).toBeGreaterThan(30);
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect.poll(async () => colorDistance(await pixels(page, sample), blank)).toBeLessThanOrEqual(2);
});
