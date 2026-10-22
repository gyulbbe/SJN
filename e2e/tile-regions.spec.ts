import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { editorAction, savedProject, storedProject } from '../tests/helpers/editor-actions';
import type { ProjectDocument, Surface } from '../src/lib/types';

let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(600000);

const BASE = '바탕 시험 타일';
const ACCENT = '부분 시험 타일';
const SHOTS = 'test-results/tile-regions/screens';
const active = (project: ProjectDocument) =>
  project.designs.find((design) => design.id === project.activeDesignId)!;
const regions = (project: ProjectDocument) => active(project).scene.surfaces.filter((s) => s.region);

async function shot(page: Page, name: string, info: TestInfo) {
  await mkdir(SHOTS, { recursive: true });
  const path = `${SHOTS}/${name}.png`;
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

/** Counts the project saves and every other /api/ call from now on. */
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
    all: () => calls.length,
    /** Project requests since a count: the 30 s role check and thumbnail uploads are not the drag's. */
    projectSince: (index: number) =>
      calls
        .slice(index)
        .filter((call) => call.path === '/api/d1/projects')
        .map((call) => call.path + (call.save ? ' (save)' : '')),
  };
}

async function startRoom(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '공간 크기 설정', exact: true });
  await dialog.getByLabel('가로 (m)', { exact: true }).fill('3');
  await dialog.getByLabel('깊이 (m)', { exact: true }).fill('2.4');
  await dialog.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await savedProject(page);
}

/** Registers a plain-coloured 300 mm tile without applying it anywhere. */
async function registerTile(page: Page, name: string, color: string) {
  const buffer = await sharp({ create: { width: 160, height: 160, channels: 4, background: color } })
    .png()
    .toBuffer();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill(name);
  await form.getByLabel('카테고리', { exact: true }).selectOption('tile');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('300');
  await form.getByLabel('세로 (mm)', { exact: true }).fill('300');
  await form
    .getByLabel('+ 타일 텍스처 올리기', { exact: true })
    .setInputFiles({ name: `${name}.png`, mimeType: 'image/png', buffer });
  await expect(form.getByRole('img', { name: '타일 텍스처 1', exact: true })).toBeVisible();
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
}

/** The base tile on the whole floor and every wall. */
async function tileEverything(page: Page) {
  for (const tab of ['바닥 타일', '벽 타일']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await page.getByLabel('타일 적용 위치', { exact: true }).selectOption('all');
    await page.locator('button.material-tile').filter({ hasText: BASE }).click();
    await savedProject(page);
  }
}

/** Mean colour of a canvas around a point given as a fraction of it. */
async function canvasColor(page: Page, selector: string, at: { x: number; y: number }) {
  const url = await page
    .locator(selector)
    .first()
    .evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  const { data, info } = await sharp(Buffer.from(url.split(',')[1], 'base64'))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  let n = 0;
  for (let dy = -4; dy <= 4; dy++)
    for (let dx = -4; dx <= 4; dx++) {
      const x = Math.round(at.x * info.width) + dx,
        y = Math.round(at.y * info.height) + dy;
      const o = (y * info.width + x) * 3;
      for (let c = 0; c < 3; c++) sum[c] += data[o + c];
      n++;
    }
  return sum.map((v) => v / n);
}
const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const centroid = (surface: Surface) => ({
  x: surface.mask.polygon.reduce((sum, p) => sum + p.x, 0) / surface.mask.polygon.length,
  y: surface.mask.polygon.reduce((sum, p) => sum + p.y, 0) / surface.mask.polygon.length,
});

async function properties(page: Page) {
  const field = page.getByTestId('region-fields');
  if (!(await field.isVisible())) await page.getByRole('button', { name: /속성$/ }).last().click();
  await expect(field).toBeVisible();
  return field;
}

