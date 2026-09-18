import { expect, test, type Page, type Route } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { handleD1Request } from '../src/lib/d1';
import type { ProjectDocument } from '../src/lib/types';

test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(150000);

const draftKey = 'sjn:guest-draft:v1';
let app: AuthenticatedApp;
let externalCalls: string[];

test.beforeEach(async ({ page }) => {
  // Every API request is handled by an isolated Miniflare D1/R2 fixture.
  // Google and model hosts are intercepted; no external AI or OAuth is called.
  app = await authenticatedApp(page, { signedIn: false, admin: false });
  externalCalls = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      (url.pathname.startsWith('/api/') && /reconstruction|photoreal|diagnostics/.test(url.pathname)) ||
      (url.pathname.startsWith('/models/') && /\.(onnx|bin|safetensors|weights)(?:$|\?)/i.test(url.pathname))
    )
      externalCalls.push(url.pathname);
  });
});

test.afterEach(async () => {
  try {
    expect(externalCalls).toEqual([]);
  } finally {
    await app?.dispose();
  }
});

async function readDraft(
  page: Page,
): Promise<{ document: ProjectDocument; promotion?: { userId: string } } | null> {
  return page.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, draftKey);
}

async function createGuestRoom(page: Page, navigate = true) {
  if (navigate) await page.goto('/');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  const room = page.getByRole('dialog', { name: '공간 크기 설정' });
  await room.getByRole('spinbutton', { name: '가로 (m)' }).fill('3.2');
  await room.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/try$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  // Guest usage is initialized as a read migration. Persist an actual edit before taking
  // the baseline so recovery still compares every field of the frozen document exactly.
  await page.getByRole('textbox', { name: '프로젝트명', exact: true }).fill('복구 검증 공간');
  await expect.poll(async () => (await readDraft(page))?.document.name).toBe('복구 검증 공간');
  const before = (await readDraft(page))!.document;
  expect(before.designs[0].materialUsage?.version).toBe(1);
  return before;
}

async function loginThroughFixture(page: Page) {
  const origin = new URL(page.url()).origin;
  await page.route('**/api/auth/sign-in/social', (route) =>
    route.fulfill({
      json: { url: 'https://accounts.google.com/o/oauth2/auth?sjn-recovery-fixture=1' },
    }),
  );
  await page.route('https://accounts.google.com/**', async (route) => {
    app.signIn();
    await route.fulfill({ status: 302, headers: { location: origin + '/try?resume=1' } });
  });
  await page.getByRole('button', { name: '로그인 / 회원가입', exact: true }).first().click();
  await page.getByRole('button', { name: 'Google로 계속하기', exact: true }).click();
}

async function storedAssetIds() {
  const rows = await app.env.DB.prepare('SELECT id FROM d1_assets ORDER BY id').all<{ id: string }>();
  return rows.results.map((row) => row.id);
}
async function projectCount() {
  return (await app.env.DB.prepare('SELECT COUNT(*) AS n FROM d1_projects').first<{ n: number }>())!.n;
}
async function handleProjectRoute(route: Route) {
  const original = route.request();
  return handleD1Request(
    'projects',
    new Request(original.url(), {
      method: original.method(),
      headers: original.headers(),
      body: original.postData(),
    }),
    app.env,
    app.actor,
  );
}

