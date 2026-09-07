import { getActiveDesign } from '../src/lib/designs';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import sharp from 'sharp';
import { calculateMaterialUsage } from '../src/lib/material-usage';
import type { MaterialVersion, ProjectDocument } from '../src/lib/types';

test.use({ channel: 'chrome', actionTimeout: 15000 });
const actorErrors = new WeakMap<Page, { page: string[]; console: string[] }>();
test.beforeEach(({ page }) => {
  const errors = { page: [] as string[], console: [] as string[] };
  actorErrors.set(page, errors);
  page.on('pageerror', (error) => errors.page.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
});
test.afterEach(async ({ page }, testInfo) => {
  const errors = actorErrors.get(page)!;
  await testInfo.attach('browser-errors', {
    body: JSON.stringify(errors, null, 2),
    contentType: 'application/json',
  });
  expect(errors.page, 'Uncaught browser exceptions').toEqual([]);
});
const roomDialog = (page: Page) => page.getByRole('dialog', { name: '공간 크기 설정', exact: true });
const usageRow = (page: Page) => page.getByTestId('usage-row');
const quantity = (page: Page) => usageRow(page).getByLabel('치수 검증 타일 구매 수량', { exact: true });
const price = (page: Page) => usageRow(page).getByLabel('치수 검증 타일 단가 (원)', { exact: true });
const area = (page: Page) => usageRow(page).getByLabel('바닥 면적 (㎡)', { exact: true });
async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
}
async function data(page: Page) {
  const id = page.url().split('/').at(-1)!;
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gongganmiri-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const get = <T>(store: string, id?: string) =>
      new Promise<T>((resolve, reject) => {
        const table = db.transaction(store).objectStore(store),
          request = id ? table.get(id) : table.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const project = await get<ProjectDocument>('projects', id),
      versions = await get<MaterialVersion[]>('versions');
    db.close();
    return { project, versions };
  }, id);
}
async function begin(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await expect(roomDialog(page)).toBeVisible();
  for (const label of ['가로 (m)', '깊이 (m)', '높이 (m)'])
    await expect(roomDialog(page).getByLabel(label, { exact: true })).toHaveValue('2.4');
  await expect(roomDialog(page)).toContainText('5.76 ㎡');
}
async function create(page: Page) {
  await begin(page);
  await roomDialog(page).getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 30000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await saved(page);
}
async function resize(page: Page, width: string, depth?: string, height?: string) {
  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  const modal = roomDialog(page);
  await modal.getByLabel('가로 (m)', { exact: true }).fill(width);
  if (depth) await modal.getByLabel('깊이 (m)', { exact: true }).fill(depth);
  if (height) await modal.getByLabel('높이 (m)', { exact: true }).fill(height);
  await modal.getByRole('button', { name: '크기 적용', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await saved(page);
}
async function registerTile(page: Page) {
  const buffer = await sharp({ create: { width: 160, height: 160, channels: 4, background: '#a1b4a9' } })
    .png()
    .toBuffer();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill('치수 검증 타일');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await form.getByLabel('세로 (mm)', { exact: true }).fill('600');
  await form
    .getByLabel('대표 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'tile.png', mimeType: 'image/png', buffer });
  await expect(form.getByLabel('대표 이미지 변경', { exact: true })).toBeEnabled();
  await form
    .getByLabel('+ 타일 텍스처 올리기', { exact: true })
    .setInputFiles({ name: 'texture.png', mimeType: 'image/png', buffer });
  await expect(form.getByRole('img', { name: '타일 텍스처 1', exact: true })).toBeVisible();
  await form.getByLabel('판매 단위', { exact: true }).selectOption('box');
  await form.getByLabel('기준 단가', { exact: true }).fill('30000');
  await form.getByLabel('박스당 면적 (㎡)', { exact: true }).fill('1.44');
  await form.getByLabel('박스당 수량 (장)', { exact: true }).fill('4');
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '치수 검증 타일' }).click();
  await saved(page);
}
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}

