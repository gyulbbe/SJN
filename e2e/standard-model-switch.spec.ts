import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { getActiveDesign } from '../src/lib/designs';
import type { FixtureInstance, ProjectDocument } from '../src/lib/types';

// "표준 모형으로 보기": a registered photo product shown as the generic toilet, basin or bath of the 3D
// room, per product, off by default. Nothing here calls an AI model.
let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(240000);

const redFixture = () =>
  sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect x="50" y="10" width="100" height="185" rx="20" fill="#ff2222"/></svg>',
    ),
  )
    .png()
    .toBuffer();
const wideRedFixture = () =>
  sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect x="40" y="20" width="320" height="170" rx="20" fill="#ff2222"/></svg>',
    ),
  )
    .png()
    .toBuffer();

async function openRoomProject(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 30000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
}
async function savedProject(page: Page): Promise<ProjectDocument> {
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  return app.project(page.url().split('/').at(-1)!);
}
const fixtures = async (page: Page) => getActiveDesign(await savedProject(page))!.scene.fixtures;
/** The saved fixtures once there are `count` of them (the save follows the screen a moment later). */
async function savedFixtures(page: Page, count: number): Promise<FixtureInstance[]> {
  await expect.poll(async () => (await fixtures(page)).length).toBe(count);
  return fixtures(page);
}
/** A product (600 wide, 600 tall, 400 deep) registered with two photos, then placed in the room. */
async function placeProduct(
  page: Page,
  category: 'basin' | 'toilet' | 'bath',
  installation: 'floor' | 'wall',
  secondDirection: '왼쪽' | '오른쪽',
) {
  const name = `직접 등록한 ${category}`;
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await dialog.getByLabel('상품명').fill(name);
  await dialog.getByLabel('카테고리', { exact: true }).selectOption(category);
  await dialog.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await dialog.getByLabel('높이 (mm)', { exact: true }).fill('600');
  await dialog.getByLabel('설치 방식', { exact: true }).selectOption(installation);
  await dialog.getByLabel('깊이 (mm)', { exact: true }).fill('400');
  await dialog.getByLabel('+ 제품 이미지 올리기', { exact: true }).setInputFiles([
    { name: 'fixture.png', mimeType: 'image/png', buffer: await redFixture() },
    { name: 'wide-side.png', mimeType: 'image/png', buffer: await wideRedFixture() },
  ]);
  await expect(
    dialog.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
  ).toHaveCount(2);
  await dialog.getByLabel('촬영 방향 2', { exact: true }).selectOption(secondDirection);
  await dialog.getByLabel('기준점 X').nth(1).fill('25');
  await dialog.getByRole('spinbutton', { name: /^Y/ }).nth(1).fill('80');
  await dialog.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`${name}.*600`) }).click();
  return name;
}
const switchOf = (page: Page) => page.getByRole('switch', { name: '표준 모형으로 보기' });
/** What the 3D room's notice list says about the products, from "공간 둘러보기". */
async function viewerNotices(page: Page) {
  await page.getByRole('button', { name: '공간 둘러보기', exact: true }).click();
  const viewer = page.getByTestId('room-viewer');
  await expect(viewer).toBeVisible({ timeout: 30000 });
  const details = viewer.locator('details').first();
  await expect(details).toBeVisible({ timeout: 30000 });
  await details.locator('summary').click();
  const text = (await details.innerText()).replace(/\s+/g, ' ');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  return text;
}

