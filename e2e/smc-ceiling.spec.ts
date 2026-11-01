import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { downloadedArtifact } from './helpers/downloaded-artifact';
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import { addWallNiche, editorAction, savedProject, storedProject } from '../tests/helpers/editor-actions';
import { getActiveDesign } from '../src/lib/designs';
import { SMC_CEILING_IMAGE } from '../src/lib/smc-ceiling';
import type { ProjectDocument } from '../src/lib/types';

/**
 * The SMC ceiling option (docs/smc-ceiling-results-20261031.md): one click on the toolbar shows it in
 * the 2D and 3D editors, the viewer and the download; the light goes with its panel; each click is one
 * save and one undo step; no material list is asked for and the usage stays as it was.
 */
let app: AuthenticatedApp;
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(600000);

const SHOTS = 'test-results/smc-ceiling/screens';
const ceiling = (project: ProjectDocument) => getActiveDesign(project)!.scene.ceiling;
const toggle = (page: Page) => page.getByTestId('ceiling-toggle');
const light = (page: Page) => page.getByTestId('ceiling-light');

async function shot(page: Page, name: string) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
/** Counts project saves and material-list requests from now on. */
function watchRequests(page: Page) {
  const calls: { save: boolean; list: boolean }[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    calls.push({
      save: url.pathname === '/api/d1/projects' && (request.postData() ?? '').includes('"operation":"save"'),
      list: url.pathname === '/api/d1/materials' || url.pathname.startsWith('/api/catalog/'),
    });
  });
  return {
    saves: () => calls.filter((call) => call.save).length,
    lists: () => calls.filter((call) => call.list).length,
  };
}
/** Pixels that are the light panel: pure white, which nothing else in these rooms is. */
async function panelPixels(png: Buffer, level = 253) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < info.width * info.height; i++)
    if (data[i * 3] >= level && data[i * 3 + 1] >= level && data[i * 3 + 2] >= level) count++;
  return count;
}
const stagePixels = async (page: Page, testId: string) =>
  panelPixels(await page.getByTestId(testId).screenshot({ animations: 'disabled' }));
const settled = async (page: Page) => {
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 45000 });
  await expect(page.locator('.editor-error')).toHaveCount(0);
};
const usageText = (page: Page) => page.getByTestId('usage-total').innerText();

async function startRoom(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await settled(page);
  return savedProject(page);
}

