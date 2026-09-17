import { test, expect, type Page } from '@playwright/test';
// UI contracts use intercepted sessions. Real local D1/R2 and auth checks have integration suites.
test.use({ channel: 'chrome', actionTimeout: 15000 });
const status = { mode: 'd1', ready: true, reason: 'ready', authRequired: true };
const member = {
  user: { id: '11111111-1111-4111-8111-111111111111', name: '테스트 회원', email: 'member@example.test' },
};
const project = {
  id: '22222222-2222-4222-8222-222222222222',
  name: '내 계정의 서버 프로젝트',
  updatedAt: '2026-09-14T00:00:00.000Z',
  previewAssetId: '',
  activeDesignId: null,
  activeDesignRevision: 0,
  sharedRevision: 0,
};
async function configured(page: Page, session: unknown = null) {
  await page.route('**/api/storage/status', (r) => r.fulfill({ json: status }));
  await page.route('**/api/auth/get-session', (r) => r.fulfill({ json: session }));
  await page.route('**/api/d1/role', (r) => r.fulfill({ json: { isAdmin: false } }));
}
async function list(page: Page) {
  const operations: string[] = [];
  await page.route('**/api/d1/projects', (r) => {
    expect(r.request().headers()['x-sjn-user-id']).toBe(member.user.id);
    const op = r.request().postDataJSON().operation;
    operations.push(op);
    expect(op).toBe('list');
    return r.fulfill({ json: [project] });
  });
  return operations;
}
async function blocked(page: Page) {
  await expect(page.getByRole('heading', { name: '공간미리 로그인' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /로컬로 시작|로컬 자료 열기/ })).toHaveCount(0);
}
test('설정 없는 Next 실행은 설정 안내만 표시하고 익명 편집이나 모델 실행을 하지 않는다', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  await page.goto('/');
  await blocked(page);
  await expect(page.getByRole('button', { name: 'Google로 시작하기', exact: true })).toBeDisabled();
  expect(requests.some((p) => p.startsWith('/api/d1/') || p.startsWith('/api/reconstruction/'))).toBe(false);
  const response = await page.request.get('/api/storage/status');
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toMatchObject({ mode: 'd1', ready: false, authRequired: true });
});
test('Google 연결 실패 후 재시도할 수 있지만 익명 모드로 전환하지 않는다', async ({ page }) => {
  await configured(page);
  let attempts = 0;
  await page.route('**/api/auth/sign-in/social', (r) => {
    attempts++;
    return r.fulfill({ status: 503, json: { error: 'isolated failure' } });
  });
  await page.goto('/');
  await blocked(page);
  await page.getByRole('button', { name: 'Google로 시작하기', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Google 로그인 연결에 실패' })).toBeVisible();
  expect(attempts).toBe(1);
  await blocked(page);
});
test('잘못된 준비 응답은 서비스 접근을 차단하고 재확인을 제공한다', async ({ page }) => {
  await page.route('**/api/storage/status', (r) => r.fulfill({ json: { ...status, mode: 'unknown' } }));
  await page.goto('/');
  await blocked(page);
  await expect(page.getByRole('status')).toContainText('서버 설정을 확인하지 못했어요');
  await expect(page.getByRole('button', { name: '로그인 상태 다시 확인' })).toBeVisible();
});
test('5초 준비 시간 초과 후 늦은 응답으로 익명 또는 계정 화면을 열지 않는다', async ({ page }) => {
  let late = false,
    auth = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/auth')) auth++;
  });
  await page.route('**/api/storage/status', async (r) => {
    await new Promise((resolve) => setTimeout(resolve, 6500));
    late = true;
    await r.fulfill({ json: status }).catch(() => {});
  });
  await page.goto('/');
  await blocked(page);
  await expect(page.getByRole('status')).toContainText('서버 연결 확인 시간이 초과');
  await expect.poll(() => late, { timeout: 10000 }).toBe(true);
  await blocked(page);
  expect(auth).toBe(0);
});
test('인증 후 서버 목록만 조회하고 기존 브라우저 데이터를 삭제하거나 업로드하지 않는다', async ({ page }) => {
  await configured(page, member);
  const operations = await list(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: project.name })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('gongganmiri-v1', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('assets', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const t = db.transaction('assets', 'readwrite');
      t.objectStore('assets').put({ id: 'preservation-marker', text: 'preserve-me' });
      t.oncomplete = () => resolve();
    });
    db.close();
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: project.name })).toBeVisible();
  const value = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('gongganmiri-v1');
      r.onsuccess = () => resolve(r.result);
    });
    const v = await new Promise<string>((resolve) => {
      const r = db.transaction('assets').objectStore('assets').get('preservation-marker');
      r.onsuccess = () => resolve(r.result.text);
    });
    db.close();
    return v;
  });
  expect(value).toBe('preserve-me');
  expect(operations.every((x) => x === 'list')).toBe(true);
  await expect(page.getByRole('button', { name: '로컬 자료 열기', exact: true })).toHaveCount(0);
});
test('로그아웃 실패 시 계정을 유지하며 성공하면 프로젝트 내용을 숨긴다', async ({ page }) => {
  let signedIn = true,
    fail = true;
  await configured(page, member);
  await list(page);
  await page.route('**/api/auth/get-session', (r) => r.fulfill({ json: signedIn ? member : null }));
  await page.route('**/api/auth/sign-out', (r) => {
    if (fail) return r.fulfill({ status: 503, json: { error: 'isolated failure' } });
    signedIn = false;
    return r.fulfill({ json: { success: true } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: project.name })).toBeVisible();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '로그아웃하지 못했어요' })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await blocked(page);
  await expect(page.getByRole('heading', { name: project.name })).toHaveCount(0);
});
test('세션 만료 후 서비스 내용을 숨기고 재인증을 요구한다', async ({ page }) => {
  await configured(page, member);
  await list(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: project.name })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('sjn-auth-expired')));
  await expect(page.getByRole('button', { name: 'Google로 다시 로그인' })).toBeVisible();
  await blocked(page);
  await expect(page.getByRole('heading', { name: project.name })).toHaveCount(0);
});
