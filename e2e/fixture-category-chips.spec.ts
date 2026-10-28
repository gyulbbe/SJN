import { mkdirSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { PRODUCTS, seed, seedProducts } from './helpers/material-seed';
import { getActiveDesign } from '../src/lib/designs';
import type { ProjectDocument } from '../src/lib/types';

/**
 * The editor's 위생도기 kinds (the material library's chips without tiles), the library's new 기타
 * kind, and 샤워 커튼 left out of every list people pick from. A chip asks for that kind's first page
 * once (d1-query-budget).
 */
const shots = 'test-results/fixture-chips';
mkdirSync(shots, { recursive: true });
let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(240000);

const KINDS = [
  '전체',
  '변기',
  '세면대',
  '하부장',
  '욕조',
  '샤워 설비',
  '수전',
  '거울',
  '문',
  '창',
  '유리 파티션',
  '거울 수납장',
  '벽 선반',
  '벽 수납장',
  '낮은 칸막이',
  '기타',
];
const EXTRA = [
  { name: '칩 변기 001', category: 'toilet' },
  { name: '칩 기타 수건걸이', category: 'other', installation: 'wall' },
];

/** List requests (the member page operation, or the guest drawer's GET) and the kind each asked for. */
function lists(page: Page) {
  const kinds: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/d1/materials') {
      const body = JSON.parse(request.postData() ?? 'null');
      if (body?.operation === 'page') kinds.push(body.query?.category ?? '');
    } else if (url.pathname === '/api/catalog/placement' && url.searchParams.has('category'))
      kinds.push(url.searchParams.get('category')!);
  });
  return kinds;
}
const chipNames = (chips: Locator) => chips.getByRole('button').allInnerTexts();
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}

