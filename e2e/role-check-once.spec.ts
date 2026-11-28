import { test, expect, type Page } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { seed } from './helpers/material-seed';

/**
 * The administrator role check runs once per tab (src/lib/admin-role.ts,
 * docs/d1-efficiency-round3-results-20261128.md, A): every 30 seconds while the tab is visible however
 * many components show it, nothing while it is hidden, and nothing for a dialog that opens or closes.
 */
let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(240000);

function roleChecks(page: Page) {
  const calls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/d1/role') calls.push(request.url());
  });
  return calls;
}
async function settle(page: Page, calls: unknown[]) {
  for (let seen = -1; seen !== calls.length;) {
    seen = calls.length;
    await page.waitForTimeout(2500);
  }
}
async function visibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => next === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    if (next === 'visible') window.dispatchEvent(new Event('focus'));
  }, state);
}

test('관리자 자재 목록: 화면을 열 때 한 번, 수정 창을 세 번 열고 닫아도 역할 요청이 없다', async ({
  page,
}) => {
  app = await authenticatedApp(page);
  await seed(app);
  await page.clock.install();
  const calls = roleChecks(page);
  await page.goto('/admin/materials');
  const edit = page.getByRole('button', { name: '정보 수정', exact: true }).first();
  await expect(edit).toBeVisible({ timeout: 45000 });
  await settle(page, calls);
  // Navigation, material manager, admin guard and links share one check (twice in development: StrictMode).
  expect(calls.length).toBeLessThanOrEqual(2);
  calls.splice(0);
  // The page's clock stands still meanwhile, so the 30-second check cannot come in between.
  await page.clock.pauseAt(Date.now() + 1000);
  for (let i = 0; i < 3; i++) {
    await edit.click();
    const form = page.getByRole('dialog', { name: '자재 수정', exact: true });
    await expect(form).toBeVisible();
    await page.waitForTimeout(1000);
    await form.getByRole('button', { name: '취소', exact: true }).last().click();
    await expect(form).toHaveCount(0);
  }
  await page.waitForTimeout(1500);
  expect(calls).toEqual([]);
  await page.clock.resume();
});

test('편집기: 보이는 5분은 30초마다 한 번, 숨긴 동안 없음, 다시 보이면 한 번', async ({ page }) => {
  app = await authenticatedApp(page);
  await page.clock.install();
  const calls = roleChecks(page);
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await settle(page, calls);
  calls.splice(0);
  for (let step = 0; step < 10; step++) {
    await page.clock.runFor(30_000);
    await page.waitForTimeout(400);
  }
  // (5 minutes ÷ 30 seconds), never more.
  expect(calls.length).toBeLessThanOrEqual(10);
  expect(calls.length).toBeGreaterThanOrEqual(8);
  calls.splice(0);
  await visibility(page, 'hidden');
  for (let step = 0; step < 4; step++) await page.clock.runFor(30_000);
  await page.waitForTimeout(1000);
  expect(calls).toEqual([]);
  // Shown and focused at once: one check.
  await visibility(page, 'visible');
  await page.waitForTimeout(1500);
  expect(calls).toHaveLength(1);
});
