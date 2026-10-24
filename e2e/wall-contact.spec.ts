import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { getActiveDesign } from '../src/lib/designs';
import { projectRoomPoint, roomFacePoint } from '../src/lib/room-geometry';
import type { RoomFace } from '../src/lib/room-types';
import type { Scene } from '../src/lib/types';

/**
 * A wall product always touches its wall (docs/wall-contact-results-20261024.md). The user's report:
 * a shower set from a 정면 photo only (its visible part the middle 30%), on the right wall of the
 * plain room, stood out into the room in the 2D editor. Now its photo lies on the right wall: every
 * pixel of it is inside the right wall's area of the picture, dragged too (no save while dragging),
 * and after a reload. The properties panel has no "벽에 붙이기" switch for it, a line instead; a
 * product placed on the other kind of face than its installation offers to move there.
 */
const shots = 'test-results/wall-contact/e2e';
mkdirSync(shots, { recursive: true });
let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(300000);

const SHOWER = '벽 접촉 시험 샤워';
const TOILET = '벽 접촉 시험 변기';
/** A magenta shower set on a 1000 × 1000 transparent picture, visible from x 345 to 630 (the user's photo). */
const SHOWER_SVG = `
  <rect x="588" y="40" width="42" height="190" rx="18" fill="#e020c0"/>
  <rect x="600" y="230" width="18" height="470" fill="#e020c0"/>
  <rect x="345" y="380" width="230" height="60" rx="10" fill="#e020c0"/>
  <path d="M 450 440 C 430 700 380 885 470 885 C 560 885 600 820 609 700" fill="none" stroke="#e020c0" stroke-width="14"/>`;
const TOILET_SVG = `
  <rect x="380" y="180" width="240" height="200" rx="20" fill="#8d8f93"/>
  <rect x="400" y="380" width="200" height="420" fill="#8d8f93"/>`;

async function seed(
  app: AuthenticatedApp,
  item: {
    name: string;
    category: string;
    installation: string;
    size: [number, number, number];
    svg: string;
    anchor: { x: number; y: number };
  },
) {
  const png = await sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000">${item.svg}</svg>`),
  )
    .png()
    .toBuffer();
  const owner = app.actor.id;
  const assetId = crypto.randomUUID(),
    materialId = crypto.randomUUID(),
    versionId = crypto.randomUUID();
  const key = `assets/${owner}/${assetId}/1`;
  const created = '2026-10-24T00:00:00.000Z';
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
        name: item.name + '.png',
        kind: 'product',
        mime: 'image/png',
        width: 1000,
        height: 1000,
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
        name: item.name,
        brand: '',
        code: 'WALL-' + item.category,
        category: item.category,
        scope: 'shared',
        description: '',
        color: '',
        finish: '',
        widthMm: item.size[0],
        heightMm: item.size[1],
        depthMm: item.size[2],
        usage: 'both',
        installation: item.installation,
        textureAssetIds: [],
        views: [{ assetId, direction: '정면', anchor: item.anchor }],
        defaultGroutWidth: 2,
        defaultGroutColor: '#d5d1c9',
        defaultPattern: 'grid',
        createdAt: created,
      }),
      item.category,
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

