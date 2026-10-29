import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
import { editorAction, savedProject, storedProject } from '../tests/helpers/editor-actions';
import { getActiveDesign } from '../src/lib/designs';
import type { ProjectDocument } from '../src/lib/types';
import type { WallFeatureV1 } from '../src/lib/wall-features';

/**
 * Drawing wall features on the editor canvas (docs/wall-feature-drawing-results-20261029.md): a drag
 * or a click on a wall opens the card, Enter applies one change (one save), and the first feature
 * turns the editor to 3D, where a feature is picked, typed into, moved and deleted. No project
 * request is made while drawing, typing or moving.
 */
let app: AuthenticatedApp;
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(600000);

const SHOTS = 'test-results/wall-feature-drawing/screens';
const active = (project: ProjectDocument) =>
  project.designs.find((design) => design.id === project.activeDesignId)!;
const features = (project: ProjectDocument) => active(project).scene.wallFeatures ?? [];
const card = (page: Page) => page.getByTestId('wall-feature-card');
const tool = (page: Page) => page.getByTestId('wall-feature-tool');
const note = (page: Page) => page.getByTestId('wall-feature-note');
const stage = (page: Page) => page.getByTestId('room-editor-canvas');
const depth = (page: Page) => card(page).getByLabel('깊이 (mm)', { exact: true });
const bottomOf = (feature: WallFeatureV1, heightMm: number) =>
  feature.kind === 'floor-alcove' ? heightMm : feature.topMm + feature.heightMm;

async function shot(page: Page, name: string, info: TestInfo) {
  await mkdir(SHOTS, { recursive: true });
  const path = `${SHOTS}/${name}.png`;
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

/** Counts project saves and every project request from now on. */
function watchRequests(page: Page) {
  const calls: { path: string; save: boolean }[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    calls.push({
      path: url.pathname,
      save: url.pathname === '/api/d1/projects' && (request.postData() ?? '').includes('"operation":"save"'),
    });
  });
  return {
    saves: () => calls.filter((call) => call.save).length,
    count: () => calls.length,
    /** Project requests since a count (taken before the test's own loads). */
    projectSince: (index: number) =>
      calls
        .slice(index)
        .filter((call) => call.path === '/api/d1/projects')
        .map((call) => call.path + (call.save ? ' (save)' : '')),
  };
}

async function ready(page: Page, structured: boolean) {
  await expect(structured ? stage(page) : page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 45000 });
  await expect(page.locator('.editor-error')).toHaveCount(0);
  if (structured) await expect(stage(page)).toHaveAttribute('data-render-state', 'ready', { timeout: 45000 });
}

/** A default room (2400 mm cube) with a 300 mm wall tile, saved. */
async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await seedTestTiles(page);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정', exact: true })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await ready(page, false);
  const created = await savedProject(page);
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '차콜 스톤' }).click();
  // The tile's own save comes after a debounce: wait for it, so later counts are the tool's alone.
  return savedProject(page, created.editRevision);
}

/** The 2D canvas's back-wall hit path of a scene. */
async function backWall(page: Page, project: ProjectDocument, editing: 'before' | 'after' = 'after') {
  const scene = editing === 'before' ? project.shared.comparison!.before : active(project).scene;
  const back = scene.surfaces.find((s) => s.roomFace === 'back' && !s.region)!;
  return (await page.locator(`[data-testid="editor-canvas"] [data-entity="${back.id}"]`).boundingBox())!;
}

/**
 * Screen pixels of back-wall millimetres in 3D, read off the selected feature's projected outline:
 * its four corners give the wall's perspective map (a homography), so points outside it map too. It
 * is read again after each change because a feature's depth can refit the camera.
 */
async function backWallPixels(page: Page, feature: WallFeatureV1, heightMm: number) {
  const outline = page.getByTestId('wall-feature-selected');
  await expect(outline).toBeVisible();
  const frame = (await stage(page).boundingBox())!;
  const corners = (await outline.getAttribute('points'))!
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number))
    .map(([x, y]) => [frame.x + x * frame.width, frame.y + y * frame.height]);
  // Unit square (feature-relative s, t) to the outline quad: Heckbert's square-to-quad.
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = corners;
  const dx1 = x1 - x2,
    dx2 = x3 - x2,
    dy1 = y1 - y2,
    dy2 = y3 - y2,
    sx = x0 - x1 + x2 - x3,
    sy = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / det,
    h = (dx1 * sy - sx * dy1) / det;
  const a = x1 - x0 + g * x1,
    b = x3 - x0 + h * x3,
    d = y1 - y0 + g * y1,
    e = y3 - y0 + h * y3;
  const bottom = bottomOf(feature, heightMm);
  return (leftMm: number, topMm: number) => {
    const s = (leftMm - feature.leftMm) / feature.widthMm,
      t = (topMm - feature.topMm) / (bottom - feature.topMm);
    const w = g * s + h * t + 1;
    return [(a * s + b * t + x0) / w, (d * s + e * t + y0) / w] as const;
  };
}
const middle = (feature: WallFeatureV1, heightMm: number) =>
  [feature.leftMm + feature.widthMm / 2, (feature.topMm + bottomOf(feature, heightMm)) / 2] as const;

