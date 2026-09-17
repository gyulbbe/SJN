import { downloadedArtifact } from './helpers/downloaded-artifact';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import type { Page as AuthenticatedPage } from '@playwright/test';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { ProjectDocument } from '../src/lib/types';

const authenticatedTests = new WeakMap<AuthenticatedPage, AuthenticatedApp>();
test.beforeEach(async ({ page }) => {
  authenticatedTests.set(page, await authenticatedApp(page));
});
test.afterEach(async ({ page }) => {
  await authenticatedTests.get(page)?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (e) => list.push(e.message));
});
test.afterEach(async ({ page }, info) => {
  await info.attach('browser-errors', {
    body: JSON.stringify(errors.get(page)),
    contentType: 'application/json',
  });
  expect(errors.get(page)).toEqual([]);
});
async function stored(page: Page): Promise<ProjectDocument> {
  return authenticatedTests.get(page)!.project();
}
async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
}
async function ready(page: Page) {
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 180000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 60000 });
  await saved(page);
}
async function start(page: Page, photo?: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '사진으로 비교 공간 만들기', exact: true });
  // Keep the existing model-specific regression on its original browser baseline.
  await dialog.getByRole('radio', { name: /브라우저 기본 분석/ }).check();
  if (photo)
    await dialog
      .getByTestId('reconstruction-upload')
      .setInputFiles({ name: '검증 사진.jpg', mimeType: 'image/jpeg', buffer: await readFile(photo) });
  else {
    const buffer = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#cccccc' } })
      .png()
      .toBuffer();
    await dialog
      .getByTestId('reconstruction-upload')
      .setInputFiles({ name: '수동 구성.png', mimeType: 'image/png', buffer });
  }
  await dialog
    .getByRole('button', { name: photo ? '자동 초안 만들기' : '분석 없이 직접 구성', exact: true })
    .click();
  await ready(page);
  await page.getByRole('button', { name: '기존 공간 수정', exact: true }).click();
  await expect(page.getByText('BEFORE · 기존 공간 재구성 중', { exact: true })).toBeVisible();
}
async function apply(page: Page) {
  const revision = (await stored(page)).editRevision;
  await page.getByRole('button', { name: '재구성 설정 적용', exact: true }).click();
  await expect.poll(async () => (await stored(page)).editRevision).toBeGreaterThan(revision);
  await saved(page);
}
async function add(page: Page, label: string) {
  const revision = (await stored(page)).editRevision;
  const panel = page.getByRole('complementary', { name: 'Before 초안 보정' });
  if (!(await panel.isVisible())) await page.getByRole('button', { name: '초안 보정', exact: true }).click();
  await panel.getByRole('button', { name: label + ' 추가', exact: true }).click();
  await expect.poll(async () => (await stored(page)).editRevision).toBeGreaterThan(revision);
  await expect(page.getByRole('button', { name: '재구성 설정 적용', exact: true })).toBeVisible();
  await saved(page);
}
async function capture(page: Page, info: TestInfo, name: string) {
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(name + '-ui.png'), fullPage: true });
  const data = await page
    .locator('[data-testid="canvas-frame"] canvas')
    .first()
    .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL('image/png'));
  await writeFile(info.outputPath(name + '.png'), Buffer.from(data.split(',')[1], 'base64'));
}
async function configureFour(page: Page, reuseExistingBasin = false) {
  if (reuseExistingBasin) {
    const basin = (await stored(page)).shared.comparison!.before.fixtures.find(
      (f) => f.reconstruction?.kind === 'basin',
    );
    if (basin)
      await page
        .getByRole('complementary', { name: 'Before 초안 보정' })
        .getByRole('button', { name: basin.name, exact: true })
        .first()
        .click();
    else await add(page, '세면대');
  } else await add(page, '세면대');
  await page.getByLabel('세면대 설치 방식', { exact: true }).selectOption('wall');
  await page.getByLabel('재구성 설치 면', { exact: true }).selectOption('left');
  await page.getByLabel('설치면 가로 위치 (%)', { exact: true }).fill('72');
  await page.getByLabel('모형 하단 설치 높이 (mm)', { exact: true }).fill('720');
  await page.getByLabel('재구성 가로 (mm)', { exact: true }).fill('640');
  await page.getByLabel('재구성 높이 (mm)', { exact: true }).fill('320');
  await page.getByLabel('세면볼 형태', { exact: true }).selectOption('rectangular');
  await apply(page);
  await add(page, '유리 파티션');
  await page.getByLabel('재구성 높이 (mm)', { exact: true }).fill('1600');
  // Raised glass now requires an explicit support; floor-mounted glass must stay on the floor.
  await page.getByLabel('유리 지지면', { exact: true }).selectOption('shower-curb');
  await page.getByLabel('유리 지지면 높이 (mm)', { exact: true }).fill('550');
  await page.getByLabel('설치면 가로 위치 (%)', { exact: true }).fill('68');
  await page.getByLabel('바닥 깊이 위치 (%)', { exact: true }).fill('65');
  await page.getByLabel('모형 방향 (°)', { exact: true }).fill('90');
  await page.getByLabel('유리 불투명도 (%)', { exact: true }).fill('18');
  await apply(page);
  const existingMirror = reuseExistingBasin
    ? (await stored(page)).shared.comparison!.before.fixtures.find((f) => f.reconstruction?.kind === 'mirror')
    : undefined;
  if (existingMirror) {
    await page
      .getByRole('complementary', { name: 'Before 초안 보정' })
      .getByRole('button', { name: existingMirror.name, exact: true })
      .first()
      .click();
    await page.getByLabel('재구성 모형 종류', { exact: true }).selectOption('mirrorCabinet');
  } else await add(page, '거울 수납장');
  await page.getByLabel('재구성 설치 면', { exact: true }).selectOption('left');
  await page.getByLabel('설치면 가로 위치 (%)', { exact: true }).fill('65');
  await page.getByLabel('재구성 가로 (mm)', { exact: true }).fill('1000');
  await page.getByLabel('재구성 높이 (mm)', { exact: true }).fill('650');
  await page.getByLabel('모형 하단 설치 높이 (mm)', { exact: true }).fill('1300');
  await page.getByLabel('거울 문 개수', { exact: true }).fill('3');
  await apply(page);
  await add(page, '벽 선반');
  await page.getByLabel('재구성 설치 면', { exact: true }).selectOption('right');
  await page.getByLabel('모형 하단 설치 높이 (mm)', { exact: true }).fill('1800');
  await page.getByLabel('선반 형태', { exact: true }).selectOption('rack');
  await apply(page);
}

