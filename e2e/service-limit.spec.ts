import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Page } from '@playwright/test';

// A spent Cloudflare daily limit, imitated by intercepting the routes' answers (no real limit, no AI
// call). The page's clock is Sunday 18 October 2026 12:00 in Korea; the limits come back at
// 00:00 UTC on the 19th, 09:00 in Korea: "내일 10월 19일(월) 오전 9시".
const NOW = new Date('2026-10-18T03:00:00Z');
const RESET = '2026-10-19T00:00:00.000Z';
const WHEN = '내일 10월 19일(월) 오전 9시';
const DB_LIMIT = {
  error: '오늘 서버 이용 한도를 모두 써서 로그인·저장·불러오기가 잠시 멈췄어요.',
  code: 'SERVICE_LIMIT',
  limit: { service: 'db-read', resetAt: RESET },
};
const AI_LIMIT = {
  error: 'Cloudflare AI 사용 한도를 모두 사용했어요. 한도가 갱신된 뒤 다시 시도해 주세요.',
  code: 'quota_exhausted',
  retryable: false,
  limit: { service: 'ai', resetAt: RESET },
};
const READY = { mode: 'd1', ready: true, reason: 'ready', authRequired: true };
const LIMITED = {
  mode: 'd1',
  ready: false,
  reason: 'daily_limit',
  authRequired: true,
  limit: DB_LIMIT.limit,
};

let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(180000);

/** The page's /api/ requests, by path. */
function apiRequests(page: Page) {
  const paths: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) paths.push(path);
  });
  return paths;
}
const counts = (paths: string[]) =>
  paths.reduce<Record<string, number>>((all, path) => ({ ...all, [path]: (all[path] ?? 0) + 1 }), {});
const banner = (page: Page) => page.getByTestId('service-limit-banner');
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('준비 검사가 하루 한도면 띠·로그인·잠금 화면이 언제 다시 되는지 말하고, 요청을 늘리지 않으며, 그 시각이 지나면 띠가 사라진다', async ({
  page,
}, info) => {
  await page.clock.install({ time: NOW });
  const paths = apiRequests(page);
  let limited = false;
  await page.route('**/api/storage/status', (route) => route.fulfill({ json: limited ? LIMITED : READY }));
  await page.route('**/api/auth/get-session', (route) => route.fulfill({ json: null }));
  const visit = async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '내 공간에서 시작하세요.', exact: true })).toBeVisible();
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: '로그인 / 회원가입', exact: true })).toBeVisible();
    await page.goto('/projects/' + crypto.randomUUID());
    await expect(page.getByRole('heading', { name: '로그인 / 회원가입', exact: true })).toBeVisible();
  };
  // The same pages while the database answers, then while its limit is spent.
  await visit();
  await expect(banner(page)).toHaveCount(0);
  const normal = counts(paths);
  paths.length = 0;
  limited = true;
  await visit();
  const message = `${WHEN} 이후 다시 접속해 주세요. 열려 있는 작업은 이 기기에 보관돼요.`;
  await expect(banner(page)).toContainText(
    '오늘 서버 이용 한도를 모두 써서 로그인·저장·불러오기가 잠시 멈췄어요.',
  );
  await expect(banner(page)).toContainText(message);
  // The locked account workspace says the same instead of "check the D1·R2 settings".
  await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
  await expect(page.getByText('로그인과 D1·R2 연결 설정을 먼저 확인해 주세요.')).toHaveCount(0);
  // No path the normal pages did not ask for, never more often.
  for (const [path, count] of Object.entries(counts(paths)))
    expect(count, path).toBeLessThanOrEqual(normal[path] ?? 0);
  await page.goto('/login');
  await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
  await expect(banner(page)).toHaveCount(1);
  await expect(banner(page).getByRole('status')).toHaveCount(1); // one line for the database
  await page.screenshot({ path: info.outputPath('limit-login-desktop.png') });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(banner(page)).toContainText(message);
  expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('limit-home-mobile.png') });
  // A minute left alone: no request at all (the notice never asks the server).
  paths.length = 0;
  await page.clock.runFor(60_000);
  expect(paths).toEqual([]);
  // Past 09:00 the notice goes by itself, still without a request.
  await page.clock.fastForward('21:01:00');
  await expect(banner(page)).toHaveCount(0);
  expect(paths).toEqual([]);
});