test('2D에서 끌어 첫 벽 홈 → 깊이·Enter → 3D, 클릭 기본 형태·겹침·Esc, 3D 고르기·숫자·이동·삭제, 되돌리기', async ({
  page,
}, info) => {
  app = await authenticatedApp(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const initial = await start(page);
  const requests = watchRequests(page);
  const H = active(initial).scene.room!.heightMm;

  // 1. 2D: a drag on the back wall shows the outline and asks nothing of the server.
  await tool(page).click();
  await expect(tool(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('wall-feature-snap')).toHaveAttribute('aria-pressed', 'true');
  await expect(note(page)).toContainText('벽을 끌거나');
  // The floor explains instead of drawing.
  const floor = active(initial).scene.surfaces.find((s) => s.roomFace === 'floor')!;
  await page.locator(`[data-testid="editor-canvas"] [data-entity="${floor.id}"]`).click();
  await expect(note(page)).toHaveText('왼쪽·정면·오른쪽 벽을 끌어 주세요.');
  await expect(card(page)).toHaveCount(0);
  const wall = await backWall(page, initial);
  let mark = requests.count();
  let saves = requests.saves();
  await page.mouse.move(wall.x + wall.width * 0.15, wall.y + wall.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(wall.x + wall.width * 0.45, wall.y + wall.height * 0.6, { steps: 12 });
  await expect(page.getByTestId('wall-feature-draw')).toBeVisible();
  await shot(page, '2d-drawing', info);
  await page.mouse.up();
  await expect(card(page)).toBeVisible();
  await expect(depth(page)).toBeFocused();
  await expect(depth(page)).toHaveValue('200');
  await expect(card(page)).toContainText('정면 벽 · 벽 홈');
  await expect(card(page).getByLabel('바닥에서 (mm)', { exact: true })).toBeVisible();
  await shot(page, 'card', info);
  // Typing moves only the outline: still no project request, no save.
  await page.keyboard.type('350');
  expect(requests.projectSince(mark)).toEqual([]);
  expect(requests.saves()).toBe(saves);
  await page.keyboard.press('Enter');
  const first = await savedProject(page, initial.editRevision);
  expect(requests.saves() - saves).toBe(1);
  let [niche] = features(first);
  expect(niche).toMatchObject({ kind: 'closed-niche', face: 'back', depthMm: 350, source: 'user' });
  // Kept off the corners and the ceiling (snapping itself is covered by the unit test).
  expect(niche.leftMm).toBeGreaterThanOrEqual(10);
  expect(niche.topMm).toBeGreaterThanOrEqual(10);

  // The first feature turns the editor to 3D; the tool stays on and the feature stays selected.
  await ready(page, true);
  await expect(tool(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(card(page)).toHaveCount(0);
  await shot(page, '3d-result', info);
  let at = await backWallPixels(page, niche, H);

  // 2. A click places the default size: here an alcove centred at 1800 mm, which reaches the floor.
  await page.getByTestId('wall-feature-kind').selectOption('floor-alcove');
  saves = requests.saves();
  await page.mouse.click(...at(1800, 1200));
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText('정면 벽 · 바닥까지 열린 공간');
  // Its top is half the default height (250 mm) above the pressed point.
  expect(
    Math.abs(Number(await card(page).getByLabel('윗면 높이 (mm)', { exact: true }).inputValue()) - 1450),
  ).toBeLessThan(60);
  await expect(card(page).getByLabel('높이 (mm)', { exact: true })).toHaveCount(0);
  // The last applied depth comes first.
  await expect(depth(page)).toHaveValue('350');
  await page.keyboard.press('Enter');
  let saved = await savedProject(page, first.editRevision);
  expect(requests.saves() - saves).toBe(1);
  const alcove = features(saved).find((feature) => feature.kind === 'floor-alcove')!;
  expect(alcove).toMatchObject({ widthMm: 600, depthMm: 350 });
  expect(Math.abs(alcove.leftMm - 1500)).toBeLessThan(60);
  expect(Math.abs(alcove.topMm - 950)).toBeLessThan(60);
  expect(Object.hasOwn(alcove, 'heightMm')).toBe(false);
  await ready(page, true);
  at = await backWallPixels(page, alcove, H);

  // 3. A drag that overlaps the niche turns red and makes nothing, with the reason.
  await page.getByTestId('wall-feature-kind').selectOption('closed-niche');
  saves = requests.saves();
  await page.mouse.move(...at(120, Math.max(40, niche.topMm - 120)));
  await page.mouse.down();
  await page.mouse.move(...at(...middle(niche, H)), { steps: 10 });
  await expect(page.getByTestId('wall-feature-draw')).toHaveAttribute('data-warn', 'true');
  await shot(page, 'overlap', info);
  await page.mouse.up();
  await expect(note(page)).toContainText('겹치거나 맞닿는');
  await expect(card(page)).toHaveCount(0);

  // 4. Esc on the card changes nothing.
  await page.mouse.click(...at(1800, 300));
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(tool(page)).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(2500);
  expect(requests.saves()).toBe(saves);
  expect(features(await storedProject(page))).toEqual(features(saved));

  // 5. A click on the niche picks it and opens its card; a new depth is one save.
  await page.mouse.click(...at(...middle(niche, H)));
  await expect(card(page)).toBeVisible();
  await expect(depth(page)).toHaveValue('350');
  await depth(page).fill('420');
  await card(page).getByRole('button', { name: '적용', exact: true }).click();
  saved = await savedProject(page, saved.editRevision);
  expect(requests.saves() - saves).toBe(1);
  niche = features(saved).find((feature) => feature.id === niche.id)!;
  expect(niche.depthMm).toBe(420);
  await ready(page, true);
  await shot(page, '3d-selected', info);
  at = await backWallPixels(page, niche, H);

  // 6. Dragging the niche moves its outline only, then one save.
  saves = requests.saves();
  mark = requests.count();
  const [x, y] = at(...middle(niche, H));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(...at(middle(niche, H)[0] + 200, middle(niche, H)[1] + 100), { steps: 10 });
  await expect(page.getByTestId('wall-feature-move')).toBeVisible();
  await shot(page, '3d-moving', info);
  expect(requests.projectSince(mark)).toEqual([]);
  await page.mouse.up();
  saved = await savedProject(page, saved.editRevision);
  expect(requests.saves() - saves).toBe(1);
  const moved = features(saved).find((feature) => feature.id === niche.id)!;
  expect(moved.leftMm - niche.leftMm).toBeGreaterThan(150);
  expect(moved.topMm - niche.topMm).toBeGreaterThan(50);
  expect({ ...moved, leftMm: 0, topMm: 0 }).toEqual({ ...niche, leftMm: 0, topMm: 0 });
  niche = moved;
  await ready(page, true);
  at = await backWallPixels(page, niche, H);

  // 7. The alcove's card deletes it (one save); Delete removes the niche, the last one: back to 2D.
  saves = requests.saves();
  await page.mouse.click(...at(...middle(alcove, H)));
  await expect(card(page).getByRole('button', { name: '삭제', exact: true })).toBeVisible();
  await card(page).getByRole('button', { name: '삭제', exact: true }).click();
  saved = await savedProject(page, saved.editRevision);
  expect(features(saved).map((feature) => feature.id)).toEqual([niche.id]);
  expect(requests.saves() - saves).toBe(1);
  await ready(page, true);
  await expect(tool(page)).toHaveAttribute('aria-pressed', 'true');
  // Nothing is selected now; the niche (same deepest feature, same camera) is where it was.
  await expect(page.getByTestId('wall-feature-selected')).toHaveCount(0);
  await page.mouse.click(...at(...middle(niche, H)));
  await expect(card(page)).toBeVisible();
  await expect(depth(page)).toHaveValue('420');
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId('wall-feature-selected')).toBeVisible();
  await page.keyboard.press('Delete');
  saved = await savedProject(page, saved.editRevision);
  expect(Object.hasOwn(active(saved).scene, 'wallFeatures')).toBe(false);
  expect(requests.saves() - saves).toBe(2);
  await ready(page, false);
  await shot(page, '2d-after-delete', info);

  // 8. Ctrl+Z brings it back in 3D, Ctrl+Y takes it away again, Ctrl+Z once more.
  await page.keyboard.press('Control+z');
  saved = await savedProject(page, saved.editRevision);
  expect(features(saved)).toEqual([niche]);
  await ready(page, true);
  await page.keyboard.press('Control+y');
  saved = await savedProject(page, saved.editRevision);
  expect(Object.hasOwn(active(saved).scene, 'wallFeatures')).toBe(false);
  await ready(page, false);
  await page.keyboard.press('Control+z');
  saved = await savedProject(page, saved.editRevision);
  await ready(page, true);

  // Stays after a reload; the room viewer shows it from the same stored scene.
  await page.reload();
  await ready(page, true);
  expect(features(await storedProject(page))).toEqual([niche]);
  await (await editorAction(page, '공간 둘러보기')).click();
  const viewer = page.getByRole('dialog', { name: '공간 둘러보기', exact: true });
  await expect(page.getByTestId('room-view-viewport')).toHaveAttribute('aria-busy', 'false', {
    timeout: 45000,
  });
  await expect(viewer.getByRole('alert')).toHaveCount(0);
  await viewer.getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  expect(errors).toEqual([]);
});

test('Before(공통 Before) 편집에서 그린 벽 구조는 Before에만 들어간다', async ({ page }, info) => {
  app = await authenticatedApp(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const initial = await start(page);
  // A comparison (as a photo reconstruction leaves) so the Before scene can be edited.
  const baseline = initial.shared.baseline;
  await page.evaluate(
    async (document) => {
      const response = await fetch('/api/d1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'save',
          document,
          expectedStorageRevision: document.storageRevision,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
    },
    {
      ...initial,
      shared: {
        ...initial.shared,
        comparison: {
          before: structuredClone(baseline),
          room: { ...baseline.room! },
          aspect: baseline.imageWidth / baseline.imageHeight,
          cameraVersion: 1,
          referenceOriginalAssetId: baseline.originalAssetId,
          referencePreviewAssetId: baseline.previewAssetId,
          status: 'draft',
        },
      },
    } as ProjectDocument,
  );
  await page.reload();
  await ready(page, false);
  await page.getByRole('button', { name: '기존 공간 수정', exact: true }).click();
  const before = await storedProject(page);
  await tool(page).click();
  const wall = await backWall(page, before, 'before');
  await page.mouse.click(wall.x + wall.width * 0.5, wall.y + wall.height * 0.4);
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Enter');
  const saved = await savedProject(page, before.editRevision);
  expect(saved.shared.comparison!.before.wallFeatures).toHaveLength(1);
  expect(saved.shared.comparison!.before.wallFeatures![0]).toMatchObject({
    kind: 'closed-niche',
    face: 'back',
    widthMm: 600,
    heightMm: 500,
    depthMm: 200,
  });
  expect(Object.hasOwn(getActiveDesign(saved)!.scene, 'wallFeatures')).toBe(false);
  expect(JSON.stringify(saved.shared.baseline)).toBe(JSON.stringify(baseline));
  await ready(page, true);
  await shot(page, 'before-editing', info);
});

test.describe('게스트 휴대폰', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });
  test('375px: 손가락으로 끌어 아래 시트 카드로 적용, 새로고침 뒤에도 남고 가로로 넘치지 않는다', async ({
    page,
  }, info) => {
    app = await authenticatedApp(page, { signedIn: false });
    const draftKey = 'sjn:guest-draft:v1';
    const draft = async (): Promise<ProjectDocument> =>
      page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).document, draftKey);
    await page.goto('/');
    await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
    await page
      .getByRole('dialog', { name: '공간 크기 설정' })
      .getByRole('button', { name: '공간 만들기', exact: true })
      .click();
    await expect(page).toHaveURL(/\/try$/);
    await ready(page, false);
    await tool(page).click();
    const wall = await backWall(page, await draft());
    // One finger draws while the tool is on (touch events through the browser's input pipeline).
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }],
      });
    await touch('touchStart', wall.x + wall.width * 0.2, wall.y + wall.height * 0.25);
    for (let step = 1; step <= 8; step++)
      await touch(
        'touchMove',
        wall.x + wall.width * (0.2 + 0.05 * step),
        wall.y + wall.height * (0.25 + 0.05 * step),
      );
    await touch('touchEnd', 0, 0);
    await expect(card(page)).toBeVisible();
    // A sheet at the foot of the phone, full width.
    const sheet = (await card(page).boundingBox())!;
    expect(sheet.width).toBeGreaterThan(360);
    expect(sheet.y + sheet.height).toBeGreaterThan(805);
    await shot(page, 'guest-375-card', info);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await depth(page).fill('240');
    await card(page).getByRole('button', { name: '적용', exact: true }).tap();
    await expect.poll(async () => getActiveDesign(await draft())!.scene.wallFeatures?.length ?? 0).toBe(1);
    const [made] = getActiveDesign(await draft())!.scene.wallFeatures!;
    expect(made).toMatchObject({ kind: 'closed-niche', face: 'back', depthMm: 240 });
    await ready(page, true);
    await shot(page, 'guest-375-3d', info);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.reload();
    await ready(page, true);
    expect(getActiveDesign(await draft())!.scene.wallFeatures).toEqual([made]);
  });
});
