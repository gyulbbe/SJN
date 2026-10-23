import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { getActiveDesign } from '../src/lib/designs';

/**
 * A floor toilet stands on the floor and against the wall behind it (docs/size-order-and-contact-
 * results-20261023.md): placed new it goes against the back wall; the switch "벽에 붙이기" turns it
 * off and on (one undo step each); dragged away it lets go, dragged near the wall it goes back; the
 * place survives a reload; and dragging sends no save until the drop (d1-query-budget 3절).
 */
const shots = 'test-results/fixture-contact/e2e';
mkdirSync(shots, { recursive: true });
let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(300000);

const NAME = '벽 붙이기 시험 변기';
const DEPTH = 640;
/** A grey toilet photo with a transparent margin: what shows ends at 0.882, the anchor is the default 0.97. */
async function seedToilet(app: AuthenticatedApp) {
  const png = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500">
        <rect x="160" y="88" width="180" height="120" rx="14" fill="#8d8f93"/>
        <ellipse cx="250" cy="280" rx="100" ry="70" fill="#8d8f93"/>
        <rect x="190" y="280" width="120" height="161" fill="#8d8f93"/>
      </svg>`,
    ),
  )
    .png()
    .toBuffer();
  const owner = app.actor.id;
  const assetId = crypto.randomUUID(),
    materialId = crypto.randomUUID(),
    versionId = crypto.randomUUID();
  const key = `assets/${owner}/${assetId}/1`;
  const created = '2026-10-23T00:00:00.000Z';
  await app.env.ASSET_BUCKET.put(key, png, { httpMetadata: { contentType: 'image/png' } });
  await app.env.DB.batch([
    app.env.DB.prepare(
      'INSERT INTO d1_assets(id,owner_id,object_key,metadata_json,content_hash,created_at) VALUES(?,?,?,?,?,?)',
    ).bind(
      assetId,
      owner,
      key,
      JSON.stringify({
        id: assetId,
        ownerId: owner,
        name: 'toilet.png',
        kind: 'product',
        mime: 'image/png',
        width: 500,
        height: 500,
        size: png.length,
        createdAt: created,
      }),
      'hash-' + assetId,
      created,
    ),
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
        name: NAME,
        brand: '',
        code: 'WALL-1',
        category: 'toilet',
        scope: 'shared',
        description: '',
        color: '',
        finish: '',
        widthMm: 370,
        heightMm: 660,
        depthMm: DEPTH,
        usage: 'both',
        installation: 'floor',
        textureAssetIds: [],
        views: [{ assetId, direction: '정면', anchor: { x: 0.5, y: 0.97 } }],
        defaultGroutWidth: 2,
        defaultGroutColor: '#d5d1c9',
        defaultPattern: 'grid',
        createdAt: created,
      }),
      'toilet',
      1,
      created,
    ),
    app.env.DB.prepare('INSERT INTO d1_material_assets(version_id,asset_id) VALUES(?,?)').bind(
      versionId,
      assetId,
    ),
  ]);
}
const savedStatus = (page: Page) =>
  expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });

test('변기: 벽에 붙어 놓이고, 스위치·실행 취소·끌기·다시 열기, 끄는 동안 저장 없음', async ({ page }) => {
  app = await authenticatedApp(page);
  await seedToilet(app);
  await page.setViewportSize({ width: 1440, height: 900 });
  const saves: number[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/d1/projects' && request.postData()?.includes('"save"'))
      saves.push(Date.now());
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  const panel = page.locator('aside.catalog-panel');
  await panel.getByRole('button', { name: '위생도기', exact: true }).click();
  await panel.locator('button.material-tile').filter({ hasText: NAME }).click();
  await expect(page.getByLabel('제품 배율', { exact: true })).toBeVisible();
  await savedStatus(page);
  const projectId = page.url().split('/').at(-1)!;
  const fixture = async () => getActiveDesign(await app!.project(projectId))!.scene.fixtures.at(-1)!;
  // Placed new, it goes against the back wall (its 640 mm depth: 320 from the wall in a 2400 room).
  expect((await fixture()).roomPlacement).toMatchObject({
    face: 'floor',
    againstWall: true,
    v: expect.closeTo(320 / 2400, 6),
  });
  const toggle = page.getByRole('switch', { name: '벽에 붙이기', exact: true });
  await expect(toggle).toBeChecked();
  await expect(page.getByText('제품의 뒤가 정면 벽에 닿아 있어요.', { exact: false })).toBeVisible();
  await page.screenshot({ path: `${shots}/editor-placed.png` });
  // Off, then one undo puts it back.
  await toggle.click();
  await savedStatus(page);
  await expect.poll(async () => 'againstWall' in (await fixture()).roomPlacement!).toBe(false);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await savedStatus(page);
  await expect.poll(async () => (await fixture()).roomPlacement!.againstWall).toBe(true);
  await expect(toggle).toBeChecked();
  // The keyboard: Space turns it off and on.
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();
  await savedStatus(page);
  // Dragged well away from the wall it lets go; no save while the pointer moves.
  const placed = await fixture();
  const envelope = page.locator(`rect[data-entity="${placed.id}"]`);
  const canvas = (await page.getByTestId('editor-canvas').boundingBox())!;
  let box = (await envelope.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const before = saves.length;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + canvas.height * 0.18, { steps: 10 });
  await page.waitForTimeout(1500);
  expect(saves.length).toBe(before);
  await page.mouse.up();
  await savedStatus(page);
  const away = await fixture();
  expect('againstWall' in away.roomPlacement!).toBe(false);
  expect(away.roomPlacement!.v).toBeGreaterThan(0.3);
  await expect(toggle).not.toBeChecked();
  // Dragged up to the wall it goes against it again.
  box = (await envelope.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - canvas.height * 0.4, { steps: 10 });
  await page.mouse.up();
  await savedStatus(page);
  await expect
    .poll(async () => (await fixture()).roomPlacement)
    .toMatchObject({ againstWall: true, v: expect.closeTo(320 / 2400, 6) });
  // Reopened: the same.
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await page.locator(`rect[data-entity="${placed.id}"]`).click();
  await expect(page.getByRole('switch', { name: '벽에 붙이기', exact: true })).toBeChecked();
  expect((await fixture()).roomPlacement).toMatchObject({
    againstWall: true,
    v: expect.closeTo(320 / 2400, 6),
  });
  await page.screenshot({ path: `${shots}/editor-reopened.png` });
  // The space viewer from the four sides.
  await page.getByRole('button', { name: '공간 둘러보기', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: '공간 둘러보기', exact: true });
  await expect(viewer).toBeVisible();
  for (const side of ['front', 'right', 'back', 'left']) {
    if (side !== 'front') await viewer.getByRole('button', { name: '오른쪽 90°', exact: true }).click();
    await page.waitForTimeout(1500);
    await viewer.screenshot({ path: `${shots}/viewer-${side}.png` });
  }
  await viewer.getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  // A phone: the switch is there and big enough to press.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(500);
  const properties = page.getByRole('button', { name: /^(자재·공간 속성|.* 속성)$/ }).last();
  if (!(await page.getByRole('switch', { name: '벽에 붙이기', exact: true }).isVisible()))
    await properties.click();
  const phoneSwitch = page.getByRole('switch', { name: '벽에 붙이기', exact: true });
  await phoneSwitch.scrollIntoViewIfNeeded();
  await expect(phoneSwitch).toBeVisible();
  const label = (await page.getByTestId('wall-contact-block').locator('label').boundingBox())!;
  expect(label.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `${shots}/phone-375.png` });
});