test('편집 화면 위생도기: 종류 칩으로 고르고(요청 1회씩), 기타 제품을 놓고 저장한다 · 375px', async ({
  page,
}) => {
  app = await authenticatedApp(page);
  await seed(app);
  const [toilet, other] = await seedProducts(app, EXTRA);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  const panel = page.locator('aside.catalog-panel');
  const tiles = panel.locator('button.material-tile');
  const chips = panel.getByRole('group', { name: '위생도기 종류' });
  // The tile tabs have no kinds.
  await expect(chips).toHaveCount(0);
  const kinds = lists(page);
  await panel.getByRole('button', { name: '위생도기', exact: true }).click();
  await expect(tiles).toHaveCount(PRODUCTS + EXTRA.length);
  expect(await chipNames(chips)).toEqual(KINDS);
  await expect(chips.getByRole('button', { name: '전체', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(kinds).toEqual(['fixtures']);
  await page.screenshot({ path: `${shots}/editor-1440.png` });
  // One row that scrolls sideways, never squeezed below its chips.
  expect(
    await chips.evaluate((row) => row.clientHeight - row.querySelector('button')!.offsetHeight),
  ).toBeGreaterThanOrEqual(0);
  expect(await chips.evaluate((row) => row.scrollWidth > row.clientWidth)).toBe(true);
  // No scrollbar takes the cards' height; the far side fades to say there is more.
  expect(await chips.evaluate((row) => (row as HTMLElement).offsetHeight - row.clientHeight)).toBe(0);
  const mask = () => chips.evaluate((row) => getComputedStyle(row).maskImage);
  expect(await mask()).toContain('linear-gradient');
  // A mouse wheel over the row moves it sideways (the panel stays where it is), then back.
  const scrolled = () => chips.evaluate((row) => row.scrollLeft);
  const panelTop = () => panel.evaluate((node) => node.scrollTop);
  const top = await panelTop();
  await chips.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(scrolled).toBeGreaterThan(0);
  expect(await panelTop()).toBe(top);
  await page.mouse.wheel(0, -2000);
  await expect.poll(scrolled).toBe(0);

  // A kind asks for its first page once; the same chip again asks nothing.
  const chip = (name: string) => chips.getByRole('button', { name, exact: true });
  await chip('기타').click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText(other.name);
  await expect(chip('기타')).toHaveAttribute('aria-pressed', 'true');
  await chip('기타').click();
  await page.waitForTimeout(800);
  expect(kinds).toEqual(['fixtures', 'other']);
  await chip('변기').click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText(toilet.name);
  await chip('세면대').click();
  await expect(tiles).toHaveCount(PRODUCTS);
  await chip('전체').click();
  await expect(tiles).toHaveCount(PRODUCTS + EXTRA.length);
  // A kind without materials is a filter with no match (not "no materials"); resetting picks 전체.
  await chip('수전').click();
  await expect(panel.getByText('조건에 맞는 자재가 없어요.')).toBeVisible();
  await panel.getByRole('button', { name: '필터 초기화', exact: true }).click();
  await expect(chip('전체')).toHaveAttribute('aria-pressed', 'true');
  await expect(tiles).toHaveCount(PRODUCTS + EXTRA.length);
  expect(kinds).toEqual(['fixtures', 'other', 'toilet', 'basin', 'fixtures', 'faucet', 'fixtures']);

  // The chip stays while the editor is open (another tab and back).
  await chip('기타').click();
  await expect(tiles).toHaveCount(1);
  await panel.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await expect(chips).toHaveCount(0);
  await panel.getByRole('button', { name: '위생도기', exact: true }).click();
  await expect(chip('기타')).toHaveAttribute('aria-pressed', 'true');
  await expect(tiles).toHaveCount(1);
  // The picked chip is in view, not left past the end of the row.
  const inView = () =>
    chips.evaluate((row) => {
      const box = row.getBoundingClientRect();
      const picked = row.querySelector('[aria-pressed="true"]')!.getBoundingClientRect();
      return picked.left >= box.left - 0.5 && picked.right <= box.right + 0.5;
    });
  expect(await inView()).toBe(true);
  await page.screenshot({ path: `${shots}/editor-other.png` });

  // A 기타 product is placed and saved like any other.
  await tiles.first().click();
  await expect(page.getByText('배치한 제품 1개')).toBeVisible();
  await page.keyboard.press('Control+s');
  const projectId = page.url().split('/').at(-1)!;
  await expect
    .poll(
      async () => {
        const saved: ProjectDocument = await app!.project(projectId);
        return getActiveDesign(saved)!.scene.fixtures.map((f) => f.materialVersionId);
      },
      { timeout: 30000 },
    )
    .toContain(other.versionId);

  // A phone: the row scrolls sideways inside the drawer, every chip a 44px target.
  await page.setViewportSize({ width: 375, height: 812 });
  const open = page.getByRole('button', { name: '자재 목록', exact: true });
  if (await open.isVisible()) await open.click();
  await expect(chips).toBeVisible();
  await noSideScroll(page);
  const heights = await chips
    .getByRole('button')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
  // The row is not squeezed in the drawer's column (it shows its chips whole).
  expect(await chips.evaluate((row) => row.clientHeight)).toBeGreaterThanOrEqual(Math.max(...heights));
  expect(await chips.evaluate((row) => row.scrollWidth > row.clientWidth)).toBe(true);
  await chip('기타').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/editor-375.png` });
});

test('라이브러리·등록 양식·분류 관리: 기타가 있고 샤워 커튼은 없다', async ({ page }) => {
  app = await authenticatedApp(page);
  await seed(app);
  const [, other] = await seedProducts(app, EXTRA);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin/materials');
  const cards = page.locator('main article');
  await expect(cards).toHaveCount(48);
  const names = await page.locator('main button').allInnerTexts();
  expect(names).toContain('기타');
  expect(names).not.toContain('샤워 커튼');
  await page.getByRole('button', { name: '기타', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(other.name);
  await page.screenshot({ path: `${shots}/library-other.png` });
  // The form offers 기타 and not 샤워 커튼.
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const category = page.getByRole('combobox', { name: '카테고리' });
  const options = await category.locator('option').allInnerTexts();
  expect(options.at(-1)).toBe('기타');
  expect(options).not.toContain('샤워 커튼');
  await page.keyboard.press('Escape');
  // A subcategory's parent: neither 기타 (it has none) nor 샤워 커튼.
  await page.goto('/admin/catalog');
  await page.locator('form select').first().selectOption('subcategory');
  const parents = await page.locator('form select').nth(1).locator('option').allInnerTexts();
  expect(parents).toContain('세면대');
  expect(parents).not.toContain('기타');
  expect(parents).not.toContain('샤워 커튼');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/admin/materials');
  await expect(cards.first()).toBeVisible();
  await noSideScroll(page);
});

test('게스트: 위생도기 칩이 공개 배치 목록의 그 종류를 받고, 공개 자재 종류에도 기타가 있다', async ({
  page,
}) => {
  app = await authenticatedApp(page, { signedIn: false });
  await seed(app);
  const [, other] = await seedProducts(app, EXTRA);
  await page.setViewportSize({ width: 375, height: 812 });
  const kinds = lists(page);
  await page.goto('/');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정' })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await expect(page).toHaveURL(/\/try$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await page.getByRole('button', { name: '자재 목록', exact: true }).click();
  const panel = page.locator('aside.catalog-panel');
  const tiles = panel.locator('button.material-tile');
  await panel.getByRole('button', { name: '위생도기', exact: true }).click();
  await expect(tiles).toHaveCount(PRODUCTS + EXTRA.length);
  const chips = panel.getByRole('group', { name: '위생도기 종류' });
  expect(await chipNames(chips)).toEqual(KINDS);
  await chips.getByRole('button', { name: '기타', exact: true }).click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText(other.name);
  expect(kinds.filter((kind) => kind === 'other')).toHaveLength(1);
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}/guest-375.png` });
  await page.goto('/materials');
  const options = await page.getByLabel('제품 종류').locator('option').allInnerTexts();
  expect(options).toContain('기타');
  expect(options).not.toContain('샤워 커튼');
  await page.getByLabel('제품 종류').selectOption('other');
  await expect(page.locator('main [data-page-item]')).toHaveCount(1);
});

/** The member editor's 위생도기 tab, opened on a new basic room. */
async function openFixtures(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  const panel = page.locator('aside.catalog-panel');
  const open = page.getByRole('button', { name: '자재 목록', exact: true });
  if (await open.isVisible()) await open.click();
  await panel.getByRole('button', { name: '위생도기', exact: true }).click();
  const chips = panel.getByRole('group', { name: '위생도기 종류' });
  await expect(chips).toBeVisible();
  return { panel, chips };
}
const edgeState = (chips: Locator) =>
  chips.evaluate((row) => ({
    left: row.scrollLeft,
    max: row.scrollWidth - row.clientWidth,
    mask: getComputedStyle(row).maskImage,
  }));

test('칩 줄: 마우스를 끝 가까이 대면 그쪽으로 넘어가고, 벗어나거나 누르면 멈춘다 · 요청 0회', async ({
  page,
}) => {
  app = await authenticatedApp(page);
  await seed(app);
  await seedProducts(app, EXTRA);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { panel, chips } = await openFixtures(page);
  await expect(panel.locator('button.material-tile')).toHaveCount(PRODUCTS + EXTRA.length);
  const kinds = lists(page);
  const api: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && path !== '/api/d1/role' && !path.startsWith('/api/auth/')) api.push(path);
  });
  // What opening asked for (card images) is done before the mouse moves.
  for (let seen = -1; seen !== api.length;) {
    seen = api.length;
    await page.waitForTimeout(2000);
  }
  api.length = 0;
  const box = (await chips.boundingBox())!;
  const y = box.y + box.height / 2;
  const left = async () => (await edgeState(chips)).left;
  expect(await left()).toBe(0);
  // The middle of the row: nothing moves.
  await page.mouse.move(box.x + box.width / 2, y);
  await page.waitForTimeout(600);
  expect(await left()).toBe(0);
  // Near the right end: it moves right, all the way, and the right side stops fading.
  await page.mouse.move(box.x + box.width - 6, y);
  await expect.poll(left).toBeGreaterThan(0);
  await expect
    .poll(async () => (await edgeState(chips)).left >= (await edgeState(chips)).max - 1, {
      timeout: 15000,
    })
    .toBe(true);
  const end = await edgeState(chips);
  expect(end.mask).toContain('to left');
  await page.screenshot({ path: `${shots}/hover-right-end.png` });
  // Near the left end: back the other way; leaving the zone stops it where it is.
  await page.mouse.move(box.x + 8, y);
  await expect.poll(left).toBeLessThan(end.max - 40);
  await page.mouse.move(box.x + box.width / 2, y);
  const stopped = await left();
  await page.waitForTimeout(600);
  expect(await left()).toBe(stopped);
  await page.mouse.move(box.x + 8, y);
  await expect.poll(left).toBeLessThan(stopped);
  await page.mouse.move(box.x + box.width / 2, box.y - 60);
  const out = await left();
  await page.waitForTimeout(600);
  expect(await left()).toBe(out);
  // Moving the mouse asked the server nothing.
  expect(api).toEqual([]);
  // A chip under the faded right edge can be picked: a pressed button stops the row first.
  await chips.evaluate((row) => (row.scrollLeft = 0));
  await page.waitForTimeout(200);
  const x = box.x + box.width - 14;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const under = await page.evaluate(
    ([px, py]) => (document.elementFromPoint(px, py)?.closest('button') as HTMLElement | null)?.innerText,
    [x, y],
  );
  const held = await left();
  await page.waitForTimeout(400);
  expect(await left()).toBe(held);
  await page.mouse.up();
  expect(under).toBeTruthy();
  await expect(chips.getByRole('button', { name: under!, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(() => kinds.length).toBe(1);
  expect(api.filter((path) => path === '/api/d1/materials')).toHaveLength(1);
});

test('칩 줄: 터치 화면(375px)에서는 끝에 손을 대도 저절로 넘어가지 않는다', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  app = await authenticatedApp(page);
  await seed(app);
  await seedProducts(app, EXTRA);
  const { chips } = await openFixtures(page);
  expect(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(false);
  const box = (await chips.boundingBox())!;
  await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2);
  await page.waitForTimeout(800);
  expect((await edgeState(chips)).left).toBe(0);
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}/touch-375.png` });
  await app.dispose();
  app = undefined;
  await context.close();
});
