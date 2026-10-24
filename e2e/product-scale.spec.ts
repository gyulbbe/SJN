import { mkdirSync } from 'node:fs';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { getActiveDesign } from '../src/lib/designs';
import { projectRoomPoint, roomFacePoint } from '../src/lib/room-geometry';
import { Vector3 } from 'three';

/**
 * Room products at their registered size (docs/product-scale-results-20261024.md). Two toilets of
 * the same size, 520 mm high, both turned to show their side: a red one with its depth registered
 * and a blue one without. The side photos are as wide as the product is deep (1.26 : 1, like the
 * smart toilet's AI side photo). In the 2D editor the side is the registered height at its floor
 * point; in the space viewer and the export's AI view the two are the same height (the one without a
 * depth was drawn at about 60% before).
 */
const shots = 'test-results/product-scale/e2e';
mkdirSync(shots, { recursive: true });
let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(240000);

/** A plain photo of one colour with a transparent margin, the visible part `w × h`. */
const photo = (w: number, h: number, fill: string) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w + 40}" height="${h + 40}"><rect x="20" y="20" width="${w}" height="${h}" fill="${fill}"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
/** The rows a colour covers in a picture (0–1 down), or null. */
async function rows(image: Buffer, colour: 'red' | 'blue') {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let top = Infinity,
    bottom = -Infinity,
    n = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      const hit = colour === 'red' ? r > 150 && g < 90 && b < 90 : b > 150 && r < 90 && g < 90;
      if (!hit) continue;
      n++;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
    }
  return n < 20
    ? null
    : { top: top / info.height, bottom: bottom / info.height, height: (bottom - top) / info.height };
}
async function register(page: Page, name: string, depth: string, fill: string) {
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill(name);
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('400');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('520');
  await form.getByLabel('깊이 (mm)', { exact: true }).fill(depth);
  await form.getByLabel('+ 제품 이미지 올리기', { exact: true }).setInputFiles([
    // 정면 taken at an angle (wider than the product, 0.94 : 1); 오른쪽 the side (1.26 : 1).
    { name: '0-front.png', mimeType: 'image/png', buffer: await photo(188, 200, fill) },
    { name: '1-side.png', mimeType: 'image/png', buffer: await photo(252, 200, fill) },
  ]);
  await form.getByLabel('촬영 방향 1', { exact: true }).selectOption('정면');
  await form.getByLabel('촬영 방향 2', { exact: true }).selectOption('오른쪽');
  await expect(
    form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }).first(),
  ).toBeVisible();
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
}
/** An older shared toilet with no depth, its 정면 and 오른쪽 photos as `register` makes them. */
async function seedWithoutDepth(name: string, fill: string) {
  const owner = app.actor.id;
  const created = '2026-09-01T00:00:00.000Z';
  const materialId = crypto.randomUUID(),
    versionId = crypto.randomUUID();
  const views = [];
  const statements = [];
  for (const [direction, w] of [
    ['정면', 188],
    ['오른쪽', 252],
  ] as const) {
    const assetId = crypto.randomUUID();
    const png = await photo(w, 200, fill);
    const key = `assets/${owner}/${assetId}/1`;
    await app.env.ASSET_BUCKET.put(key, png, { httpMetadata: { contentType: 'image/png' } });
    statements.push(
      app.env.DB.prepare(
        'INSERT INTO d1_assets(id,owner_id,object_key,metadata_json,content_hash,created_at) VALUES(?,?,?,?,?,?)',
      ).bind(
        assetId,
        owner,
        key,
        JSON.stringify({
          id: assetId,
          ownerId: owner,
          name: direction + '.png',
          kind: 'product',
          mime: 'image/png',
          width: w + 40,
          height: 240,
          size: png.length,
          createdAt: created,
        }),
        'hash-' + assetId,
        created,
      ),
      app.env.DB.prepare('INSERT INTO d1_material_assets(version_id,asset_id) VALUES(?,?)').bind(
        versionId,
        assetId,
      ),
    );
    // The visible part ends 20 px above the bottom: the anchor there, as the form would put it.
    views.push({ assetId, direction, anchor: { x: 0.5, y: 220 / 240 } });
  }
  await app.env.DB.batch([
    app.env.DB.prepare(
      "INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose) VALUES(?,?,'shared',?,?,?,'catalog')",
    ).bind(materialId, owner, versionId, created, created),
    app.env.DB.prepare(
      'INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES(?,?,1,?,?,?,?)',
    ).bind(
      versionId,
      materialId,
      JSON.stringify({
        id: versionId,
        materialId,
        version: 1,
        name,
        brand: '',
        code: 'OLD-1',
        category: 'toilet',
        scope: 'shared',
        description: '',
        color: '',
        finish: '',
        widthMm: 400,
        heightMm: 520,
        depthMm: 0,
        usage: 'both',
        installation: 'floor',
        textureAssetIds: [],
        views,
        defaultGroutWidth: 2,
        defaultGroutColor: '#d5d1c9',
        defaultPattern: 'grid',
        createdAt: created,
      }),
      'toilet',
      views.length,
      created,
    ),
    ...statements,
  ]);
}
const saved = (page: Page) =>
  expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
