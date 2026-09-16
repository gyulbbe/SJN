import { test, expect, type Page } from '@playwright/test';
import type { ProjectSummary } from '../src/lib/types';

// UI control-flow fixtures only. These requests do not prove real Google OAuth
// or deployed Cloudflare connectivity; real local bindings/auth have separate Vitest suites.
test.use({ channel: 'chrome', actionTimeout: 15000 });
const d1Status = { mode: 'd1', ready: true, reason: 'ready', authRequired: true };
const localStatus = { mode: 'local', ready: true, reason: 'local_environment', authRequired: false };
const member = {
  user: { id: '11111111-1111-4111-8111-111111111111', name: '테스트 회원', email: 'member@example.test' },
};
const privateProject: ProjectSummary = {
  id: '22222222-2222-4222-8222-222222222222',
  name: '내 계정의 서버 프로젝트',
  updatedAt: '2026-09-14T00:00:00.000Z',
  previewAssetId: '',
  activeDesignId: null,
  activeDesignRevision: 0,
  sharedRevision: 0,
};

async function blockModels(page: Page) {
  const modelRequests: string[] = [];
  await page.route(/(?:huggingface\.co|cdn-lfs|\.onnx(?:\?|$)|model(?:_quantized)?\.bin)/, async (route) => {
    modelRequests.push(route.request().url());
    await route.abort();
  });
  return modelRequests;
}
async function configured(page: Page, session: unknown = null) {
  await page.route('**/api/storage/status', (route) => route.fulfill({ json: d1Status }));
  await page.route('**/api/auth/get-session', (route) => route.fulfill({ json: session }));
}
async function privateList(page: Page) {
  const operations: string[] = [];
  await page.route('**/api/d1/projects', async (route) => {
    expect(route.request().headers()['x-sjn-user-id']).toBe(member.user.id);
    const body = route.request().postDataJSON() as { operation: string };
    operations.push(body.operation);
    if (body.operation !== 'list') throw new Error('A bootstrap screen must not alter a cloud project.');
    await route.fulfill({ json: [privateProject] });
  });
  return operations;
}
async function expectLocalHome(page: Page) {
  await expect(page.getByRole('heading', { name: '내 공간에서 시작하세요.' })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByText('로컬 작업 공간', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Google로 로그인', exact: true })).toHaveCount(0);
}

test('settings-free Next page opens the unchanged local workspace without authentication or model requests', async ({
  page,
}) => {
  const models = await blockModels(page);
  let authCalls = 0,
    cloudCalls = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/auth')) authCalls++;
    if (/\/api\/(d1|cloud)\//.test(new URL(request.url()).pathname)) cloudCalls++;
  });
  await page.goto('/');
  await expectLocalHome(page);
  expect(authCalls).toBe(0);
  expect(cloudCalls).toBe(0);
  expect(models).toEqual([]);
  const status = await page.request.get('/api/storage/status');
  expect(status.headers()['cache-control']).toBe('no-store');
  expect(await status.json()).toEqual(localStatus);
  await page.screenshot({ path: test.info().outputPath('local-workspace.png'), fullPage: true });
});

test('configured D1 shows Google sign-in, reports failure, and permits an explicit local start', async ({
  page,
}) => {
  const models = await blockModels(page);
  await configured(page);
  let signIns = 0,
    cloudCalls = 0;
  page.on('request', (req) => {
    if (req.url().includes('/api/d1/')) cloudCalls++;
  });
  await page.route('**/api/auth/sign-in/social', async (route) => {
    signIns++;
    expect(route.request().postDataJSON()).toMatchObject({ provider: 'google', callbackURL: '/' });
    await route.fulfill({ status: 503, json: { error: 'OAuth test failure' } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '공간미리 로그인' })).toBeVisible();
  await page.getByRole('button', { name: 'Google로 로그인', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Google 로그인 연결에 실패' })).toBeVisible();
  expect(signIns).toBe(1);
  expect(cloudCalls).toBe(0);
  await page.getByRole('button', { name: '로그인 없이 로컬로 시작' }).click();
  await expectLocalHome(page);
  expect(await page.evaluate(() => sessionStorage.getItem('sjn-workspace'))).toBe('local');
  expect(cloudCalls).toBe(0);
  expect(models).toEqual([]);
});

test('invalid readiness data falls back to local and explains why', async ({ page }) => {
  await page.route('**/api/storage/status', (route) =>
    route.fulfill({ json: { ...d1Status, mode: 'unknown-backend' } }),
  );
  let authCalls = 0;
  page.on('request', (req) => {
    if (req.url().includes('/api/auth/')) authCalls++;
  });
  await page.goto('/');
  await expectLocalHome(page);
  await expect(page.getByRole('status')).toContainText('서버 설정을 확인하지 못해');
  expect(authCalls).toBe(0);
});

test('the five-second bootstrap timeout stays local after a late successful response', async ({ page }) => {
  let attemptedLateResponse = false,
    authCalls = 0;
  page.on('request', (req) => {
    if (req.url().includes('/api/auth/')) authCalls++;
  });
  await page.route('**/api/storage/status', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 6500));
    attemptedLateResponse = true;
    await route.fulfill({ json: d1Status }).catch(() => {}); // The timed-out fetch may already be aborted.
  });
  await page.goto('/');
  await expectLocalHome(page);
  await expect(page.getByRole('status')).toContainText('서버 연결 확인 시간이 초과');
  await expect.poll(() => attemptedLateResponse, { timeout: 10000 }).toBe(true);
  await expectLocalHome(page);
  expect(authCalls).toBe(0);
});

test('an authenticated cloud workspace fetches only the project summaries and preserves local data', async ({
  page,
}) => {
  const models = await blockModels(page);
  await configured(page, member);
  const operations = await privateList(page);
  await page.goto('/');
  await expect(
    page.locator('.storage-badge').filter({ hasText: '클라우드 작업 공간' }).first(),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: privateProject.name })).toBeVisible();
  expect(operations.length).toBeGreaterThan(0);
  expect(operations.every((operation) => operation === 'list')).toBe(true);
  await page.screenshot({ path: test.info().outputPath('cloud-project-list-fixture.png'), fullPage: true });
  // Put a local-only marker into the existing local database, then verify switching
  // does not transfer it into the cloud project list or erase it.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('gongganmiri-v1', 1);
      open.onupgradeneeded = () => {
        for (const name of ['projects', 'materials', 'versions', 'assets'])
          open.result.createObjectStore(name, { keyPath: 'id' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('assets', 'readwrite');
      tx.objectStore('assets').put({
        id: 'local-preservation-marker',
        name: '로컬 원본 보존 확인',
        blob: new Blob(['preserve-me']),
        kind: 'original',
        width: 1,
        height: 1,
        mime: 'image/png',
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  const beforeLocal = operations.length;
  await page.getByRole('button', { name: '로컬 자료 열기', exact: true }).first().click();
  await expectLocalHome(page);
  await expect(page.getByRole('heading', { name: privateProject.name })).toHaveCount(0);
  const marker = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('gongganmiri-v1');
      req.onsuccess = () => resolve(req.result);
    });
    const record = await new Promise<{ blob: Blob }>((resolve) => {
      const req = db.transaction('assets').objectStore('assets').get('local-preservation-marker');
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    return record.blob.text();
  });
  expect(marker).toBe('preserve-me');
  expect(operations).toHaveLength(beforeLocal);
  expect(models).toEqual([]);
});

test('logout failure keeps the cloud workspace and successful logout removes its visible projects', async ({
  page,
}) => {
  let authenticated = true,
    failLogout = true,
    logoutCalls = 0;
  await page.route('**/api/storage/status', (route) => route.fulfill({ json: d1Status }));
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({ json: authenticated ? member : null }),
  );
  await privateList(page);
  await page.route('**/api/auth/sign-out', async (route) => {
    logoutCalls++;
    if (failLogout) await route.fulfill({ status: 503, json: { error: 'isolated logout failure' } });
    else {
      authenticated = false;
      await route.fulfill({ json: { success: true } });
    }
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: privateProject.name })).toBeVisible();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect.poll(() => logoutCalls).toBe(1);
  await expect(page.getByRole('alert').filter({ hasText: '로그아웃하지 못했어요' })).toBeVisible();
  await expect(page.getByRole('heading', { name: privateProject.name })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('sjn-workspace'))).not.toBe('local');
  failLogout = false;
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('heading', { name: '공간미리 로그인' })).toBeVisible();
  await expect(page.getByRole('heading', { name: privateProject.name })).toHaveCount(0);
});

test('session-expiry notification preserves the cloud screen and offers reauthentication', async ({
  page,
}) => {
  await configured(page, member);
  await privateList(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: privateProject.name })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('sjn-auth-expired')));
  await expect(page.getByRole('alert').filter({ hasText: '로그인이 만료됐어요' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Google로 다시 로그인' })).toBeVisible();
  await expect(page.getByRole('heading', { name: privateProject.name })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('sjn-workspace'))).not.toBe('local');
});