/** The magenta pixels of the 2D editor's picture (0–1 of the picture), from its canvas. */
async function magenta(page: Page) {
  const canvas = page.locator('[data-testid="canvas-frame"] canvas');
  const url = await canvas.evaluate(async (element) => {
    const c = element as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    copy.getContext('2d')!.drawImage(c, 0, 0);
    return copy.toDataURL('image/png');
  });
  const { data, info } = await sharp(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const points: { x: number; y: number }[] = [];
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] > 150 && data[i + 1] < 90 && data[i + 2] > 140) points.push({ x, y });
    }
  return { points, width: info.width, height: info.height };
}
/** How many of `points` lie outside the face's area of the picture by more than `slack` pixels. */
function outside(scene: Scene, face: RoomFace, found: Awaited<ReturnType<typeof magenta>>, slack = 3) {
  const aspect = scene.imageWidth / scene.imageHeight;
  const quad = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([u, v]) => {
    const p = projectRoomPoint(scene.room!, roomFacePoint(scene.room!, face, u, v), aspect);
    return { x: p.x * found.width, y: p.y * found.height };
  });
  // Signed distance to each edge of the (convex) quad, inside positive whichever way it winds.
  const area = quad.reduce((sum, a, i) => {
    const b = quad[(i + 1) % 4];
    return sum + a.x * b.y - b.x * a.y;
  }, 0);
  const sign = Math.sign(area);
  return found.points.filter((p) =>
    quad.some((a, i) => {
      const b = quad[(i + 1) % 4];
      const cross = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) * sign;
      return cross / Math.hypot(b.x - a.x, b.y - a.y) < -slack;
    }),
  ).length;
}