test('2D: 눌러서 넣고 조명을 끄고 다시 눌러 없앤다. 누를 때마다 저장 1, 되돌리기, 새로고침, 크기 변경', async ({
  page,
}) => {
  app = await authenticatedApp(page);
  let project = await startRoom(page);
  const requests = watchRequests(page);
  const total = await usageText(page);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(light(page)).toHaveCount(0);
  const none = await stagePixels(page, 'canvas-frame');
  await shot(page, '2d-none');

  const picture = page.waitForResponse((response) => response.url().endsWith(SMC_CEILING_IMAGE));
  await toggle(page).click();
  expect((await picture).status(), '천장 그림을 읽음').toBe(200);
  project = await savedProject(page, project.editRevision);
  expect(ceiling(project)).toEqual({ kind: 'smc', light: true });
  expect(requests.saves(), '넣기 → 저장 1').toBe(1);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(light(page)).toHaveAttribute('aria-pressed', 'true');
  await settled(page);
  await expect.poll(() => stagePixels(page, 'canvas-frame')).toBeGreaterThan(none + 100);
  // It is no 3D scene.
  await expect(page.getByTestId('room-editor-canvas')).toHaveCount(0);
  await shot(page, '2d-light-on');

  await light(page).click();
  project = await savedProject(page, project.editRevision);
  expect(ceiling(project)).toEqual({ kind: 'smc', light: false });
  expect(requests.saves(), '조명 끄기 → 저장 1').toBe(2);
  await settled(page);
  await expect.poll(() => stagePixels(page, 'canvas-frame')).toBeLessThanOrEqual(none);
  await shot(page, '2d-light-off');
  await light(page).click();
  project = await savedProject(page, project.editRevision);
  expect(ceiling(project)).toEqual({ kind: 'smc', light: true });

  // Back, forth and off.
  await page.keyboard.press('Control+z');
  project = await savedProject(page, project.editRevision);
  expect(ceiling(project)).toEqual({ kind: 'smc', light: false });
  await page.keyboard.press('Control+y');
  project = await savedProject(page, project.editRevision);
  expect(ceiling(project)).toEqual({ kind: 'smc', light: true });
  const saves = requests.saves();
  await toggle(page).click();
  project = await savedProject(page, project.editRevision);
  expect(ceiling(project)).toBeUndefined();
  expect(requests.saves() - saves, '없애기 → 저장 1').toBe(1);
  await expect(light(page)).toHaveCount(0);
  await page.keyboard.press('Control+z');
  project = await savedProject(page, project.editRevision);
  expect(ceiling(project)).toEqual({ kind: 'smc', light: true });

  // No list and no price at any point.
  expect(requests.lists(), '자재 목록 요청 없음').toBe(0);
  expect(await usageText(page)).toBe(total);

  // A reload keeps it, and so does a new room size.
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await settled(page);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  expect(ceiling(await storedProject(page))).toEqual({ kind: 'smc', light: true });
  await page.getByRole('button', { name: '편집 속성으로 이동', exact: true }).click();
  await page.getByRole('button', { name: '공간 크기 변경', exact: true }).click();
  const resize = page.getByRole('dialog', { name: '공간 크기 설정', exact: true });
  await resize.getByLabel('가로 (m)', { exact: true }).fill('3');
  await resize
    .getByRole('button', { name: /적용|변경/ })
    .last()
    .click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => getActiveDesign(await storedProject(page))!.scene.room!.widthMm).toBe(3000);
  expect(ceiling(await storedProject(page))).toEqual({ kind: 'smc', light: true });
});

test('3D(벽 홈 있음): 천장이 나타나고 공간 둘러보기·다운로드에 들어가며, 조명을 끄면 패널이 없다', async ({
  page,
}) => {
  app = await authenticatedApp(page);
  await startRoom(page);
  await addWallNiche(page);
  const stage = page.getByTestId('room-editor-canvas');
  await expect(stage).toHaveAttribute('data-render-state', 'ready', { timeout: 45000 });
  await page.getByRole('button', { name: '선택 / 이동', exact: true }).click();
  let project = await savedProject(page);
  const none = await stagePixels(page, 'room-editor-canvas');
  await shot(page, '3d-none');

  await toggle(page).click();
  project = await savedProject(page, project.editRevision);
  await expect(stage).toHaveAttribute('data-render-state', 'ready', { timeout: 45000 });
  await expect.poll(() => stagePixels(page, 'room-editor-canvas')).toBeGreaterThan(none + 100);
  await shot(page, '3d-light-on');
  await light(page).click();
  project = await savedProject(page, project.editRevision);
  await expect(stage).toHaveAttribute('data-render-state', 'ready', { timeout: 45000 });
  await expect.poll(() => stagePixels(page, 'room-editor-canvas')).toBeLessThanOrEqual(none);
  await shot(page, '3d-light-off');
  await light(page).click();
  await savedProject(page, project.editRevision);
  await expect(stage).toHaveAttribute('data-render-state', 'ready', { timeout: 45000 });

  // The four directions all show it.
  for (const turn of ['왼쪽 90°', '왼쪽 90°', '왼쪽 90°', '왼쪽 90°']) {
    await page.getByRole('button', { name: turn, exact: true }).click();
    await expect.poll(() => stagePixels(page, 'room-editor-canvas')).toBeGreaterThan(100);
  }

  // The viewer.
  await (await editorAction(page, '공간 둘러보기')).click();
  const viewer = page.getByRole('dialog', { name: '공간 둘러보기', exact: true });
  const viewport = page.getByTestId('room-view-viewport');
  await expect(viewport).toHaveAttribute('aria-busy', 'false', { timeout: 45000 });
  await expect(viewer.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => stagePixels(page, 'room-view-viewport')).toBeGreaterThan(100);
  await shot(page, 'viewer');
  await viewer.getByRole('button', { name: '공간 둘러보기 닫기', exact: true }).click();

  // The download.
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const saved = page.waitForEvent('download', { timeout: 120000 });
  await page.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  await mkdir(SHOTS, { recursive: true });
  const bytes = await downloadedArtifact(await saved, `${SHOTS}/download.png`);
  // The photo effects of a download bring the panel just under pure white.
  expect(await panelPixels(bytes, 244)).toBeGreaterThan(100);
});