test('2D 편집 화면: 끌어서 부분 타일을 만들고 타일·숫자·이동·삭제·되돌리기·다시 열기·사용량·크기 변경 알림', async ({
  page,
}, info) => {
  await startRoom(page);
  await registerTile(page, BASE, '#c9c2b4');
  await registerTile(page, ACCENT, '#1d3557');
  await tileEverything(page);
  const back = active(await storedProject(page)).scene.surfaces.find((s) => s.roomFace === 'back')!;
  const requests = watchRequests(page);

  // Draw on the front wall: a preview while dragging, no request until it is let go.
  await page.getByTestId('region-tool').click();
  await expect(page.getByTestId('region-snap')).toHaveAttribute('aria-pressed', 'true');
  const wall = (await page
    .locator(`[data-testid="editor-canvas"] [data-entity="${back.id}"]`)
    .boundingBox())!;
  await page.mouse.move(wall.x + wall.width * 0.3, wall.y + wall.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(wall.x + wall.width * 0.65, wall.y + wall.height * 0.8, { steps: 12 });
  await expect(page.getByTestId('region-preview')).toBeVisible();
  await shot(page, '2d-drawing', info);
  const duringDrag = requests.projectSince(0);
  await page.mouse.up();
  expect(duringDrag, '끄는 동안 프로젝트 요청 없음').toEqual([]);
  await expect(page.getByLabel('타일 적용 위치', { exact: true })).toHaveValue(/.+/);
  let project = await savedProject(page, 0);
  expect(requests.saves(), '그리기 1회 → 저장 1회').toBe(1);
  const [made] = regions(project);
  expect(made.roomFace).toBe('back');
  expect(made.name).toBe('정면 벽 · 부분 타일 1');
  expect(made.materialVersionId).toBeUndefined();
  await expect(page.getByLabel('타일 적용 위치', { exact: true })).toHaveValue(made.id);

  // The drawer opened on the region: the accent tile goes there only.
  await page.locator('button.material-tile').filter({ hasText: ACCENT }).click();
  project = await savedProject(page, project.editRevision);
  const tiled = regions(project)[0];
  expect(tiled.materialVersionId).toBeTruthy();
  expect(
    active(project)
      .scene.surfaces.filter((s) => !s.region)
      .every((s) => s.materialVersionId !== tiled.materialVersionId),
  ).toBe(true);
  const inside = await canvasColor(page, '[data-testid="canvas-frame"] canvas', centroid(tiled));
  const outside = await canvasColor(page, '[data-testid="canvas-frame"] canvas', {
    x: centroid(tiled).x,
    y: (tiled.mask.polygon[0].y + back.quad[0].y) / 2,
  });
  expect(luminance(inside)).toBeLessThan(90);
  expect(luminance(outside)).toBeGreaterThan(140);
  await page.getByTestId('region-tool').click();
  await page.getByRole('button', { name: '선택 / 이동', exact: true }).click();
  await shot(page, '2d-tiled', info);

  // Numbers: the left end moves the region; one save.
  await page.locator(`[data-testid="editor-canvas"] [data-entity="${tiled.id}"]`).click();
  const fields = await properties(page);
  await expect(fields.getByLabel('왼쪽 끝에서 숫자 입력', { exact: true })).toBeVisible();
  const savesBefore = requests.saves();
  await fields.getByLabel('왼쪽 끝에서 숫자 입력', { exact: true }).fill('400');
  await fields.getByLabel('왼쪽 끝에서 숫자 입력', { exact: true }).press('Enter');
  project = await savedProject(page, project.editRevision);
  expect(regions(project)[0].region!.leftMm).toBe(400);
  expect(requests.saves() - savesBefore).toBe(1);
  await expect(page.getByLabel(`${tiled.name} 면적 (㎡)`)).toHaveCount(1);

  // Moving by dragging: the region follows, saved once when let go.
  const path = page.locator(`[data-testid="editor-canvas"] [data-entity="${tiled.id}"]`);
  const box = (await path.boundingBox())!;
  const movesBefore = requests.saves();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  project = await savedProject(page, project.editRevision);
  expect(regions(project)[0].region!.leftMm).toBeGreaterThan(450);
  expect(requests.saves() - movesBefore).toBe(1);

  // Delete removes the region; Ctrl+Z and Ctrl+Y walk the history.
  await page.keyboard.press('Delete');
  project = await savedProject(page, project.editRevision);
  expect(regions(project)).toHaveLength(0);
  await page.keyboard.press('Control+z');
  project = await savedProject(page, project.editRevision);
  expect(regions(project)).toHaveLength(1);
  await page.keyboard.press('Control+y');
  project = await savedProject(page, project.editRevision);
  expect(regions(project)).toHaveLength(0);
  await page.keyboard.press('Control+z');
  project = await savedProject(page, project.editRevision);
  const kept = regions(project)[0];

  // Opened again it is still there and drawn.
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 45000 });
  expect(regions(await storedProject(page))[0]).toEqual(kept);
  expect(
    luminance(await canvasColor(page, '[data-testid="canvas-frame"] canvas', centroid(kept))),
  ).toBeLessThan(90);

  // The usage counts the region with its tile and takes it off the wall's base tile.
  await expect(page.getByLabel(`${kept.name} 면적 (㎡)`)).toBeVisible();
  const regionArea = (kept.region!.widthMm * kept.region!.heightMm) / 1e6;
  const areaOf = async (name: string) => Number(await page.getByLabel(`${name} 면적 (㎡)`).inputValue());
  expect(await areaOf(kept.name)).toBeCloseTo(regionArea, 6);
  expect(await areaOf(back.name)).toBeCloseTo(7.2 - regionArea, 6);

  // A smaller room says how many regions are cut before anything changes.
  await (await editorAction(page, '공간 크기')).click();
  const resize = page.getByRole('dialog', { name: '공간 크기 설정', exact: true });
  await resize.getByLabel('가로 (m)', { exact: true }).fill(String((kept.region!.leftMm + 100) / 1000));
  await expect(resize).toContainText('부분 타일 1개를 새 면에 맞춰 잘라요.');
  await resize.getByLabel('가로 (m)', { exact: true }).fill('3');
  await expect(resize).not.toContainText('부분 타일');
  await shot(page, '2d-resize-warning', info);
  await page.keyboard.press('Escape');
});

