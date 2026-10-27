import { mkdirSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { PRODUCTS, seed, TILES } from './helpers/material-seed';
import { getActiveDesign } from '../src/lib/designs';
import type { ProjectDocument } from '../src/lib/types';

/**
 * Paged material lists in the browser (docs/material-paging-results-20261022.md): the public list, the
 * editor drawer, the administrator library and the guest drawer read one page at a time, load the next
 * when its end scrolls into view or "더 보기" is pressed, ask for images only of cards on screen, and
 * call each API as often as the d1-query-budget counts say.
 */
const shots = 'test-results/material-paging';
mkdirSync(shots, { recursive: true });
let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(300000);

type Call = { path: string; operation?: string; search: string; id?: string };
function record(page: Page) {
  const calls: Call[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    let operation: string | undefined;
    try {
      operation = JSON.parse(request.postData() ?? 'null')?.operation;
    } catch {
      // a form upload
    }
    calls.push({
      path: url.pathname,
      operation,
      search: url.search,
      // A metadata read or a card's list image (raw bytes with size=list) is that image's request.
      ...(url.searchParams.has('raw') && url.searchParams.get('size') !== 'list'
        ? {}
        : { id: url.searchParams.get('id') ?? undefined }),
    });
  });
  return calls;
}
const count = (calls: Call[], path: string, operation?: string) =>
  calls.filter((call) => call.path === path && (!operation || call.operation === operation)).length;
/** Cards whose box is on screen (inside the viewport and their scrolling list). */
async function onScreen(cards: Locator) {
  return cards.evaluateAll(
    (nodes) =>
      nodes.filter((node) => {
        const box = node.getBoundingClientRect();
        let parent = node.parentElement;
        while (parent) {
          const style = getComputedStyle(parent);
          if (/(auto|scroll)/.test(style.overflowY)) {
            const clip = parent.getBoundingClientRect();
            if (box.bottom <= clip.top || box.top >= clip.bottom) return false;
          }
          parent = parent.parentElement;
        }
        return box.bottom > 0 && box.top < innerHeight && box.width > 0;
      }).length,
  );
}
/** Waits until the page has asked nothing for three seconds (what opening it asks is done). */
async function settle(page: Page, calls: Call[]) {
  for (let seen = -1; seen !== calls.length;) {
    seen = calls.length;
    await page.waitForTimeout(3000);
  }
}
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}

