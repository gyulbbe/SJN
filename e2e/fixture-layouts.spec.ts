import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { downloadedArtifact } from './helpers/downloaded-artifact';
import {
  addWallNiche,
  editorAction,
  savedProject,
  selectFixture,
  storedProject,
} from '../tests/helpers/editor-actions';
import { getActiveDesign } from '../src/lib/designs';
import type { LayoutItem, LayoutRoom } from '../src/lib/fixture-layout-contract';
import type { ProjectDocument } from '../src/lib/types';

/**
 * 기본 배치 (docs/fixture-layouts-results-20261101.md): an administrator registers what is placed, and
 * anyone places it with one press: one undo step, one save, no other request (d1-query-budget 3절).
 */
const SHOTS = 'test-results/fixture-layouts/screens';
mkdirSync(SHOTS, { recursive: true });
let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(360000);

const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const panel = (page: Page) => page.locator('aside.catalog-panel');
const tab = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true });
const cards = (page: Page) => page.getByTestId('fixture-layout-card');

type Product = { materialId: string; versionId: string; name: string };
let pictures: Buffer | undefined;
async function picture() {
  pictures ??= await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
        <rect x="60" y="40" width="280" height="340" rx="20" fill="#8d8f93"/>
      </svg>`,
    ),
  )
    .png()
    .toBuffer();
  return pictures;
}
let seeded = 0;
/** One shared material, its photos in R2 (as the catalogue's other e2e seeds do). */
async function seedMaterial(
  app: AuthenticatedApp,
  input: {
    name: string;
    category?: string;
    installation?: string;
    widthMm?: number;
    heightMm?: number;
    depthMm?: number;
    directions?: string[];
  },
): Promise<Product> {
  const png = await picture();
  const owner = app.actor.id;
  const tile = input.category === 'tile';
  const directions = tile ? ['타일'] : (input.directions ?? ['정면']);
  const materialId = crypto.randomUUID(),
    versionId = crypto.randomUUID();
  const created = new Date(Date.UTC(2026, 10, 1, 0, 0, seeded++)).toISOString();
  const assets = directions.map(() => crypto.randomUUID());
  const statements = [];
  for (const assetId of assets) {
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
          name: 'p.png',
          kind: tile ? 'texture' : 'product',
          mime: 'image/png',
          width: 400,
          height: 400,
          size: png.length,
          createdAt: created,
        }),
        'hash-' + assetId,
        created,
      ),
    );
  }
  statements.push(
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
        name: input.name,
        brand: '',
        code: '',
        category: input.category ?? 'toilet',
        scope: 'shared',
        description: '',
        color: '',
        finish: '',
        widthMm: input.widthMm ?? 400,
        heightMm: input.heightMm ?? 700,
        depthMm: input.depthMm ?? 600,
        usage: 'both',
        installation: input.installation ?? 'floor',
        textureAssetIds: tile ? assets : [],
        views: tile
          ? []
          : directions.map((direction, index) => ({
              assetId: assets[index],
              direction,
              anchor: { x: 0.5, y: 0.95 },
            })),
        defaultGroutWidth: 2,
        defaultGroutColor: '#d5d1c9',
        defaultPattern: 'grid',
        createdAt: created,
      }),
      input.category ?? 'toilet',
      tile ? 0 : directions.length,
      created,
    ),
    ...assets.map((assetId) =>
      app.env.DB.prepare('INSERT INTO d1_material_assets(version_id,asset_id) VALUES(?,?)').bind(
        versionId,
        assetId,
      ),
    ),
  );
  await app.env.DB.batch(statements);
  return { materialId, versionId, name: input.name };
}
const item = (product: Product, over: Partial<LayoutItem> = {}): LayoutItem => ({
  materialId: product.materialId,
  face: 'floor',
  u: 0.3,
  v: 0.5,
  scale: 1,
  rotation: 0,
  direction: '정면',
  color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
  shadow: { x: 0, y: 0.005, opacity: 0.3, blur: 0.015, scale: 0.7 },
  ...over,
});
async function seedLayout(
  app: AuthenticatedApp,
  name: string,
  order: number,
  items: LayoutItem[],
  room: LayoutRoom,
) {
  await app.env.DB.prepare(
    'INSERT INTO d1_fixture_layouts(id,name,display_order,items_json,room_json,created_by) VALUES(?,?,?,?,?,?)',
  )
    .bind(crypto.randomUUID(), name, order, JSON.stringify(items), JSON.stringify(room), app.actor.id)
    .run();
}
async function openRoom(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await expect(tab(page, '기본 배치')).toBeVisible();
}
const roomOf = (document: ProjectDocument): LayoutRoom => {
  const room = getActiveDesign(document)!.scene.room!;
  return { widthMm: room.widthMm, depthMm: room.depthMm, heightMm: room.heightMm };
};
const sceneOf = (document: ProjectDocument) => getActiveDesign(document)!.scene;
/** What one flow asks the server for, by path; project saves counted apart. */
function watch(page: Page) {
  const requests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) return;
    requests.push(
      path === '/api/d1/projects' && request.postData()?.includes('"save"') ? 'project-save' : path,
    );
  });
  return {
    count: (name: string) => requests.filter((entry) => entry === name).length,
    reset: () => void (requests.length = 0),
    all: () => [...requests],
  };
}
const saved = (page: Page) =>
  expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
/** A press reads first and changes after: the saved project once it holds this many products. */
async function withProducts(page: Page, count: number) {
  await expect
    .poll(async () => sceneOf(await storedProject(page)).fixtures.length, { timeout: 45000 })
    .toBe(count);
  return savedProject(page);
}

test('관리자: 놓은 제품을 등록하고, 덮어쓰고, 관리 화면에서 순서·숨김·삭제한다', async ({ page }) => {
  app = await authenticatedApp(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await seedMaterial(app, { name: '등록 변기', directions: ['정면', '오른쪽'] });
  await seedMaterial(app, {
    name: '등록 세면대',
    category: 'basin',
    installation: 'wall',
    widthMm: 500,
    heightMm: 300,
    depthMm: 400,
  });
  await seedMaterial(app, {
    name: '등록 비데',
    category: 'other',
    widthMm: 300,
    heightMm: 300,
    depthMm: 300,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRoom(page);
  await tab(page, '기본 배치').click();
  // Nothing placed yet: nothing to register.
  await expect(page.getByTestId('register-layout')).toBeDisabled();
  await expect(panel(page).getByText('아직 준비된 기본 배치가 없어요.')).toBeVisible();

  await tab(page, '위생도기').click();
  let count = 0;
  for (const name of ['등록 변기', '등록 세면대']) {
    await panel(page).locator('button.material-tile').filter({ hasText: name }).click();
    await withProducts(page, ++count);
  }
  const placed = sceneOf(await savedProject(page));

  await tab(page, '기본 배치').click();
  await page.getByTestId('register-layout').click();
  const dialog = page.getByRole('dialog', { name: '기본 배치로 등록' });
  await expect(dialog.getByText('제품 2개')).toBeVisible();
  await dialog.getByLabel('기본 배치 이름').fill('변기와 세면대');
  await shot(page, 'register-dialog');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cards(page).first()).toContainText('1번 · 변기와 세면대');
  await expect(cards(page).first().getByTestId('layout-plan').locator('rect')).toHaveCount(2);
  await shot(page, 'cards-admin');

  const rows = () =>
    app!.env.DB.prepare('SELECT name,revision,active,items_json FROM d1_fixture_layouts ORDER BY name').all<{
      name: string;
      revision: number;
      active: number;
      items_json: string;
    }>();
  const first = (await rows()).results[0]!;
  const items = JSON.parse(first.items_json) as LayoutItem[];
  expect(items.map((entry) => [entry.face, entry.u, entry.v])).toEqual(
    placed.fixtures.map((fixture) => [
      fixture.roomPlacement!.face,
      fixture.roomPlacement!.u,
      fixture.roomPlacement!.v,
    ]),
  );
  expect(items[0]!.againstWall).toBe(true);
  expect(first.items_json).not.toContain('occlusion');
  expect(first.items_json).not.toContain('versionId');

  // Overwriting asks once, and takes what is placed now.
  await tab(page, '위생도기').click();
  await panel(page).locator('button.material-tile').filter({ hasText: '등록 비데' }).click();
  await withProducts(page, 3);
  await tab(page, '기본 배치').click();
  await page.getByTestId('register-layout').click();
  await expect(dialog.getByRole('option', { name: '덮어쓰기: 변기와 세면대' })).toBeAttached();
  await dialog.getByLabel('등록할 곳').selectOption({ label: '덮어쓰기: 변기와 세면대' });
  await expect(dialog.getByLabel('기본 배치 이름')).toHaveCount(0);
  let asked = '';
  page.once('dialog', (confirm) => {
    asked = confirm.message();
    void confirm.accept();
  });
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(asked).toContain('덮어쓸까요');
  await expect.poll(async () => (await rows()).results[0]!.revision).toBe(2);
  expect(JSON.parse((await rows()).results[0]!.items_json)).toHaveLength(3);
  // A second layout, for the numbers.
  await page.getByTestId('register-layout').click();
  await dialog.getByLabel('기본 배치 이름').fill('둘째 배치');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(cards(page)).toHaveCount(2);
  await saved(page);

  await page.goto('/admin/catalog');
  const admin = page.getByTestId('fixture-layouts-admin');
  const managed = admin.getByTestId('managed-layout');
  await expect(managed).toHaveCount(2);
  await expect(managed.first().getByLabel('둘째 배치 이름')).toBeVisible();
  await expect(managed.first()).toContainText('1번');
  await expect(managed.nth(1)).toContainText('등록 변기 · 등록 세면대 · 등록 비데');
  await shot(page, 'manage');
  // The order puts it first; a hidden one gives up its number.
  await admin.getByLabel('변기와 세면대 표시 순서').fill('0');
  await admin.getByLabel('변기와 세면대 표시 순서').blur();
  await expect(managed.first().getByLabel('변기와 세면대 이름')).toBeVisible();
  await expect(managed.first()).toContainText('1번');
  await managed.first().getByRole('button', { name: '사용 중 · 숨기기', exact: true }).click();
  await expect(managed.nth(0).getByRole('button', { name: '숨김 · 사용하기', exact: true })).toBeVisible();
  await expect(managed.nth(1)).toContainText('1번');
  const open = await page.evaluate(
    async () => (await (await fetch('/api/catalog/layouts')).json()) as { layouts: { name: string }[] },
  );
  expect(open.layouts.map((layout) => layout.name)).toEqual(['둘째 배치']);
  // Deleting asks; the row goes.
  page.once('dialog', (confirm) => void confirm.accept());
  await managed.nth(1).getByRole('button', { name: '삭제', exact: true }).click();
  await expect(managed).toHaveCount(1);
  expect((await rows()).results.map((row) => row.name)).toEqual(['변기와 세면대']);
  expect(errors).toEqual([]);
});

test('일반 회원: 타일을 고르고 1번을 누르면 제품이 놓이고, 되돌리기 한 번, 저장 한 번, 요청은 정해진 만큼', async ({
  page,
}) => {
  app = await authenticatedApp(page, { admin: false });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const toilet = await seedMaterial(app, { name: '회원 변기', depthMm: 640 });
  const basin = await seedMaterial(app, {
    name: '회원 세면대',
    category: 'basin',
    installation: 'wall',
    widthMm: 500,
    heightMm: 300,
    depthMm: 400,
  });
  const tile = await seedMaterial(app, { name: '회원 타일', category: 'tile', widthMm: 300, heightMm: 300 });
  await page.setViewportSize({ width: 1440, height: 900 });
  const requests = watch(page);
  await openRoom(page);
  // Opening the editor reads no layout.
  expect(requests.count('/api/catalog/layouts')).toBe(0);
  await expect(tab(page, '위생도기')).toHaveCount(0);

  await panel(page).locator('button.material-tile').filter({ hasText: tile.name }).click();
  await saved(page);
  const beforeLayout = await savedProject(page);
  const room = roomOf(beforeLayout);
  await seedLayout(
    app,
    '변기와 세면대',
    0,
    [
      item(toilet, { u: 0.3, v: 0.125, againstWall: true }),
      item(basin, { face: 'back', u: 0.7, v: 0.6, rotation: 2 }),
    ],
    room,
  );
  const tiles = JSON.stringify(sceneOf(beforeLayout).surfaces.map((surface) => surface.materialVersionId));

  requests.reset();
  await tab(page, '기본 배치').click();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('1번 · 변기와 세면대');
  await expect(cards(page).first().locator('img')).toHaveCount(2);
  await shot(page, 'cards-member');
  expect(requests.count('/api/catalog/layouts')).toBe(1);
  // Coming back reads nothing, and the drawer's list is not asked for again either.
  const listed = requests.count('/api/d1/materials');
  await tab(page, '바닥 타일').click();
  await tab(page, '기본 배치').click();
  await expect(cards(page)).toHaveCount(1);
  expect(requests.count('/api/catalog/layouts')).toBe(1);
  expect(requests.count('/api/d1/materials')).toBe(listed);
  await shot(page, 'before-press-2d');

  requests.reset();
  await cards(page).first().click();
  const afterPress = await withProducts(page, 2);
  const fixtures = sceneOf(afterPress).fixtures;
  expect(fixtures.map((fixture) => fixture.materialVersionId)).toEqual([toilet.versionId, basin.versionId]);
  // Against the wall from the start, not only after the next change.
  expect(fixtures[0]!.roomPlacement).toMatchObject({ face: 'floor', u: 0.3, againstWall: true });
  expect(fixtures[0]!.roomPlacement!.v * room.depthMm).toBeCloseTo(320, 3);
  expect(fixtures[1]!.roomPlacement).toMatchObject({ face: 'back', u: 0.7, v: 0.6 });
  expect(fixtures[1]!.rotation).toBe(2);
  expect(JSON.stringify(sceneOf(afterPress).surfaces.map((surface) => surface.materialVersionId))).toBe(
    tiles,
  );
  expect(requests.count('project-save')).toBe(1);
  expect(requests.count('/api/catalog/layouts')).toBe(0);
  // Both new materials in one read.
  expect(requests.count('/api/d1/materials')).toBe(1);
  await shot(page, 'after-press-2d');
  await expect(page.getByTestId('usage-row').filter({ hasText: toilet.name })).toHaveCount(1);
  await expect(page.getByTestId('usage-row').filter({ hasText: basin.name })).toHaveCount(1);

  // Sixty idle seconds ask for nothing new but the role check's period.
  requests.reset();
  await page.waitForTimeout(60000);
  expect(requests.all().filter((path) => path !== '/api/d1/role')).toEqual([]);
  expect(requests.count('/api/d1/role')).toBeLessThanOrEqual(3);

  // One undo takes the whole press back.
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => sceneOf(await storedProject(page)).fixtures.length, { timeout: 30000 })
    .toBe(0);
  await page.keyboard.press('Control+Shift+z');
  await expect
    .poll(async () => sceneOf(await storedProject(page)).fixtures.length, { timeout: 30000 })
    .toBe(2);
  await saved(page);

  // After a reload it is an ordinary product: it can be selected and deleted.
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  const reloaded = sceneOf(await savedProject(page)).fixtures;
  expect(reloaded).toHaveLength(2);
  const revision = (await savedProject(page)).editRevision;
  await selectFixture(page, reloaded[1]!);
  await shot(page, 'selected-member');
  await page.keyboard.press('Delete');
  const removed = await savedProject(page, revision);
  expect(sceneOf(removed).fixtures.map((fixture) => fixture.id)).toEqual([reloaded[0]!.id]);
  expect(errors).toEqual([]);
});

test('다른 크기의 방·벽 홈 3D·둘러보기·다운로드·시안 복제', async ({ page }) => {
  app = await authenticatedApp(page, { admin: false });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const toilet = await seedMaterial(app, { name: '좁은 방 변기', directions: ['정면', '오른쪽'] });
  const basin = await seedMaterial(app, {
    name: '좁은 방 세면대',
    category: 'basin',
    installation: 'wall',
    widthMm: 500,
    heightMm: 300,
    depthMm: 400,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRoom(page);
  const room = roomOf(await savedProject(page));
  const registered = {
    widthMm: room.widthMm * 1.5,
    depthMm: room.depthMm * 1.5,
    heightMm: room.heightMm + 400,
  };
  await seedLayout(
    app,
    '넓은 방에서 등록',
    0,
    [
      // Its back on the left wall by its photo's angle.
      item(toilet, { u: 0.1, v: 0.4, direction: '오른쪽', againstWall: true }),
      item(basin, { face: 'back', u: 0.6, v: 0.6 }),
    ],
    registered,
  );
  await addWallNiche(page);
  await saved(page);
  await tab(page, '기본 배치').click();
  await cards(page).first().click();
  const document = await withProducts(page, 2);
  const fixtures = sceneOf(document).fixtures;
  expect(fixtures).toHaveLength(2);
  const contact = fixtures[0]!.roomPlacement!;
  // 300 mm deep product (half its depth from the left wall), at the share of the wall it was registered at.
  expect(contact.u * room.widthMm).toBeCloseTo(600 / 2, 0);
  expect(contact.v).toBeCloseTo(0.4);
  expect(fixtures[0]!.viewIndex).toBe(1);
  const wall = fixtures[1]!.roomPlacement!;
  expect(wall.u).toBeCloseTo(0.6);
  // The same height above the floor.
  expect((1 - wall.v) * room.heightMm).toBeCloseTo(0.4 * registered.heightMm, 3);
  await expect(page.getByTestId('room-editor-canvas')).toBeVisible();
  await shot(page, 'after-press-3d-narrow-room');

  await (await editorAction(page, '공간 둘러보기')).click();
  const viewer = page.getByRole('dialog', { name: '공간 둘러보기', exact: true });
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const download = page.waitForEvent('download', { timeout: 120000 });
  await page.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  await downloadedArtifact(await download, `${SHOTS}/download.png`);

  // A copied design has its own copies of the products.
  const before = await savedProject(page);
  const designs = getActiveDesign(before)!;
  await page
    .getByRole('button', { name: `${designs.name} 복제`, exact: true })
    .click()
    .catch(async () => {
      await page.getByRole('button', { name: '시안 관리', exact: true }).click();
      await page.getByRole('button', { name: `${designs.name} 복제`, exact: true }).click();
    });
  const copied = await savedProject(page, before.editRevision);
  const active = getActiveDesign(copied)!;
  expect(active.id).not.toBe(designs.id);
  expect(active.scene.fixtures.map((fixture) => fixture.roomPlacement)).toEqual(
    designs.scene.fixtures.map((fixture) => fixture.roomPlacement),
  );
  expect(errors).toEqual([]);
});

test('1번에서 2번으로: 바꾸고 개수를 알리며, 잠근 제품은 남고 피한다', async ({ page }) => {
  app = await authenticatedApp(page, { admin: false });
  const a = await seedMaterial(app, { name: '첫째 변기' });
  const b = await seedMaterial(app, { name: '둘째 변기', widthMm: 500 });
  const c = await seedMaterial(app, {
    name: '둘째 욕조',
    category: 'bath',
    widthMm: 700,
    depthMm: 700,
    heightMm: 500,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRoom(page);
  const room = roomOf(await savedProject(page));
  await seedLayout(app, '하나', 0, [item(a, { u: 0.5, v: 0.5 })], room);
  await seedLayout(app, '둘', 1, [item(b, { u: 0.5, v: 0.5 }), item(c, { u: 0.2, v: 0.8 })], room);
  await tab(page, '기본 배치').click();
  await expect(cards(page)).toHaveCount(2);
  await cards(page).nth(0).click();
  const first = await withProducts(page, 1);
  expect(sceneOf(first).fixtures.map((fixture) => fixture.materialVersionId)).toEqual([a.versionId]);

  // The place taken by a locked product: the new one goes elsewhere.
  await selectFixture(page, sceneOf(first).fixtures[0]!);
  await page.getByRole('button', { name: '배치 잠금', exact: true }).click();
  const locked = await savedProject(page, first.editRevision);
  await tab(page, '기본 배치').click();
  await cards(page).nth(1).click();
  const second = await savedProject(page, locked.editRevision);
  const fixtures = sceneOf(second).fixtures;
  expect(fixtures.map((fixture) => fixture.materialVersionId)).toEqual([
    a.versionId,
    b.versionId,
    c.versionId,
  ]);
  expect(fixtures[0]!.locked).toBe(true);
  expect(fixtures[1]!.roomPlacement!.u === 0.5 && fixtures[1]!.roomPlacement!.v === 0.5).toBe(false);

  // With an unlocked product there, the press says how many it replaced; 1번 replaces the two of 2번.
  await cards(page).nth(0).click();
  await expect(page.getByText('제품 2개를 이 배치로 바꿨어요.')).toBeVisible();
  const third = await savedProject(page, second.editRevision);
  expect(sceneOf(third).fixtures.map((fixture) => fixture.materialVersionId)).toEqual([
    a.versionId,
    a.versionId,
  ]);
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => sceneOf(await storedProject(page)).fixtures.length, { timeout: 30000 })
    .toBe(3);
  await saved(page);
});

test('사진 프로젝트의 Before 편집: 이유를 보이고 눌러도 놓이지 않는다', async ({ page }) => {
  app = await authenticatedApp(page, { admin: false });
  const toilet = await seedMaterial(app, { name: 'Before 변기' });
  await seedLayout(app, 'Before 배치', 0, [item(toilet)], { widthMm: 2400, depthMm: 2400, heightMm: 2400 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
  const photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#b8a58f' } })
    .png()
    .toBuffer();
  await page
    .getByTestId('reconstruction-upload')
    .setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: photo });
  await page.getByRole('button', { name: '분석 없이 직접 구성', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 45000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await saved(page);
  await page.getByRole('button', { name: '기존 공간 수정', exact: true }).click();
  await page.getByRole('button', { name: '등록 자재 보기', exact: true }).click();
  await tab(page, '기본 배치').click();
  await expect(
    panel(page).getByText('Before 편집에서는 기본 배치를 놓을 수 없어요.', { exact: false }),
  ).toBeVisible();
  await expect(cards(page).first()).toBeDisabled();
  await shot(page, 'before-disabled');
});

test.describe('게스트 375px', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });
  test('탭이 넘치지 않고, 누르면 놓이고, 새로고침 뒤에도 남으며, 로그인하면 프로젝트로 저장된다', async ({
    page,
  }) => {
    app = await authenticatedApp(page, { signedIn: false, admin: false });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const toilet = await seedMaterial(app, { name: '게스트 변기' });
    const basin = await seedMaterial(app, {
      name: '게스트 세면대',
      category: 'basin',
      installation: 'wall',
      widthMm: 500,
      heightMm: 300,
      depthMm: 400,
    });
    const draftKey = 'sjn:guest-draft:v1';
    const draft = () =>
      page.evaluate(
        (key) =>
          JSON.parse(sessionStorage.getItem(key)!) as {
            document: ProjectDocument;
            versions: Record<string, { name: string }>;
          },
        draftKey,
      );
    await page.goto('/');
    await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
    await page
      .getByRole('dialog', { name: '공간 크기 설정' })
      .getByRole('button', { name: '공간 만들기', exact: true })
      .click();
    await expect(page).toHaveURL(/\/try$/);
    await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
    await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
    const room = roomOf((await draft()).document);
    await seedLayout(
      app,
      '체험 배치',
      0,
      [item(toilet, { u: 0.3, v: 0.2, againstWall: true }), item(basin, { face: 'back', u: 0.7, v: 0.6 })],
      room,
    );
    const requests = watch(page);
    await page.getByTitle('자재 목록').click();
    await tab(page, '기본 배치').click();
    await expect(tab(page, '위생도기')).toHaveCount(0);
    await expect(cards(page)).toHaveCount(1);
    expect(requests.count('/api/catalog/layouts')).toBe(1);
    const tabs = await page
      .locator('.catalog-tabs')
      .evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
    expect(tabs.scroll).toBeLessThanOrEqual(tabs.client);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await shot(page, 'guest-375-cards');

    await cards(page).first().click();
    // The panel closes on a phone.
    await expect(panel(page)).not.toHaveClass(/open/);
    await expect
      .poll(async () => sceneOf((await draft()).document).fixtures.length, { timeout: 30000 })
      .toBe(2);
    // The draft keeps these materials' public information, nothing else asked of the server.
    expect(requests.count('/api/catalog/placement')).toBe(0);
    expect(
      Object.values((await draft()).versions)
        .map((version) => version.name)
        .sort(),
    ).toEqual([basin.name, toilet.name].sort());
    await shot(page, 'guest-375-placed');

    await page.reload();
    await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
    await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
    expect(sceneOf((await draft()).document).fixtures).toHaveLength(2);
    await expect(page.locator('.editor-error')).toHaveCount(0);

    // Signing in saves the draft as a project with the products.
    const origin = new URL(page.url()).origin;
    await page.route('**/api/auth/sign-in/social', (route) =>
      route.fulfill({ json: { url: 'https://accounts.google.com/o/oauth2/auth?sjn-fixture=1' } }),
    );
    await page.route('https://accounts.google.com/**', async (route) => {
      app!.signIn();
      await route.fulfill({ status: 302, headers: { location: origin + '/try?resume=1' } });
    });
    await page.getByRole('button', { name: '로그인 / 회원가입', exact: true }).first().click();
    await page.getByRole('button', { name: 'Google로 계속하기', exact: true }).click();
    await expect(page).toHaveURL(/\/projects?\//, { timeout: 60000 });
    await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
    const promoted = await storedProject(page);
    expect(sceneOf(promoted).fixtures.map((fixture) => fixture.materialVersionId)).toEqual([
      toilet.versionId,
      basin.versionId,
    ]);
    expect(errors).toEqual([]);
  });
});