test('켜면 모형으로 바뀌고 위치·자재·각도 사진은 그대로이며, 설치 면·배율·복제·잠금은 계속 된다', async ({
  page,
}) => {
  await openRoomProject(page);
  await placeProduct(page, 'basin', 'floor', '왼쪽');
  const [photo] = await savedFixtures(page, 1);
  expect(photo.reconstruction).toBeUndefined();
  await expect(page.getByTestId('fixture-view-0')).toBeVisible();
  const toggle = switchOf(page);
  await expect(toggle).not.toBeChecked();
  // The photo's own notice in the 3D room: a flat plane.
  expect(await viewerNotices(page)).toContain('2D 제품·각도 표현 제한');

  await toggle.click();
  await expect(page.getByTestId('standard-model-notice')).toHaveText(
    '표준 모형은 일반 모양이라 제품 생김새는 사라져요. 끄면 사진으로 돌아와요.',
  );
  await expect(toggle).toBeChecked();
  await expect.poll(async () => (await fixtures(page))[0].reconstruction?.kind).toBe('basin');
  const [shown] = await fixtures(page);
  // The model: the material's size, a pedestal (the material is not wall-installed), a round bowl, the
  // photo's colour (the red photo), on the floor.
  expect(shown.reconstruction).toMatchObject({
    version: 2,
    kind: 'basin',
    widthMm: 600,
    heightMm: 600,
    depthMm: 400,
    baseHeightMm: 0,
    basinVariant: 'pedestal',
    basinShape: 'round',
  });
  const [, red, green, blue] = /^#(..)(..)(..)$/
    .exec(shown.reconstruction!.color)!
    .map((hex) => parseInt(hex, 16));
  expect(red).toBeGreaterThan(240);
  expect(green).toBeLessThan(60);
  expect(blue).toBeLessThan(60);
  // The photo side stays: the material, the shown photo, the place.
  expect(shown.materialVersionId).toBe(photo.materialVersionId);
  expect(shown.viewIndex).toBe(photo.viewIndex);
  expect(shown.roomPlacement).toEqual(photo.roomPlacement);
  // The 3D room no longer draws a flat plane for it.
  const notices = await viewerNotices(page);
  expect(notices).not.toContain('2D 제품·각도 표현 제한');
  expect(notices).not.toContain('각도 사진을 쓰며');
  // The angle photos are not used while it is a model, and the page says why.
  await expect(page.getByTestId('fixture-view-0')).toHaveCount(0);
  await expect(page.getByTestId('standard-model-angle-hint')).toContainText('각도 사진을 고를 수 없어요');
  await expect(page.getByTestId('facing-warning')).toHaveCount(0);
  // The basics still work: the face, the scale, the place.
  await page.getByLabel('제품 설치 면', { exact: true }).selectOption('left');
  await expect.poll(async () => (await fixtures(page))[0].roomPlacement?.face).toBe('left');
  const onWall = (await fixtures(page))[0];
  expect(onWall.reconstruction?.baseHeightMm).toBeCloseTo((1 - onWall.roomPlacement!.v) * 2400, 3);
  await page.getByLabel('제품 설치 면', { exact: true }).selectOption('floor');
  await expect.poll(async () => (await fixtures(page))[0].roomPlacement?.face).toBe('floor');
  expect((await fixtures(page))[0].reconstruction?.baseHeightMm).toBe(0);
  const scale = page.getByLabel('제품 배율 숫자 입력', { exact: true });
  await scale.fill('120');
  await scale.press('Enter');
  await expect.poll(async () => (await fixtures(page))[0].roomPlacement?.scale).toBeCloseTo(1.2, 5);
  // The options of the model.
  await page.getByLabel('세면대 형태', { exact: true }).selectOption('wall');
  await expect.poll(async () => (await fixtures(page))[0].reconstruction?.basinVariant).toBe('wall');
  // A copy keeps the model and stands beside the original, not on it.
  await page.getByRole('button', { name: '복제', exact: true }).click();
  const [original, copy] = await savedFixtures(page, 2);
  expect(copy.reconstruction).toMatchObject({ kind: 'basin', basinVariant: 'wall' });
  expect([copy.roomPlacement!.u, copy.roomPlacement!.v]).not.toEqual([
    original.roomPlacement!.u,
    original.roomPlacement!.v,
  ]);
  // Locking holds the switch too.
  await page.getByRole('button', { name: '배치 잠금', exact: true }).click();
  await expect(toggle).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('standard-model-on.png'), fullPage: true });
});

test('끄면 사진으로 정확히 돌아오고, 켜기와 끄기는 각각 실행 취소 한 번이며, 저장 뒤 다시 열어도 그대로다', async ({
  page,
}) => {
  await openRoomProject(page);
  // A wall-hung basin on the left wall with its 오른쪽 photo: the one product whose place the switch has to convert.
  await placeProduct(page, 'basin', 'wall', '오른쪽');
  const [photo] = await savedFixtures(page, 1);
  expect(photo.roomPlacement?.face).toBe('left');
  expect(photo.viewIndex).toBe(1);
  const toggle = switchOf(page);
  await toggle.click();
  await expect.poll(async () => (await fixtures(page))[0].reconstruction?.kind).toBe('basin');
  const [shown] = await fixtures(page);
  // It hangs where the photo's lowest point hung, and its v follows its lower edge.
  const bounds = photo.roomPlacement!.contentBounds;
  const anchorDown = (photo.anchor.y - bounds.top) / (bounds.bottom - bounds.top);
  const base = (1 - photo.roomPlacement!.v) * 2400 - (1 - anchorDown) * 600 * photo.roomPlacement!.scale;
  expect(shown.reconstruction?.baseHeightMm).toBeCloseTo(base, 3);
  expect(shown.roomPlacement?.v).toBeCloseTo(1 - base / 2400, 6);
  expect(shown.reconstruction).toMatchObject({ basinVariant: 'wall', yawDegrees: 0 });

  // One undo takes the model away at once, one redo brings it back.
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect.poll(async () => (await fixtures(page))[0].reconstruction).toBeUndefined();
  expect((await fixtures(page))[0]).toEqual(photo);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await expect.poll(async () => (await fixtures(page))[0].reconstruction?.kind).toBe('basin');

  // Off: the photo again, where it stood (the same photo, the same anchor, the same place).
  await switchOf(page).click();
  await expect(page.getByTestId('standard-model-notice')).toHaveText('사진으로 돌아왔어요.');
  await expect.poll(async () => (await fixtures(page))[0].reconstruction).toBeUndefined();
  const [back] = await fixtures(page);
  expect(back.viewIndex).toBe(1);
  expect(back.anchor).toEqual(photo.anchor);
  expect(back.roomPlacement?.v).toBeCloseTo(photo.roomPlacement!.v, 6);
  expect(back.roomPlacement).toMatchObject({ face: 'left', u: photo.roomPlacement!.u, scale: 1 });
  await expect(page.getByTestId('fixture-view-1')).toHaveAttribute('aria-pressed', 'true');
  expect(await viewerNotices(page)).toContain('2D 제품·각도 표현 제한');

  // On again, saved and reopened: still a model, and the 3D room draws no plane for it.
  await switchOf(page).click();
  await expect.poll(async () => (await fixtures(page))[0].reconstruction?.kind).toBe('basin');
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  expect((await fixtures(page))[0].reconstruction?.kind).toBe('basin');
  expect(await viewerNotices(page)).not.toContain('2D 제품·각도 표현 제한');
});