test('공개 자재: 첫 쪽·자동·더 보기·끝·검색·분류·오류 다시 시도·375px·요청 수', async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false });
  await seed(app);
  const calls = record(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/materials');
  const cards = page.locator('main [data-page-item]');
  const summary = page.getByRole('status').filter({ hasText: '전체' });
  await expect(cards).toHaveCount(48);
  await expect(summary).toContainText(`전체 ${TILES + PRODUCTS}개 중 48개`);
  await page.waitForTimeout(800);
  // Opening asks for the first page once (twice in development: StrictMode mounts effects twice).
  expect(count(calls, '/api/catalog/materials')).toBeLessThanOrEqual(2);
  const opened = count(calls, '/api/catalog/materials');
  // Images only for cards on screen.
  expect(count(calls, '/api/catalog/images')).toBeLessThanOrEqual(await onScreen(cards));
  expect(count(calls, '/api/catalog/images')).toBeGreaterThan(0);
  await page.screenshot({ path: `${shots}/public-desktop.png` });
  // The end of the list scrolls into view: the next page comes by itself (once).
  await page.locator('[data-testid="load-more"]').scrollIntoViewIfNeeded();
  await expect(cards).toHaveCount(96);
  await expect(summary).toContainText('중 96개');
  // The keyboard reaches the rest with "더 보기"; the focus goes to the first new card.
  const more = page.getByRole('button', { name: '더 보기', exact: true });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(cards).toHaveCount(TILES + PRODUCTS);
  await expect(cards.nth(96)).toBeFocused();
  await expect(page.getByText('목록의 끝이에요.', { exact: true })).toBeVisible();
  // The page that scrolled into view and "더 보기": one request each.
  expect(count(calls, '/api/catalog/materials') - opened).toBe(2);
  // Search, a category and a facet ask the server for their first page.
  await page.getByLabel('자재 검색', { exact: true }).fill('세면대');
  await expect(cards).toHaveCount(PRODUCTS);
  await expect(summary).toContainText(`전체 ${PRODUCTS}개 중 ${PRODUCTS}개`);
  await page.getByLabel('자재 검색', { exact: true }).fill('');
  await page.getByLabel('제품 종류').selectOption('tile');
  await expect(summary).toContainText(`전체 ${TILES}개 중 48개`);
  await page.getByRole('button', { name: /^색상/ }).click();
  await page
    .getByRole('group', { name: '색상' })
    .getByRole('checkbox', { name: '차콜', exact: true })
    .check();
  const charcoal = Math.ceil((TILES - 2) / 3);
  await expect(summary).toContainText(`전체 ${charcoal}개 중 ${Math.min(48, charcoal)}개`);
  // A failed page waits for "다시 시도" (no automatic retry).
  await page.getByRole('button', { name: '조건 초기화', exact: true }).click();
  await expect(cards).toHaveCount(48);
  let failed = 0;
  await page.route(
    (url) => url.pathname === '/api/catalog/materials' && url.searchParams.has('cursor'),
    async (route) => {
      failed++;
      await route.fulfill({ status: 503, json: { error: '검증용 연결 오류' } });
    },
    { times: 1 },
  );
  // The end of the list scrolls into view; that page fails.
  await page.locator('[data-testid="load-more"]').scrollIntoViewIfNeeded();
  await expect(page.getByRole('alert').filter({ hasText: '검증용 연결 오류' })).toBeVisible();
  await page.waitForTimeout(1500);
  expect(failed).toBe(1);
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(cards).toHaveCount(96);
  // A phone.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => scrollTo(0, 0));
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}/public-375.png` });
  // Nothing more is asked while the page sits still for a minute.
  await settle(page, calls);
  const before = calls.length;
  await page.waitForTimeout(60000);
  expect(calls.slice(before).filter((call) => !call.path.startsWith('/api/auth/'))).toEqual([]);
});

test('편집기 서랍: 탭·스크롤·고르기·저장 뒤 다시 열기(묶음 읽기)·요청 수', async ({ page }) => {
  app = await authenticatedApp(page);
  const rows = await seed(app);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  const calls = record(page);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  const panel = page.locator('aside.catalog-panel');
  const tiles = panel.locator('button.material-tile');
  const floor = rows.filter((row) => row.category === 'tile' && row.usage !== 'wall');
  await expect(tiles).toHaveCount(48);
  await page.waitForTimeout(800);
  const opened = calls.length;
  // Images only for cards on screen (the room's own background images aside).
  const catalogImages = new Set(rows.map((row) => row.assetId));
  const cardImages = calls.filter((call) => call.path === '/api/d1/assets' && catalogImages.has(call.id!));
  expect(cardImages.length).toBeLessThanOrEqual(await onScreen(tiles));
  expect(cardImages.length).toBeGreaterThan(0);
  // One metadata request per image (the same image is never asked twice).
  expect(new Set(cardImages.map((call) => call.id)).size).toBe(cardImages.length);
  expect(count(calls, '/api/d1/materials', 'list')).toBe(0);
  expect(count(calls, '/api/d1/materials', 'page')).toBe(1);
  // Scrolling the list loads the rest of the tab.
  await panel.locator('.catalog-grid').evaluate((grid) => grid.scrollTo(0, grid.scrollHeight));
  await expect(tiles).toHaveCount(floor.length);
  await expect(panel.getByText('목록의 끝이에요.', { exact: true })).toBeVisible();
  // Another tab is another first page.
  await panel.getByRole('button', { name: '위생도기', exact: true }).click();
  await expect(tiles).toHaveCount(PRODUCTS);
  await panel.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await expect(tiles).toHaveCount(48);
  // Picking reads that one version, then applies it as before.
  const picked = floor.at(-1)!;
  await panel.getByRole('textbox', { name: '편집기 자재 검색' }).fill(picked.name);
  await expect(tiles).toHaveCount(1);
  await tiles.first().click();
  await expect(tiles.first()).toHaveAttribute('aria-pressed', 'true');
  expect(count(calls, '/api/d1/materials', 'getVersions')).toBe(1);
  await page.keyboard.press('Control+s');
  await expect(page.getByText('클라우드에 저장됨', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  const projectId = page.url().split('/').at(-1)!;
  const saved: ProjectDocument = await app.project(projectId);
  expect(getActiveDesign(saved)!.scene.surfaces.some((s) => s.materialVersionId === picked.versionId)).toBe(
    true,
  );
  // Reopening reads the scene's versions in one request, and the drawer's first page.
  calls.length = 0;
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(tiles).toHaveCount(48);
  await page.waitForTimeout(800);
  // One request for every version the scenes use (twice in development: StrictMode runs the
  // editor's load effect twice on mount), never one per version or the whole list.
  expect(count(calls, '/api/d1/materials', 'getVersions')).toBeGreaterThanOrEqual(1);
  expect(count(calls, '/api/d1/materials', 'getVersions')).toBeLessThanOrEqual(2);
  expect(count(calls, '/api/d1/materials', 'getVersion')).toBe(0);
  expect(count(calls, '/api/d1/materials', 'list')).toBe(0);
  expect(count(calls, '/api/d1/materials', 'page')).toBe(1);
  // A minute without input: no material or image requests (the role check may poll).
  await settle(page, calls);
  const quiet = calls.length;
  await page.waitForTimeout(60000);
  expect(
    calls
      .slice(quiet)
      .filter((call) => call.path !== '/api/d1/role' && !call.path.startsWith('/api/auth/'))
      .map((call) => call.path),
  ).toEqual([]);
  expect(calls.slice(quiet).filter((call) => call.path === '/api/d1/role').length).toBeLessThanOrEqual(3);
  void opened;
});

test('관리자 자재: 첫 쪽·탭 개수·활성 전환은 그 카드만 바꾼다', async ({ page }) => {
  app = await authenticatedApp(page);
  await seed(app);
  await page.setViewportSize({ width: 1440, height: 900 });
  const calls = record(page);
  await page.goto('/admin/materials');
  const cards = page.locator('main article');
  await expect(cards).toHaveCount(48);
  const tab = page.getByRole('button', { name: /^전체 자재/ });
  await expect(tab).toContainText(String(TILES + PRODUCTS));
  const first = await cards.first().locator('button[class*="cardTitle"]').innerText();
  const pages = count(calls, '/api/d1/materials', 'page');
  await cards
    .first()
    .getByRole('button', { name: new RegExp(`${first} 비활성화`) })
    .click();
  await expect(page.getByRole('status').filter({ hasText: '비활성화했어요' })).toBeVisible();
  await expect(cards.filter({ hasText: first })).toHaveCount(0);
  await expect(tab).toContainText(String(TILES + PRODUCTS - 1));
  expect(count(calls, '/api/d1/materials', 'setActive')).toBe(1);
  expect(count(calls, '/api/d1/materials', 'page')).toBe(pages);
  await page.getByRole('checkbox', { name: '비활성 자재' }).check();
  await expect(cards).toHaveCount(1);
  await page.setViewportSize({ width: 375, height: 812 });
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}/library-375.png` });
});