test('표준 설비: 벽걸이·기둥·하부장 전환, 유리·거울장·선반 편집, 저장·undo·PNG', async ({ page }, info) => {
  test.setTimeout(240000);
  await start(page);
  await add(page, '세면대');
  await expect(page.getByLabel('세면대 설치 방식', { exact: true })).toHaveValue('wall');
  await expect(page.getByLabel('재구성 높이 (mm)', { exact: true })).toHaveValue('320');
  for (const variant of ['pedestal', 'vanity', 'wall']) {
    await page.getByLabel('세면대 설치 방식', { exact: true }).selectOption(variant);
    await apply(page);
    const f = (await stored(page)).shared.comparison!.before.fixtures[0];
    expect(f.reconstruction?.basinVariant).toBe(variant);
    expect(f.roomPlacement?.face).toBe(variant === 'wall' ? 'back' : 'floor');
  }
  await configureFour(page, true);
  const configured = await stored(page),
    before = configured.shared.comparison!.before;
  expect(before.fixtures).toHaveLength(4);
  expect(before.fixtures.find((f) => f.reconstruction?.kind === 'basin')).toMatchObject({
    roomPlacement: { face: 'left' },
    reconstruction: { version: 2, basinVariant: 'wall', baseHeightMm: 720, heightMm: 320 },
  });
  expect(before.fixtures.find((f) => f.reconstruction?.kind === 'glassPartition')).toMatchObject({
    reconstruction: {
      opacity: 0.18,
      yawDegrees: 90,
      baseHeightMm: 550,
      support: { kind: 'shower-curb', heightMm: 550, provenance: { kind: 'user', height: 'user' } },
    },
    shadow: { opacity: 0 },
  });
  expect(before.fixtures.find((f) => f.reconstruction?.kind === 'mirrorCabinet')).toMatchObject({
    reconstruction: { doorCount: 3, depthMm: 150 },
  });
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await stored(page)).shared.comparison!.before.fixtures.find(
          (f) => f.reconstruction?.kind === 'wallShelf',
        )?.reconstruction?.shelfStyle,
    )
    .toBe('solid');
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await stored(page)).shared.comparison!.before.fixtures.find(
          (f) => f.reconstruction?.kind === 'wallShelf',
        )?.reconstruction?.shelfStyle,
    )
    .toBe('rack');
  await capture(page, info, 'manual-standard-before');
  await page.reload();
  await ready(page);
  expect((await stored(page)).shared.comparison!.before).toEqual(before);
  expect((await stored(page)).designs[0].scene.fixtures).toEqual([]);
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  const exporting = page.getByRole('dialog', { name: '이미지 내보내기', exact: true });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await exporting.getByLabel('이미지 구성').selectOption('compare');
  const pending = page.waitForEvent('download');
  await exporting.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  const download = await pending,
    path = info.outputPath('standard-before-empty-after.png');
  const image = await sharp(await downloadedArtifact(download, path))
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(image.info.width).toBe(4096);
  expect(image.info.height).toBe(Math.round(4096 / (configured.shared.comparison!.aspect * 2)));
  let different = 0;
  const { width, height, channels } = image.info;
  for (let y = 0; y < height; y += 3)
    for (let x = 0; x < width / 2; x += 3) {
      const a = (y * width + x) * channels,
        b = (y * width + x + width / 2) * channels;
      if (Math.max(...[0, 1, 2].map((c) => Math.abs(image.data[a + c] - image.data[b + c]))) > 15)
        different++;
    }
  expect(different).toBeGreaterThan(500);
  expect(before.fixtures.every((f) => !f.reconstruction?.appearanceAssetId)).toBe(true);
});