test('이 기능으로 켠 제품만 있으면 변환 창은 지금 방식으로 열리고 실험 C도 고를 수 있다', async ({
  page,
}) => {
  await openRoomProject(page);
  await placeProduct(page, 'toilet', 'floor', '왼쪽');
  await savedFixtures(page, 1);
  await switchOf(page).click();
  await expect.poll(async () => (await fixtures(page))[0].reconstruction?.kind).toBe('toilet');
  expect((await fixtures(page))[0].reconstruction).toMatchObject({ toiletLidState: 'closed', yawDegrees: 0 });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  const methods = dialog.getByRole('group', { name: '변환 방식' });
  // Nothing has been chosen on this browser yet: the whole-room conversion, not experiment C.
  await expect(methods.getByRole('radio', { name: '지금 방식', exact: true })).toBeChecked();
  // C is still there to pick, and says what it would cost for the one switched product.
  await methods.getByText('실험 C · 제품별 다듬기', { exact: true }).click();
  await expect(methods.getByRole('radio', { name: '실험 C · 제품별 다듬기', exact: true })).toBeChecked();
  await expect(dialog.getByTestId('flux-composite-note')).toContainText('다듬을 제품은 1개');
});

test('욕조도 켜고 끌 수 있고, 모형이 없는 분류(거울)에는 스위치가 없다', async ({ page }) => {
  await openRoomProject(page);
  await placeProduct(page, 'bath', 'floor', '왼쪽');
  const [bath] = await savedFixtures(page, 1);
  await switchOf(page).click();
  await expect.poll(async () => (await fixtures(page))[0].reconstruction?.kind).toBe('bath');
  const [model] = await fixtures(page);
  expect(model.reconstruction).toMatchObject({
    version: 2,
    kind: 'bath',
    widthMm: 600,
    heightMm: 600,
    depthMm: 400,
  });
  expect(model.reconstruction?.basinVariant).toBeUndefined();
  expect(model.roomPlacement).toEqual(bath.roomPlacement);
  await switchOf(page).click();
  await expect.poll(async () => (await fixtures(page))[0].reconstruction).toBeUndefined();
  expect((await fixtures(page))[0]).toEqual(bath);
  // A category without a model (a mirror): no switch.
  const mirror = '직접 등록한 거울';
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await dialog.getByLabel('상품명').fill(mirror);
  await dialog.getByLabel('카테고리', { exact: true }).selectOption('mirror');
  await dialog.getByLabel('가로 (mm)', { exact: true }).fill('500');
  await dialog.getByLabel('높이 (mm)', { exact: true }).fill('700');
  await dialog.getByLabel('설치 방식', { exact: true }).selectOption('wall');
  await dialog.getByLabel('+ 제품 이미지 올리기', { exact: true }).setInputFiles({
    name: 'mirror.png',
    mimeType: 'image/png',
    buffer: await redFixture(),
  });
  await expect(
    dialog.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
  ).toHaveCount(1);
  await dialog.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`${mirror}.*500`) }).click();
  await savedFixtures(page, 2);
  await expect(page.getByRole('heading', { name: '제품 속성', exact: true })).toBeVisible();
  await expect(page.getByTestId('standard-model-block')).toHaveCount(0);
});