async function place(page: Page, name: string, u: number) {
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: name }).click();
  await saved(page);
  await page.getByLabel('오른쪽 각도 선택', { exact: true }).click();
  await saved(page);
  for (const [label, value] of [
    ['면 가로 위치 (%)', u],
    ['면 깊이 위치 (%)', 55],
  ] as const) {
    const input = page.getByLabel(label, { exact: true });
    await input.fill(String(value));
    await input.press('Tab');
    await saved(page);
  }
}
async function heights(target: Locator) {
  await target.page().waitForTimeout(800);
  const shot = await target.screenshot();
  return { red: await rows(shot, 'red'), blue: await rows(shot, 'blue'), shot };
}

test('옆모습 변기: 2D 편집은 등록 높이, 공간 둘러보기·내보내기 시점은 깊이가 없어도 같은 크기', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await register(page, '깊이 있는 변기', '700', '#e02020');
  // The form asks for a depth now; a material without one is an older one, put in as it was saved.
  await seedWithoutDepth('깊이 없는 변기', '#2030e0');
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await place(page, '깊이 있는 변기', 30);
  await place(page, '깊이 없는 변기', 70);

  // 2D editor: what shows is the registered 520 mm at its floor point.
  const project = await app.project();
  const scene = getActiveDesign(project)!.scene;
  const aspect = scene.imageWidth / scene.imageHeight;
  const expected = (u: number) => {
    const floor = roomFacePoint(scene.room!, 'floor', u, 0.55);
    return Math.abs(
      projectRoomPoint(scene.room!, floor.clone().add(new Vector3(0, 520, 0)), aspect).y -
        projectRoomPoint(scene.room!, floor, aspect).y,
    );
  };
  const canvas = page.locator('[data-testid="canvas-frame"] canvas');
  const flat = await canvas.evaluate(async (element) => {
    const c = element as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    copy.getContext('2d')!.drawImage(c, 0, 0);
    return copy.toDataURL('image/png');
  });
  const editor = Buffer.from(flat.slice(flat.indexOf(',') + 1), 'base64');
  const [red2d, blue2d] = [await rows(editor, 'red'), await rows(editor, 'blue')];
  expect(red2d, '빨간 변기가 보인다').not.toBeNull();
  expect(blue2d, '파란 변기가 보인다').not.toBeNull();
  expect(Math.abs(red2d!.height / expected(0.3) - 1)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(blue2d!.height / expected(0.7) - 1)).toBeLessThanOrEqual(0.05);
  await page.screenshot({ path: `${shots}/editor.png` });

  // Space viewer, front: the two are the same height (same depth in the room).
  await page.getByRole('button', { name: '공간 둘러보기', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: '공간 둘러보기', exact: true });
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: 'After', exact: true }).click();
  const seen = await heights(viewer.locator('canvas').first());
  expect(seen.red && seen.blue).toBeTruthy();
  expect(Math.abs(seen.blue!.height / seen.red!.height - 1)).toBeLessThanOrEqual(0.05);
  await viewer.screenshot({ path: `${shots}/viewer.png` });
  await viewer.getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();

  // Export: the AI view (the user's picture) the same.
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  const preview = dialog.getByRole('group', { name: 'AI 입력 시점' }).getByTestId('flux-view-preview');
  await expect(preview.locator('canvas')).toHaveCount(1, { timeout: 30000 });
  const sent = await heights(preview);
  expect(sent.red && sent.blue).toBeTruthy();
  expect(Math.abs(sent.blue!.height / sent.red!.height - 1)).toBeLessThanOrEqual(0.05);
  await preview.screenshot({ path: `${shots}/export-view.png` });

  // A phone: the export view shows both whole.
  await page.setViewportSize({ width: 375, height: 812 });
  await preview.scrollIntoViewIfNeeded();
  const phone = await heights(preview);
  expect(phone.red && phone.blue).toBeTruthy();
  expect(Math.abs(phone.blue!.height / phone.red!.height - 1)).toBeLessThanOrEqual(0.05);
  await page.screenshot({ path: `${shots}/export-375.png` });
});