test('샤워 설비: 오른쪽 벽면에 붙고, 끌어도·다시 열어도 붙어 있고, 속성 패널은 스위치 대신 한 줄', async ({
  page,
}) => {
  app = await authenticatedApp(page);
  await seed(app, {
    name: SHOWER,
    category: 'shower',
    installation: 'wall',
    size: [330, 1000, 150],
    svg: SHOWER_SVG,
    anchor: { x: 0.62, y: 0.3 },
  });
  await seed(app, {
    name: TOILET,
    category: 'toilet',
    installation: 'floor',
    size: [400, 700, 650],
    svg: TOILET_SVG,
    anchor: { x: 0.5, y: 0.8 },
  });
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
  const projectId = page.url().split('/').at(-1)!;
  const scene = async () => getActiveDesign(await app!.project(projectId))!.scene;
  const shower = async () => (await scene()).fixtures.find((f) => f.name === SHOWER)!;
  const panel = page.locator('aside.catalog-panel');
  await panel.getByRole('button', { name: '위생도기', exact: true }).click();

  // A floor product keeps its switch.
  await panel.locator('button.material-tile').filter({ hasText: TOILET }).click();
  await savedStatus(page);
  await expect(page.getByRole('switch', { name: '벽에 붙이기', exact: true })).toBeVisible();
  await expect(page.getByText('벽에 설치한 제품은 항상 벽에 붙어요.', { exact: true })).toHaveCount(0);

  // The shower goes on a wall (its installation is 벽걸이형: the first wall), touching it.
  await panel.locator('button.material-tile').filter({ hasText: SHOWER }).click();
  await savedStatus(page);
  const first = (await shower()).roomPlacement!.face;
  expect(first).not.toBe('floor');
  await expect(page.getByRole('switch', { name: '벽에 붙이기', exact: true })).toHaveCount(0);
  await expect(page.getByText('벽에 설치한 제품은 항상 벽에 붙어요.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('installation-mismatch')).toHaveCount(0);
  let seen = await magenta(page);
  expect(seen.points.length).toBeGreaterThan(50);
  expect(outside(await scene(), first, seen)).toBe(0);

  // On the right wall (the user's report) its 정면 photo lies on the wall.
  await page.getByLabel('제품 설치 면', { exact: true }).selectOption('right');
  await savedStatus(page);
  await expect.poll(async () => (await shower()).roomPlacement!.face).toBe('right');
  expect((await shower()).projectedQuad).toHaveLength(4);
  await expect(page.getByTestId('facing-info')).toContainText('벽에 붙어 정면 보기에서 비스듬히 보여요');
  seen = await magenta(page);
  expect(seen.points.length).toBeGreaterThan(20);
  expect(outside(await scene(), 'right', seen)).toBe(0);
  await page.screenshot({ path: `${shots}/editor-right-wall.png` });

  // Dragged along the wall (up): it stays on the wall; no save while the pointer moves.
  const placed = await shower();
  const target = page.locator(`polygon[data-entity="${placed.id}"]`);
  const canvas = (await page.getByTestId('editor-canvas').boundingBox())!;
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const before = saves.length;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - canvas.height * 0.08, { steps: 10 });
  await page.waitForTimeout(1500);
  expect(saves.length).toBe(before);
  await page.mouse.up();
  await savedStatus(page);
  const moved = await shower();
  expect(moved.roomPlacement!.face).toBe('right');
  expect(moved.roomPlacement!.v).toBeLessThan(placed.roomPlacement!.v - 0.02);
  expect('againstWall' in moved.roomPlacement!).toBe(false);
  seen = await magenta(page);
  expect(outside(await scene(), 'right', seen)).toBe(0);

  // Reopened: the same.
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await page.waitForTimeout(1000);
  seen = await magenta(page);
  expect(seen.points.length).toBeGreaterThan(20);
  expect(outside(await scene(), 'right', seen)).toBe(0);
  expect((await shower()).roomPlacement).toMatchObject({
    face: 'right',
    u: moved.roomPlacement!.u,
    v: moved.roomPlacement!.v,
  });
  await page.screenshot({ path: `${shots}/editor-reopened.png` });

  // The space viewer (After) from the four sides: the shower shows from each; from the side that
  // looks at the right wall its 정면 is seen whole, wider than from the front.
  await page.getByRole('button', { name: '공간 둘러보기', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: '공간 둘러보기', exact: true });
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: 'After', exact: true }).click();
  const widths: Record<string, number> = {};
  for (const side of ['front', 'right', 'back', 'left']) {
    if (side !== 'front') await viewer.getByRole('button', { name: '오른쪽 90°', exact: true }).click();
    await page.waitForTimeout(1500);
    const shot = await viewer.locator('canvas').first().screenshot();
    await viewer.screenshot({ path: `${shots}/viewer-${side}.png` });
    const { data, info } = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let left = Infinity,
      right = -Infinity;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * info.channels;
        if (data[i] > 150 && data[i + 1] < 90 && data[i + 2] > 140) {
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
      }
    widths[side] = right - left;
  }
  expect(Math.max(widths.right, widths.left)).toBeGreaterThan(widths.front * 2);
  await viewer.getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();

  // Put on the floor, it says its installation is 벽걸이형 and moves back to a wall in one undo step.
  await page.locator(`polygon[data-entity="${placed.id}"]`).click();
  await page.getByLabel('제품 설치 면', { exact: true }).selectOption('floor');
  await savedStatus(page);
  const mismatch = page.getByTestId('installation-mismatch');
  await expect(mismatch).toContainText('설치 방식과 놓인 곳이 달라요. 이 제품은 벽걸이형이에요.');
  await expect(page.getByRole('switch', { name: '벽에 붙이기', exact: true })).toBeVisible();
  await mismatch.getByRole('button', { name: '벽으로 옮기기', exact: true }).click();
  await savedStatus(page);
  await expect.poll(async () => (await shower()).roomPlacement!.face).toBe('back');
  await expect(mismatch).toHaveCount(0);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await savedStatus(page);
  await expect.poll(async () => (await shower()).roomPlacement!.face).toBe('floor');
  await expect(mismatch).toBeVisible();
  await mismatch.getByRole('button', { name: '벽으로 옮기기', exact: true }).click();
  await savedStatus(page);
  await expect.poll(async () => (await shower()).roomPlacement!.face).toBe('back');

  // A phone: the line is there.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(500);
  const note = page.getByText('벽에 설치한 제품은 항상 벽에 붙어요.', { exact: true });
  if (!(await note.isVisible()))
    await page
      .getByRole('button', { name: /^(자재·공간 속성|.* 속성)$/ })
      .last()
      .click();
  await note.scrollIntoViewIfNeeded();
  await expect(note).toBeVisible();
  await page.screenshot({ path: `${shots}/phone-375.png` });
});