test('실제 검증 사진의 자동 관측과 사용자 네 설비 보정을 구분한다', async ({ page }, info) => {
  test.skip(!process.env.RECONSTRUCTION_PHOTO, 'RECONSTRUCTION_PHOTO로 로컬 검증 사진을 지정하세요.');
  test.setTimeout(300000);
  const external: string[] = [];
  page.on('request', (request) => {
    if (
      /^https?:/.test(request.url()) &&
      !['localhost', '127.0.0.1'].includes(new URL(request.url()).hostname)
    )
      external.push(request.url());
  });
  await start(page, process.env.RECONSTRUCTION_PHOTO);
  const automatic = await stored(page);
  await info.attach('actual-model-only-result', {
    body: JSON.stringify(automatic.shared.comparison, null, 2),
    contentType: 'application/json',
  });
  await capture(page, info, 'actual-automatic-before');
  const basin = automatic.shared.comparison!.review!.candidates.find(
    (c) => c.kind === 'basin' && c.status === 'placed',
  );
  expect(basin?.source).toBe('deeplab');
  expect(basin?.installation).toMatchObject({ mode: 'wall', basinVariant: 'wall', source: 'inferred' });
  expect(
    automatic.shared.comparison!.before.fixtures.every((f) => !f.reconstruction?.appearanceAssetId),
  ).toBe(true);
  await configureFour(page, true);
  // Explicit user correction of the oversized inferred toilet keeps the comparison legible.
  const toilet = (await stored(page)).shared.comparison!.before.fixtures.find(
    (f) => f.reconstruction?.kind === 'toilet',
  );
  if (toilet) {
    await page
      .getByRole('complementary', { name: 'Before 초안 보정' })
      .getByRole('button', { name: toilet.name, exact: true })
      .first()
      .click();
    await page.getByLabel('재구성 가로 (mm)', { exact: true }).fill('400');
    await page.getByLabel('재구성 높이 (mm)', { exact: true }).fill('750');
    await page.getByLabel('재구성 깊이 (mm)', { exact: true }).fill('680');
    await page.getByLabel('설치면 가로 위치 (%)', { exact: true }).fill('20');
    await page.getByLabel('바닥 깊이 위치 (%)', { exact: true }).fill('78');
    await apply(page);
  }
  const corrected = await stored(page);
  for (const kind of ['basin', 'glassPartition', 'mirrorCabinet', 'wallShelf'])
    expect(corrected.shared.comparison!.before.fixtures.some((f) => f.reconstruction?.kind === kind)).toBe(
      true,
    );
  expect(
    corrected.shared
      .comparison!.before.fixtures.filter((f) =>
        ['glassPartition', 'mirrorCabinet', 'wallShelf'].includes(f.reconstruction!.kind),
      )
      .every((f) => f.reconstruction?.provenance?.kind === 'user'),
  ).toBe(true);
  expect(corrected.shared.comparison!.before.fixtures.some((f) => f.reconstruction?.kind === 'mirror')).toBe(
    false,
  );
  expect(corrected.designs[0].scene.fixtures).toEqual([]);
  expect(corrected.shared.comparison!.referenceOriginalAssetId).toBe(
    automatic.shared.comparison!.referenceOriginalAssetId,
  );
  await capture(page, info, 'actual-user-corrected-before');
  await info.attach('user-corrected-result', {
    body: JSON.stringify(corrected.shared.comparison, null, 2),
    contentType: 'application/json',
  });
  expect(external).toEqual([]);
});