test('기본 2.4m 공간 → 자재 수량·단가 → 크기 변경·전체 복원·재진입·프로젝트 복제', async ({
  page,
}, testInfo) => {
  test.setTimeout(150000);
  await create(page);
  await registerTile(page);
  const initial = (await data(page)).project;
  expect(getActiveDesign(initial)!.scene.room).toMatchObject({
    widthMm: 2400,
    depthMm: 2400,
    heightMm: 2400,
  });
  expect(getActiveDesign(initial)!.scene.surfaces).toHaveLength(4);
  expect(
    getActiveDesign(initial)!.scene.surfaces.every(
      (surface) => surface.geometryMode === 'room' && surface.roomFace,
    ),
  ).toBe(true);
  await expect(usageRow(page)).toHaveCount(1);
  await expect(area(page)).toHaveValue('5.76');
  await expect(quantity(page)).toHaveValue('4');
  await expect(usageRow(page)).toContainText('공간 치수로 계산');
  await expect(page.getByRole('button', { name: '견적서', exact: true })).toHaveCount(0);
  page.once('dialog', (dialog) => dialog.accept());
  await usageRow(page).getByLabel('치수 검증 타일 판매 단위', { exact: true }).selectOption('piece');
  await expect(quantity(page)).toHaveValue('16');
  page.once('dialog', (dialog) => dialog.accept());
  await usageRow(page).getByLabel('치수 검증 타일 판매 단위', { exact: true }).selectOption('box');
  await price(page).fill('25000');
  await price(page).press('Enter');
  await saved(page);
  await resize(page, '3.6');
  const enlarged = (await data(page)).project;
  expect(getActiveDesign(enlarged)!.scene.originalAssetId).not.toBe(
    getActiveDesign(initial)!.scene.originalAssetId,
  );
  expect(
    getActiveDesign(enlarged)!.scene.surfaces.find((surface) => surface.roomFace === 'floor')!.widthMm,
  ).toBe(3600);
  await expect(area(page)).toHaveValue('8.64');
  await expect(quantity(page)).toHaveValue('6');
  await expect(price(page)).toHaveValue('25000');
  await expect(page.getByTestId('usage-total')).toHaveText('150,000원');
  await screenshot(page, testInfo, 'room-usage-enlarged.png');
  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await roomDialog(page).getByRole('button', { name: '크기 변경 직전 전체 복원', exact: true }).click();
  await saved(page);
  expect(getActiveDesign((await data(page)).project)!.scene.originalAssetId).toBe(
    getActiveDesign(initial)!.scene.originalAssetId,
  );
  await expect(quantity(page)).toHaveValue('4');
  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await roomDialog(page).getByRole('button', { name: '전체 다시 실행', exact: true }).click();
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await saved(page);
  await expect(quantity(page)).toHaveValue('6');
  const persisted = await data(page);
  expect(persisted.versions[0].pricing!.unitPrice).toBe(30000);
  const source = getActiveDesign(persisted.project)!;
  expect(Object.values(source.materialUsage!.assignments)[0].pricing.unitPrice).toBe(25000);
  await page.goto('/');
  await page.getByRole('button', { name: /복제$/ }).click();
  const copyLink = page.getByRole('link').filter({ has: page.getByRole('heading', { name: /복사본/ }) });
  await expect(copyLink).toHaveCount(1);
  await copyLink.click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await saved(page);
  const copy = (await data(page)).project,
    copied = getActiveDesign(copy)!;
  expect(copy.id).not.toBe(persisted.project.id);
  expect(copied.scene.room).toEqual(source.scene.room);
  const withoutIds = (scene: typeof source.scene) =>
    scene.surfaces.map(({ id, ...surface }) => {
      void id;
      return surface;
    });
  expect(withoutIds(copied.scene)).toEqual(withoutIds(source.scene));
  expect(copied.scene.surfaces[0].id).not.toBe(source.scene.surfaces[0].id);
  expect(copied.materialUsage!.assignments[copied.scene.surfaces[0].id]).toEqual(
    source.materialUsage!.assignments[source.scene.surfaces[0].id],
  );
  await expect(price(page)).toHaveValue('25000');
  await expect(page.getByTestId('usage-total')).toHaveText('150,000원');
});

test('직접 입력한 면적·수량·단가는 공간 크기를 바꿔도 유지하고 자동 계산으로 복귀한다', async ({ page }) => {
  test.setTimeout(120000);
  await create(page);
  await registerTile(page);
  await area(page).fill('12');
  await area(page).press('Enter');
  await price(page).fill('25000');
  await price(page).press('Enter');
  await expect(quantity(page)).toHaveValue('9');
  await saved(page);
  await resize(page, '3.6', '3', '2.8');
  await expect(area(page)).toHaveValue('12');
  await expect(quantity(page)).toHaveValue('9');
  await expect(price(page)).toHaveValue('25000');
  await usageRow(page).getByRole('button', { name: '바닥 면적 초기화', exact: true }).click();
  await quantity(page).fill('7');
  await quantity(page).press('Enter');
  await saved(page);
  await resize(page, '4.8');
  await expect(quantity(page)).toHaveValue('7');
  await expect(usageRow(page)).toContainText('수동 구매 수량');
  await expect(usageRow(page)).toContainText('자동 계산 10 박스');
  await expect(price(page)).toHaveValue('25000');
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(quantity(page)).toHaveValue('7');
  await usageRow(page)
    .getByRole('button', { name: '치수 검증 타일 구매 수량 자동 계산', exact: true })
    .click();
  await expect(quantity(page)).toHaveValue('10');
  await expect(page.getByTestId('usage-total')).toHaveText('250,000원');
});