test('시안 복제에는 있고 새 시안과 Before에는 없으며, Before 편집 중에는 버튼이 꺼진다', async ({ page }) => {
  app = await authenticatedApp(page);
  const initial = await startRoom(page);
  // A comparison (as a photo reconstruction leaves) so the Before side exists.
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
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await settled(page);
  let project = await storedProject(page);
  await toggle(page).click();
  project = await savedProject(page, project.editRevision);
  expect(ceiling(project)).toEqual({ kind: 'smc', light: true });
  expect(project.shared.comparison!.before.ceiling).toBeUndefined();

  // Viewing Before: the option is off and says why.
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect(toggle(page)).toBeDisabled();
  await expect(toggle(page)).toHaveAttribute('title', /SMC 천장/);
  await page.getByRole('button', { name: 'After', exact: true }).click();
  await expect(toggle(page)).toBeEnabled();

  // A copy has it; a new design has not.
  await page.getByRole('button', { name: '시안 관리', exact: true }).click();
  const manager = page.getByRole('dialog', { name: /^시안 관리/ });
  await manager.getByRole('button', { name: '시안 A 복제', exact: true }).click();
  await expect.poll(async () => (await storedProject(page)).designs.length, { timeout: 20000 }).toBe(2);
  const designs = (await storedProject(page)).designs;
  expect(designs.every((design) => design.scene.ceiling?.kind === 'smc')).toBe(true);
});

test('AI 변환 요청의 장면과 문장에 SMC 천장이 조명 상태대로 들어가고, 천장이 없으면 없다', async ({
  page,
}) => {
  app = await authenticatedApp(page);
  const png = await sharp({ create: { width: 992, height: 672, channels: 3, background: '#b8cbd0' } })
    .png()
    .toBuffer();
  const sent: { ceiling?: unknown }[] = [];
  await page.route('**/api/export/photoreal', async (route) => {
    const request = route.request();
    const form = await new Response(new Uint8Array(request.postDataBuffer()!), {
      headers: { 'content-type': request.headers()['content-type'] },
    }).formData();
    sent.push(JSON.parse((form.get('scene') as string | null) ?? '{}'));
    await route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });
  await startRoom(page);
  const convert = async () => {
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
    await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
    await expect(dialog.getByAltText('FLUX 4B 현장 사진 변환 결과')).toBeVisible({ timeout: 60000 });
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  };
  await convert();
  expect(sent[0].ceiling).toBeUndefined();
  await toggle(page).click();
  await convert();
  expect(sent[1].ceiling).toMatchObject({ material: 'smc', light: 'flat-panel' });
  await light(page).click();
  await convert();
  expect(sent[2].ceiling).toMatchObject({ material: 'smc', light: 'none' });
});

test.describe('게스트 휴대폰', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });
  test('375px: 도구줄이 넘치지 않고 눌러서 넣으면 새로고침 뒤에도 남는다', async ({ page }) => {
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
    await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
    await settled(page);
    await toggle(page).tap();
    await expect.poll(async () => ceiling(await draft())).toEqual({ kind: 'smc', light: true });
    await expect(light(page)).toBeVisible();
    await settled(page);
    await shot(page, 'guest-375');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    // Every toolbar button stays on the phone's screen.
    const boxes = await page
      .locator('.workspace-toolbar button')
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().right));
    expect(Math.max(...boxes)).toBeLessThanOrEqual(375);
    await light(page).tap();
    await expect.poll(async () => ceiling(await draft())).toEqual({ kind: 'smc', light: false });
    await page.reload();
    await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(light(page)).toHaveAttribute('aria-pressed', 'false');
    expect(ceiling(await draft())).toEqual({ kind: 'smc', light: false });
  });
});
