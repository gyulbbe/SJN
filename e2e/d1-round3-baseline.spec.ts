import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { seed } from './helpers/material-seed';

/**
 * Round 3 of the D1 work (docs/prompts/d1-efficiency-round3.md, stage 0): how often each screen asks
 * the server, before anything changes. A measurement, not a check: it runs with SJN_D1_ROUND3=1 and
 * writes test-results/d1-round3/requests-<flow>.json. The isolated app answers /api/ in the test, so
 * these are the browser's requests; what one request costs in D1 is tests/d1-round3-baseline.test.ts.
 */
test.skip(!process.env.SJN_D1_ROUND3, 'measurement: SJN_D1_ROUND3=1');
const OUT = 'test-results/d1-round3';
mkdirSync(OUT, { recursive: true });
let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(300000);

/** An /api/ request by kind: asset metadata, raw bytes and list images are told apart. */
function record(page: Page) {
  const calls: { kind: string; id?: string }[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    let operation: string | undefined;
    try {
      operation = JSON.parse(request.postData() ?? 'null')?.operation;
    } catch {
      // a form upload
    }
    const id = url.searchParams.get('id') ?? undefined;
    let kind = url.pathname + (operation ? `#${operation}` : '');
    if (url.pathname === '/api/d1/assets' || url.pathname === '/api/admin/project-assets')
      kind +=
        url.searchParams.get('size') === 'list' ? '?list' : url.searchParams.has('raw') ? '?raw' : '?meta';
    calls.push({ kind, id });
  });
  return calls;
}
/** Per kind: requests, distinct ids and how many of them were asked more than once. */
function tally(calls: { kind: string; id?: string }[]) {
  const out: Record<string, { requests: number; ids?: number; repeatedIds?: number }> = {};
  for (const call of calls) {
    const row = (out[call.kind] ??= { requests: 0 });
    row.requests++;
  }
  for (const [kind, row] of Object.entries(out)) {
    const ids = calls.filter((call) => call.kind === kind && call.id).map((call) => call.id!);
    if (!ids.length) continue;
    const seen = new Map<string, number>();
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
    row.ids = seen.size;
    row.repeatedIds = [...seen.values()].filter((n) => n > 1).length;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
/** Waits until nothing new has been asked for three seconds. */
async function settle(page: Page, calls: unknown[]) {
  for (let seen = -1; seen !== calls.length;) {
    seen = calls.length;
    await page.waitForTimeout(3000);
  }
}
const results: Record<string, unknown> = {};
function keep(flow: string, step: string, calls: { kind: string; id?: string }[]) {
  const steps = (results[flow] ??= {}) as Record<string, unknown>;
  steps[step] = tally(calls);
  writeFileSync(`${OUT}/requests-${flow}.json`, JSON.stringify(steps, null, 2));
  calls.splice(0);
}
async function openEditor(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
}
/** The tab hidden or shown, the way the browser tells the page. */
async function visibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => next === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    if (next === 'visible') window.dispatchEvent(new Event('focus'));
  }, state);
}

test('공개 자재: 첫 쪽, 다음 쪽, 다른 화면에 갔다 돌아오기', async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false });
  await seed(app);
  const calls = record(page);
  await page.goto('/materials');
  const cards = page.locator('main [data-page-item]');
  await expect(cards).toHaveCount(48);
  await settle(page, calls);
  keep('public', '1-first-page', calls);
  await page.locator('[data-testid="load-more"]').scrollIntoViewIfNeeded();
  await expect(cards).toHaveCount(96);
  await settle(page, calls);
  keep('public', '2-next-page', calls);
  await page.goto('/');
  await page.goBack();
  await expect(cards.first()).toBeVisible();
  await settle(page, calls);
  keep('public', '3-back-again', calls);
});

test('로그인 뒤 홈 → 편집기 → 자재 서랍(위생도기)', async ({ page }) => {
  app = await authenticatedApp(page);
  await seed(app);
  const calls = record(page);
  await page.goto('/');
  await settle(page, calls);
  keep('editor', '1-home', calls);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await settle(page, calls);
  keep('editor', '2-editor-open', calls);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await settle(page, calls);
  keep('editor', '3-drawer-fixtures', calls);
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await settle(page, calls);
  keep('editor', '4-reload', calls);
});

test('편집기를 연 채 5분, 그다음 탭 숨김 2분과 다시 보이기', async ({ page }) => {
  app = await authenticatedApp(page);
  await seed(app);
  await page.clock.install();
  const calls = record(page);
  await openEditor(page);
  await settle(page, calls);
  calls.splice(0);
  // Thirty seconds at a time, each answer back before the next: a real tab's pace.
  for (let step = 0; step < 10; step++) {
    await page.clock.runFor(30_000);
    await page.waitForTimeout(400);
  }
  keep('idle', '1-visible-5min', calls);
  await visibility(page, 'hidden');
  await page.clock.runFor(2 * 60_000);
  await page.waitForTimeout(2000);
  keep('idle', '2-hidden-2min', calls);
  await visibility(page, 'visible');
  await page.waitForTimeout(3000);
  keep('idle', '3-shown-again', calls);
});

test('관리자 자재 목록 → 자재 수정 창 열기·닫기 3회', async ({ page }) => {
  app = await authenticatedApp(page);
  await seed(app);
  const calls = record(page);
  await page.goto('/admin/materials');
  const edit = page.getByRole('button', { name: '정보 수정', exact: true }).first();
  await expect(edit).toBeVisible({ timeout: 45000 });
  await settle(page, calls);
  keep('admin', '1-list', calls);
  for (let i = 0; i < 3; i++) {
    await edit.click();
    const form = page.getByRole('dialog', { name: '자재 수정', exact: true });
    await expect(form).toBeVisible();
    await page.waitForTimeout(1500);
    await form.getByRole('button', { name: '취소', exact: true }).last().click();
    await expect(form).toHaveCount(0);
  }
  await settle(page, calls);
  keep('admin', '2-edit-open-close-x3', calls);
});

test('프로젝트 저장 1회, 프로젝트 삭제 1회(정리 실행)', async ({ page }) => {
  app = await authenticatedApp(page);
  await seed(app);
  const calls = record(page);
  await openEditor(page);
  await settle(page, calls);
  calls.splice(0);
  await page.getByLabel('프로젝트명', { exact: true }).fill('3차 측정 프로젝트');
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  await settle(page, calls);
  keep('project', '1-save', calls);
  await page.goto('/');
  const remove = page.getByRole('button', { name: '3차 측정 프로젝트 삭제', exact: true });
  await expect(remove).toBeVisible({ timeout: 30000 });
  await settle(page, calls);
  calls.splice(0);
  page.once('dialog', (dialog) => void dialog.accept());
  await remove.click();
  await expect(remove).toHaveCount(0, { timeout: 30000 });
  await settle(page, calls);
  keep('project', '2-delete', calls);
});