// The first server attempt has not committed; the second must reuse the already uploaded images.
test('프로젝트 생성 실패 뒤 초안을 동결하고 같은 배경으로 저장을 재시도한다', async ({ page }) => {
  const before = await createGuestRoom(page);
  let createRequests = 0;
  await page.route('**/api/d1/projects', async (route) => {
    if (route.request().postDataJSON()?.operation !== 'create') return route.fallback();
    createRequests++;
    if (createRequests === 1)
      return route.fulfill({ status: 503, json: { error: '격리 검증: 프로젝트 저장 실패' } });
    return route.fallback();
  });
  await loginThroughFixture(page);
  await expect(page.getByRole('heading', { name: '프로젝트 저장을 마무리해 주세요' })).toBeVisible({
    timeout: 60000,
  });
  await expect(page.locator('.guest-setup').getByRole('alert')).toContainText('프로젝트 저장 실패');
  await expect(page.getByTestId('editor-canvas')).toHaveCount(0);
  expect((await readDraft(page))!.document).toEqual(before);
  expect((await readDraft(page))!.promotion?.userId).toBe(app.actor.id);
  expect(await projectCount()).toBe(0);
  const uploaded = await storedAssetIds();
  expect(uploaded).toHaveLength(2);

  await page.getByRole('button', { name: '저장 다시 시도', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/projects/' + before.id + '$'), { timeout: 60000 });
  expect(createRequests).toBe(2);
  expect(await projectCount()).toBe(1);
  expect(await storedAssetIds()).toEqual(uploaded);
  const saved = await app.project(before.id);
  expect(saved.ownerId).toBe(app.actor.id);
  expect(saved.shared.baseline).toEqual(before.shared.baseline);
  expect(saved.designs).toEqual(before.designs);
  expect(await readDraft(page)).toBeNull();
});

// The server has committed, but fetch fails. Reloading must confirm that exact project, not create again.
test('생성 응답을 잃어도 새로고침 뒤 이미 저장한 프로젝트를 확인하고 중복 생성하지 않는다', async ({
  page,
}) => {
  const before = await createGuestRoom(page);
  let createRequests = 0;
  await page.route('**/api/d1/projects', async (route) => {
    if (route.request().postDataJSON()?.operation !== 'create') return route.fallback();
    createRequests++;
    const response = await handleProjectRoute(route);
    expect(response.status, await response.clone().text()).toBe(200);
    await route.abort('failed');
  });
  await loginThroughFixture(page);
  await expect(page.getByRole('heading', { name: '프로젝트 저장을 마무리해 주세요' })).toBeVisible({
    timeout: 60000,
  });
  expect(await projectCount()).toBe(1);
  expect((await readDraft(page))!.document.id).toBe(before.id);
  expect((await readDraft(page))!.promotion?.userId).toBe(app.actor.id);
  await expect(page.getByTestId('editor-canvas')).toHaveCount(0);
  const uploaded = await storedAssetIds();

  await page.reload();
  await expect(page).toHaveURL(new RegExp('/projects/' + before.id + '$'), { timeout: 60000 });
  expect(createRequests).toBe(1);
  expect(await projectCount()).toBe(1);
  expect(await storedAssetIds()).toEqual(uploaded);
  const saved = await app.project(before.id);
  expect(saved.ownerId).toBe(app.actor.id);
  expect(saved.shared.baseline).toEqual(before.shared.baseline);
  expect(saved.designs).toEqual(before.designs);
  expect(await readDraft(page)).toBeNull();
});

test('손상된 체험 초안은 명시적으로 초기화하기 전까지 보존하고 초기화 뒤 새 공간을 만든다', async ({
  page,
}) => {
  await page.goto('/');
  const invalid = '{invalid guest draft';
  await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), {
    key: draftKey,
    value: invalid,
  });
  await page.goto('/try');
  await expect(page.locator('.guest-setup').getByRole('alert')).toContainText('체험 초안을 읽지 못했어요');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBe(invalid);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '체험 초기화', exact: true }).click();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBe(invalid);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '체험 초기화', exact: true }).click();
  await expect(page.locator('.guest-setup').getByRole('alert')).toHaveCount(0);
  expect(await readDraft(page)).toBeNull();
  const created = await createGuestRoom(page, false);
  expect(created.shared.baseline.room?.widthMm).toBe(3200);
  expect(await projectCount()).toBe(0);
});

test('로그인 화면도 손상 초안을 보존하고 복구 확인 없이 Google로 이동하지 않는다', async ({ page }) => {
  await page.goto('/');
  const raw = '{invalid guest draft';
  await page.evaluate(({ key, raw }) => sessionStorage.setItem(key, raw), { key: draftKey, raw });
  let signIns = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/sign-in/social') signIns++;
  });
  await page.goto('/login');
  await expect(page.locator('main').getByRole('alert')).toContainText('체험 초안을 읽지 못했어요');
  await page.getByRole('button', { name: 'Google로 계속하기', exact: true }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('체험 초안을 읽지 못했어요');
  expect(signIns).toBe(0);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBe(raw);
  await page.getByRole('link', { name: '← 체험 작업으로 돌아가기' }).click();
  await expect(page.locator('.guest-setup').getByRole('alert')).toContainText('체험 초안을 읽지 못했어요');
  await expect(page.getByRole('button', { name: '체험 초기화' })).toBeVisible();
});