test('잘못된 치수·생성 취소·수정 취소·두 번째 탭 읽기 전용', async ({ page, context }, testInfo) => {
  test.setTimeout(120000);
  await begin(page);
  const modal = roomDialog(page);
  await modal.getByLabel('가로 (m)', { exact: true }).fill('0.1');
  await modal.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('0.5–20m');
  await expect(page).toHaveURL(/\/$/);
  await modal.getByRole('button', { name: '취소', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(modal.getByLabel('가로 (m)', { exact: true })).toHaveValue('2.4');
    await screenshot(page, testInfo, 'room-dialog-' + width + '.png');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await modal.getByLabel('가로 (m)', { exact: true }).fill('4');
  await modal.getByLabel('깊이 (m)', { exact: true }).fill('3');
  await modal.getByLabel('높이 (m)', { exact: true }).fill('2.8');
  await modal.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 30000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await saved(page);
  const original = (await data(page)).project;
  expect(getActiveDesign(original)!.scene.room).toMatchObject({
    widthMm: 4000,
    depthMm: 3000,
    heightMm: 2800,
  });
  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  await modal.getByLabel('가로 (m)', { exact: true }).fill('8');
  await modal.getByRole('button', { name: '취소', exact: true }).click();
  expect(getActiveDesign((await data(page)).project)!.scene).toEqual(getActiveDesign(original)!.scene);
  const second = await context.newPage();
  await second.goto(page.url());
  await expect(second.getByTestId('editor-canvas')).toBeVisible();
  await expect(second.getByRole('button', { name: '공간 크기', exact: true })).toBeDisabled();
  await second.close();
});

test('과거에 저장한 수동 면은 크기 변경 확인·취소·적용·실행 취소로 배경과 면적을 보존한다', async ({
  page,
}) => {
  test.setTimeout(120000);
  await create(page);
  await registerTile(page);
  // Test-only persisted legacy edit. The removed manual face-size UI is never used to create it.
  const legacy = (await data(page)).project;
  getActiveDesign(legacy)!.history.past.push({ scene: structuredClone(getActiveDesign(legacy)!.scene) });
  const legacyFloor = getActiveDesign(legacy)!.scene.surfaces.find(
    (surface) => surface.roomFace === 'floor',
  )!;
  legacyFloor.widthMm = 2500;
  legacyFloor.geometryMode = 'manual';
  legacy.editRevision++;
  legacy.storageRevision++;
  const url = page.url();
  await page.goto('/');
  await page.evaluate(
    (project) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('gongganmiri-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            transaction = db.transaction('projects', 'readwrite');
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error);
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error);
          };
          transaction.objectStore('projects').put(project);
        };
      }),
    legacy,
  );
  await page.goto(url);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await saved(page);
  const manuallyEdited = (await data(page)).project;
  expect(
    getActiveDesign(manuallyEdited)!.scene.surfaces.find((surface) => surface.roomFace === 'floor')!
      .geometryMode,
  ).toBe('manual');
  await expect(area(page)).toHaveValue('');
  await expect(usageRow(page)).toContainText('면적 확인');
  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  const modal = roomDialog(page);
  await modal.getByLabel('가로 (m)', { exact: true }).fill('3.6');
  await expect(modal.getByLabel('수동 보정 초기화 확인', { exact: true })).toBeVisible();
  await modal.getByRole('button', { name: '크기 적용', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('초기화되는 수동 보정을 확인');
  await modal.getByRole('button', { name: '취소', exact: true }).click();
  expect(getActiveDesign((await data(page)).project)!.scene).toEqual(getActiveDesign(manuallyEdited)!.scene);
  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  await modal.getByLabel('가로 (m)', { exact: true }).fill('3.6');
  await modal.getByLabel('수동 보정 초기화 확인', { exact: true }).check();
  await modal.getByRole('button', { name: '크기 적용', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await saved(page);
  const reset = (await data(page)).project;
  expect(
    getActiveDesign(reset)!.scene.surfaces.find((surface) => surface.roomFace === 'floor')!.geometryMode,
  ).toBe('room');
  await expect(area(page)).toHaveValue('8.64');
  await page.getByRole('button', { name: '공간 크기', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await roomDialog(page).getByRole('button', { name: '크기 변경 직전 전체 복원', exact: true }).click();
  await saved(page);
  const restored = (await data(page)).project;
  expect(getActiveDesign(restored)!.scene).toEqual(getActiveDesign(manuallyEdited)!.scene);
  const final = await data(page),
    design = getActiveDesign(final.project)!;
  const result = calculateMaterialUsage(
    design.scene,
    Object.fromEntries(final.versions.map((version) => [version.id, version])),
    design.materialUsage,
  );
  expect(result.rows[0].areaM2).toBeNull();
  await expect(area(page)).toHaveValue('');
});