test('저장 중 하루 한도를 받으면 띠가 보이고 편집한 내용은 화면에 남는다', async ({ page }, info) => {
  app = await authenticatedApp(page);
  await page.clock.install({ time: NOW });
  await page.route('**/api/d1/projects', async (route) => {
    const body = route.request().postDataJSON() as { operation?: string } | null;
    if (body?.operation === 'save') return route.fulfill({ status: 503, json: DB_LIMIT });
    return route.fallback();
  });
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  const name = page.getByLabel('프로젝트명', { exact: true });
  await name.fill('한도 중에 고친 이름');
  await expect(banner(page)).toContainText(`${WHEN} 이후 다시 접속해 주세요.`, { timeout: 45000 });
  await expect(name).toHaveValue('한도 중에 고친 이름');
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await page.screenshot({ path: info.outputPath('limit-save-desktop.png') });
});

test('로그인 실패가 한도 응답이면 아이디·비밀번호 문구 대신 한도 문구를 보인다', async ({ page }) => {
  await page.clock.install({ time: NOW });
  await page.route('**/api/storage/status', (route) => route.fulfill({ json: READY }));
  await page.route('**/api/auth/get-session', (route) => route.fulfill({ json: null }));
  await page.route('**/api/auth/sign-in/username', (route) => route.fulfill({ status: 503, json: DB_LIMIT }));
  await page.goto('/login');
  await page.getByLabel('아이디', { exact: true }).fill('limituser');
  await page.getByLabel('비밀번호', { exact: true }).fill('limit-password-1');
  await page.getByRole('button', { name: '로그인하기', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: `${WHEN} 이후 다시 접속해 주세요.` });
  await expect(alert).toBeVisible();
  await expect(page.getByText('아이디 또는 비밀번호가 맞지 않아요.')).toHaveCount(0);
  await expect(banner(page)).toContainText(WHEN);
});

test('실사 변환이 AI 하루 한도를 받으면 띠와 버튼 옆에 언제 다시 되는지 보이고, 새로고침해도 남았다가 그 시각이 지나면 사라진다', async ({
  page,
}, info) => {
  app = await authenticatedApp(page);
  await page.clock.install({ time: NOW });
  let conversions = 0;
  await page.route('**/api/export/photoreal', (route) => {
    conversions++;
    return route.fulfill({ status: 429, json: AI_LIMIT });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
  await dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true }).click();
  const aiMessage = `오늘 AI 이용 한도를 모두 써서 AI 기능(실사 변환·방향 사진·설비 분석)을 쓸 수 없어요. ${WHEN} 이후 다시 시도해 주세요. 편집과 저장은 계속할 수 있어요.`;
  await expect(dialog.getByRole('alert')).toContainText(aiMessage);
  await expect(banner(page)).toContainText(aiMessage);
  await expect(dialog.getByTestId('ai-limit-hint')).toHaveText(`AI 한도 · ${WHEN} 이후`);
  // The button still works: the server refuses again, at no cost.
  await expect(dialog.getByRole('button', { name: 'AI 변환 · flux-2-klein-4b', exact: true })).toBeEnabled();
  expect(conversions).toBe(1);
  await page.screenshot({ path: info.outputPath('limit-ai-desktop.png') });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('limit-ai-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  // A reload keeps the notice (this browser remembers it until 09:00), with no AI request.
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(banner(page)).toContainText(aiMessage);
  expect(conversions).toBe(1);
  await page.clock.fastForward('21:01:00');
  await expect(banner(page)).toHaveCount(0);
  expect(conversions).toBe(1);
});