test('이전 사진 거울은 명시 변환만 새 모형으로 바뀌고 크기·원본·실행 취소를 보존한다', async ({
  page,
}, info) => {
  test.setTimeout(150000);
  await start(page);
  await add(page, '거울');
  // Isolated legacy fixture seed; this is compatibility data, never an AI recognition result.
  const legacy = await stored(page);
  const comparison = legacy.shared.comparison!,
    fixture = comparison.before.fixtures[0];
  fixture.reconstruction = {
    version: 1,
    kind: 'mirror',
    color: '#bfc7c8',
    widthMm: 600,
    heightMm: 800,
    depthMm: 25,
    appearanceAssetId: comparison.referencePreviewAssetId,
  };
  fixture.anchor = { x: 0.5, y: 0.5 };
  fixture.roomPlacement!.scale = 0.7;
  fixture.roomPlacement!.u = 0.55;
  fixture.roomPlacement!.v = 0.45;
  legacy.shared.beforeHistory = { past: [], future: [] };
  // Seed a historical snapshot only in this isolated D1/R2 fixture, bypassing current normalization deliberately.
  const app = authenticatedTests.get(page)!;
  const row = await app.env.DB.prepare('SELECT object_key FROM d1_projects WHERE id=?')
    .bind(legacy.id)
    .first<{ object_key: string }>();
  await app.env.ASSET_BUCKET.put(row!.object_key, JSON.stringify(legacy));
  const oldVersion = (await app.versions()).find((version) => version.id === fixture.materialVersionId)!;
  oldVersion.reconstruction = { version: 1, kind: 'mirror' };
  oldVersion.views[0].assetId = fixture.reconstruction!.appearanceAssetId!;
  await app.env.DB.prepare('UPDATE d1_material_versions SET payload_json=? WHERE id=?')
    .bind(JSON.stringify(oldVersion), oldVersion.id)
    .run();
  await page.reload();
  await ready(page);
  await page.getByRole('button', { name: '기존 공간 수정', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Before 초안 보정' })
    .getByRole('button', { name: fixture.name, exact: true })
    .first()
    .click();
  await expect(page.getByRole('button', { name: '표준 모형으로 변환', exact: true })).toBeVisible();
  const readOnlyOld = (await stored(page)).shared.comparison!.before.fixtures[0];
  expect(readOnlyOld.reconstruction?.version).toBe(1);
  expect(readOnlyOld.reconstruction?.appearanceAssetId).toBe(comparison.referencePreviewAssetId);
  await page.getByRole('button', { name: '표준 모형으로 변환', exact: true }).click();
  await expect
    .poll(async () => (await stored(page)).shared.comparison!.before.fixtures[0].reconstruction?.version)
    .toBe(2);
  const converted = (await stored(page)).shared.comparison!.before.fixtures[0];
  expect(converted.reconstruction).toMatchObject({
    sourceMaterialVersionId: fixture.materialVersionId,
    widthMm: 420,
    heightMm: 560,
  });
  expect(converted.reconstruction?.appearanceAssetId).toBeUndefined();
  expect(converted.roomPlacement?.scale).toBe(1);
  expect(converted.reconstruction?.baseHeightMm).toBeCloseTo((1 - 0.45) * 2400 - (800 * 0.7) / 2);
  await capture(page, info, 'legacy-explicit-conversion');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect
    .poll(async () => (await stored(page)).shared.comparison!.before.fixtures[0].reconstruction?.version)
    .toBe(1);
  expect((await stored(page)).shared.comparison!.before.fixtures[0]).toEqual(readOnlyOld);
  await page.reload();
  await ready(page);
  const restored = (await stored(page)).shared.comparison!.before.fixtures[0];
  expect(restored.reconstruction).toEqual(readOnlyOld.reconstruction);
  expect(restored.roomPlacement).toEqual(readOnlyOld.roomPlacement);
});