test('정렬·우선순위: 정렬을 바꾸면 첫 쪽만 다시 받고, 관리자 우선순위는 그 카드만 바꾼 뒤 모든 목록에 반영된다', async ({
  page,
}) => {
  app = await authenticatedApp(page);
  await seed(app);
  await page.setViewportSize({ width: 1440, height: 900 });
  const calls = record(page);
  await page.goto('/admin/materials');
  const cards = page.locator('main article');
  const first = cards.first().locator('button[class*="cardTitle"]');
  const order = page.locator('main').getByLabel('정렬', { exact: true });
  await expect(cards).toHaveCount(48);
  // No priority yet: the default order is by name (세면대 before 타일).
  await expect(first).toHaveText('페이징 세면대 110');
  await settle(page, calls);
  let pages = count(calls, '/api/d1/materials', 'page');
  // Each order is one first page.
  for (const [sort, name] of [
    ['newest', '페이징 세면대 129'],
    ['nameDesc', '페이징 타일 109'],
    ['name', '페이징 세면대 110'],
    ['priority', '페이징 세면대 110'],
  ] as const) {
    await order.selectOption(sort);
    await expect(first).toHaveText(name);
    await page.waitForTimeout(300);
    expect(count(calls, '/api/d1/materials', 'page'), sort).toBe(++pages);
  }
  // A priority: Enter saves once (leaving the field after it saves nothing more), the card stays.
  const priority = (name: string) => cards.filter({ hasText: name }).getByLabel(`${name} 우선순위`);
  await priority('페이징 타일 020').fill('1');
  await priority('페이징 타일 020').press('Enter');
  await expect(page.getByText('페이징 타일 020의 우선순위를 1(으)로 정했어요.')).toBeVisible();
  await priority('페이징 타일 020').blur();
  await priority('페이징 타일 000').fill('2');
  await priority('페이징 타일 000').blur();
  await expect(page.getByText('페이징 타일 000의 우선순위를 2(으)로 정했어요.')).toBeVisible();
  // Not a number from 1 to 9999: nothing is sent.
  await priority('페이징 타일 001').fill('0');
  await priority('페이징 타일 001').press('Enter');
  await expect(priority('페이징 타일 001')).toHaveAttribute('aria-invalid', 'true');
  await priority('페이징 타일 001').press('Escape');
  expect(count(calls, '/api/d1/materials', 'setPriority')).toBe(2);
  expect(count(calls, '/api/d1/materials', 'page')).toBe(pages);
  await expect(first).toHaveText('페이징 세면대 110');
  // "새 순서 보기": the first page once, the numbered ones first.
  await page.getByRole('button', { name: '새 순서 보기', exact: true }).click();
  await expect(first).toHaveText('페이징 타일 020');
  await expect(cards.nth(1).locator('button[class*="cardTitle"]')).toHaveText('페이징 타일 000');
  await expect(priority('페이징 타일 020')).toHaveValue('1');
  expect(count(calls, '/api/d1/materials', 'page')).toBe(++pages);
  await expect(page.getByRole('button', { name: '새 순서 보기', exact: true })).toHaveCount(0);
  await cards.first().screenshot({ path: `${shots}/library-priority-card.png` });
  await page.setViewportSize({ width: 375, height: 812 });
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}/library-order-375.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  // The public list shows the same order by default; another order is one request.
  await page.goto('/materials');
  const publicCards = page.locator('main [data-page-item]');
  await expect(publicCards).toHaveCount(48);
  await expect(publicCards.nth(0).locator('h2')).toHaveText('페이징 타일 020');
  await expect(publicCards.nth(1).locator('h2')).toHaveText('페이징 타일 000');
  await settle(page, calls);
  const publicPages = count(calls, '/api/catalog/materials');
  await page.getByLabel('정렬', { exact: true }).selectOption('newest');
  await expect(publicCards.nth(0).locator('h2')).toHaveText('페이징 세면대 129');
  await page.waitForTimeout(300);
  expect(count(calls, '/api/catalog/materials')).toBe(publicPages + 1);
  // 조건 초기화 keeps the order.
  await page.getByLabel('제품 종류').selectOption('tile');
  await expect(publicCards.nth(0).locator('h2')).toHaveText('페이징 타일 109');
  await page.getByRole('button', { name: '조건 초기화', exact: true }).click();
  await expect(publicCards.nth(0).locator('h2')).toHaveText('페이징 세면대 129');
  await expect(page.getByLabel('정렬', { exact: true })).toHaveValue('newest');
  await page.setViewportSize({ width: 375, height: 812 });
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}/public-order-375.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  // The editor drawer: the floor tab by priority, another order is one first page, and it stays
  // when the tab changes.
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  const panel = page.locator('aside.catalog-panel');
  const tiles = panel.locator('button.material-tile');
  await expect(tiles).toHaveCount(48);
  await expect(tiles.nth(0)).toHaveAttribute('title', '페이징 타일 020 적용');
  await expect(tiles.nth(1)).toHaveAttribute('title', '페이징 타일 000 적용');
  await expect(tiles.nth(2)).toHaveAttribute('title', '페이징 타일 002 적용');
  await settle(page, calls);
  const drawerPages = count(calls, '/api/d1/materials', 'page');
  await panel.getByLabel('정렬', { exact: true }).selectOption('nameDesc');
  await expect(tiles.nth(0)).toHaveAttribute('title', '페이징 타일 108 적용');
  await page.waitForTimeout(300);
  expect(count(calls, '/api/d1/materials', 'page')).toBe(drawerPages + 1);
  await panel.getByRole('button', { name: '위생도기', exact: true }).click();
  await expect(tiles.nth(0)).toHaveAttribute('title', '페이징 세면대 129 적용');
  await expect(panel.getByLabel('정렬', { exact: true })).toHaveValue('nameDesc');
  await page.screenshot({ path: `${shots}/drawer-order.png` });
});