const stage = (page: Page) => page.getByTestId('room-editor-canvas');
async function stageReady(page: Page) {
  await expect(stage(page)).toBeVisible({ timeout: 45000 });
  await expect(stage(page)).toHaveAttribute('data-render-state', 'ready', { timeout: 45000 });
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
}
/** Pixels of a PNG near the deep blue of the accent tile. */
async function accentPixels(png: Buffer) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const [r, g, b] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
    if (b > r + 25 && b > g + 10 && r < 110) n++;
  }
  return n;
}
async function outlineCentre(page: Page) {
  const box = (await page.getByTestId('region-outline').locator('polygon').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('3D 편집 화면(벽 구조 있음): 끌어서 만들고 윤곽·이동이 되며 공간 둘러보기·다운로드에도 보인다', async ({
  page,
}, info) => {
  await startRoom(page);
  await registerTile(page, BASE, '#c9c2b4');
  await registerTile(page, ACCENT, '#1d3557');
  await tileEverything(page);
  // A wall niche turns the centre into the 3D room stage.
  const edit = page.getByRole('button', { name: /^벽 구조 편집/ });
  if (!(await edit.isVisible())) await page.getByRole('button', { name: /속성$/ }).last().click();
  await edit.click();
  const structure = page.getByRole('dialog', { name: '벽 구조 편집', exact: true });
  await structure.getByRole('button', { name: '벽 홈 추가', exact: true }).click();
  await structure.getByRole('button', { name: '적용하고 공간 보기', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: '공간 둘러보기', exact: true });
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  await stageReady(page);
  let project = await storedProject(page);
  const requests = watchRequests(page);

  await page.getByTestId('region-tool').click();
  const box = (await stage(page).boundingBox())!;
  const dragStart = requests.all();
  await page.mouse.move(box.x + box.width * 0.36, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.47, box.y + box.height * 0.5, { steps: 12 });
  await expect(page.getByTestId('region-preview')).toBeVisible();
  await shot(page, '3d-drawing', info);
  const duringDrag = requests.projectSince(dragStart);
  await page.mouse.up();
  expect(duringDrag, '끄는 동안 프로젝트 요청 없음').toEqual([]);
  project = await savedProject(page, project.editRevision);
  expect(requests.saves()).toBe(1);
  const [made] = regions(project);
  expect(made.roomFace).toBe('back');
  await expect(page.getByLabel('타일 적용 위치', { exact: true })).toHaveValue(made.id);
  await page.locator('button.material-tile').filter({ hasText: ACCENT }).click();
  project = await savedProject(page, project.editRevision);
  await stageReady(page);
  await page.getByRole('button', { name: '선택 / 이동', exact: true }).click();
  await expect(page.getByTestId('region-outline')).toBeVisible();
  await shot(page, '3d-tiled', info);
  expect(await accentPixels(await stage(page).locator('canvas').screenshot())).toBeGreaterThan(300);

  // Dragging the selected region moves it along the wall, one save when let go.
  const centre = await outlineCentre(page);
  const before = regions(project)[0].region!;
  const savesBefore = requests.saves();
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 70, centre.y, { steps: 10 });
  await page.mouse.up();
  project = await savedProject(page, project.editRevision);
  expect(regions(project)[0].region!.leftMm).toBeGreaterThan(before.leftMm + 50);
  expect(regions(project)[0].region!.topMm).toBeCloseTo(before.topMm, 0);
  expect(requests.saves() - savesBefore).toBe(1);
  await stageReady(page);

  // The spatial viewer and the download draw the same region.
  await (await editorAction(page, '공간 둘러보기')).click();
  await expect(viewer).toBeVisible();
  await page.waitForTimeout(1500);
  expect(await accentPixels(await viewer.locator('canvas').first().screenshot())).toBeGreaterThan(300);
  await shot(page, '3d-viewer', info);
  await viewer.getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  const file = await readFile((await (await download).path())!);
  await writeFile(`${SHOTS}/3d-download.png`, file);
  expect(await accentPixels(file)).toBeGreaterThan(300);
});