test('게스트 서랍: 공개 배치의 쪽을 받고 고른 자재는 체험 초안에 남는다', async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false });
  const rows = await seed(app);
  await page.setViewportSize({ width: 375, height: 812 });
  const calls = record(page);
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
  await expect(tiles).toHaveCount(48);
  // Never the whole public list.
  expect(calls.filter((call) => call.path === '/api/catalog/placement' && !call.search)).toEqual([]);
  const wanted = rows.filter((row) => row.category === 'tile' && row.usage !== 'wall').at(-1)!;
  await panel.getByRole('textbox', { name: '편집기 자재 검색' }).fill(wanted.name);
  await expect(tiles).toHaveCount(1);
  await tiles.first().click();
  await expect
    .poll(async () =>
      page.evaluate(
        (id) => (sessionStorage.getItem('sjn:guest-draft:v1') ?? '').includes(`"materialVersionId":"${id}"`),
        wanted.versionId,
      ),
    )
    .toBe(true);
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}/guest-375.png` });
  // Reopening checks only the used material, by id.
  calls.length = 0;
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect.poll(() => calls.filter((call) => call.search.startsWith('?ids=')).length).toBeGreaterThan(0);
  expect(calls.filter((call) => call.path === '/api/catalog/placement' && !call.search)).toEqual([]);
});
