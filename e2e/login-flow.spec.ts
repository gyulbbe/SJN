import { test, expect, type Page } from '@playwright/test';

test.use({ channel: 'chrome', actionTimeout: 15000 });

const cloudStatus = { mode: 'd1', ready: true, reason: 'ready', authRequired: true };
const memberId = '6f9b144a-4f79-4d24-a9a5-d4bc5ec06073';

/** UI-only contract tests. Google navigation and every API response are intercepted;
 * these are not evidence of a live Google signup or an operational D1 connection. */
async function mockLogin(
  page: Page,
  options: {
    signedIn?: boolean;
    firstFailure?: boolean;
    invalidRedirect?: boolean;
    local?: boolean;
    google?: boolean;
  } = {},
) {
  let signedIn = !!options.signedIn;
  let appOrigin = '';
  let releaseFirst: () => void = () => {};
  const firstResponse = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const calls: { path: string; body: unknown }[] = [];
  const googleNavigations: string[] = [];
  await page.route('**/*', async (route) => {
    const target = new URL(route.request().url());
    if (target.hostname === 'accounts.google.com') {
      googleNavigations.push(target.href);
      const callback = new URL('/api/auth/callback/google?code=ui-test-only', appOrigin);
      // Route interception only runs for the first URL in an HTTP redirect chain.
      // A fixture document starts a new navigation so the callback stays mocked too.
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><title>Google UI test substitute</title><script>location.replace(' +
          JSON.stringify(callback.href) +
          ')</script>',
      });
    }
    if (!['127.0.0.1', 'localhost'].includes(target.hostname)) return route.abort();
    return route.continue();
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({ path, body: request.postData() ? request.postDataJSON() : null });
    switch (path) {
      case '/api/storage/status':
        appOrigin = new URL(request.url()).origin;
        return route.fulfill({
          json: options.local
            ? { mode: 'local', ready: true, reason: 'local_environment', authRequired: false }
            : { ...cloudStatus, ...(options.google === false ? { googleSignIn: false } : {}) },
        });
      case '/api/auth/get-session':
        return route.fulfill({
          json: signedIn ? { user: { id: memberId, name: '테스트 회원', email: 'ui@example.test' } } : null,
        });
      case '/api/auth/sign-in/social': {
        if (options.firstFailure && calls.filter((item) => item.path === path).length === 1) {
          await firstResponse;
          return route.fulfill({ status: 503, json: { error: 'Test-only failure' } });
        }
        return route.fulfill({
          json: {
            url: options.invalidRedirect
              ? 'https://example.invalid/untrusted'
              : 'https://accounts.google.com/o/oauth2/v2/auth?client_id=ui-test-only',
          },
        });
      }
      case '/api/auth/sign-up/email': {
        const body = request.postDataJSON() as { username: string };
        if (body.username === 'taken_id')
          return route.fulfill({ status: 400, json: { code: 'USERNAME_IS_ALREADY_TAKEN', message: 'taken' } });
        signedIn = true;
        return route.fulfill({ json: { token: 'ui-test-only', user: { id: memberId } } });
      }
      case '/api/auth/sign-in/username': {
        const body = request.postDataJSON() as { password: string };
        if (body.password !== 'correct-pass')
          return route.fulfill({
            status: 401,
            json: { code: 'INVALID_USERNAME_OR_PASSWORD', message: 'Invalid username or password' },
          });
        signedIn = true;
        return route.fulfill({ json: { token: 'ui-test-only', user: { id: memberId } } });
      }
      case '/api/auth/callback/google':
        signedIn = true;
        return route.fulfill({ status: 302, headers: { location: '/' } });
      case '/api/d1/role':
        return route.fulfill({ json: { isAdmin: false } });
      case '/api/d1/projects':
        return route.fulfill({ json: [] });
      default:
        return route.fulfill({ status: 403, json: { error: 'Unexpected API request blocked by test.' } });
    }
  });
  return { calls, googleNavigations, releaseFirst: () => releaseFirst() };
}

test('Google 연결 진행 중 중복 실행을 막고 실패 후 재시도하여 내 프로젝트로 이동한다 (인증 모의)', async ({
  page,
}) => {
  const mock = await mockLogin(page, { firstFailure: true });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '로그인 / 회원가입', exact: true })).toBeVisible();
  await expect(page.getByText('처음 로그인하면 회원가입이 함께 진행돼요.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Google로 계속하기', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Google 연결 중…', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Google 계정 선택 화면');
  expect(mock.calls.filter((call) => call.path === '/api/auth/sign-in/social')).toHaveLength(1);
  mock.releaseFirst();
  await expect(page.locator('main [role="alert"]')).toContainText('Google 로그인 연결에 실패');
  await page.getByRole('button', { name: 'Google로 계속하기', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '내 공간에서 시작하세요.' })).toBeVisible();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true, includeHidden: true })).toHaveCount(
    1,
  );
  expect(mock.calls.filter((call) => call.path === '/api/auth/sign-in/social')).toHaveLength(2);
  expect(mock.googleNavigations).toHaveLength(1);
  expect(mock.calls.find((call) => call.path === '/api/auth/sign-in/social')?.body).toEqual({
    provider: 'google',
    callbackURL: '/',
    errorCallbackURL: '/login?authError=google',
  });
  await expect.poll(() => mock.calls.some((call) => call.path === '/api/d1/projects')).toBe(true);
  const projectRequest = mock.calls.find((call) => call.path === '/api/d1/projects');
  expect(projectRequest?.body).toMatchObject({ operation: 'list' });
  expect(mock.calls.some((call) => /reconstruction|photoreal|assets/.test(call.path))).toBe(false);
});

test('Google 없이 아이디로 회원가입하고 내 프로젝트로 이동한다 (인증 모의)', async ({ page }) => {
  const mock = await mockLogin(page, { google: false });
  await page.goto('/login');
  await expect(page.getByRole('textbox', { name: '아이디', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Google로 계속하기', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '회원가입', exact: true }).click();
  await expect(page.getByRole('button', { name: '회원가입', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: '아이디', exact: true }).fill('taken_id');
  await page.getByLabel('비밀번호', { exact: true }).fill('password-1');
  await page.getByLabel('비밀번호 확인', { exact: true }).fill('password-2');
  await page.getByRole('button', { name: '회원가입하기', exact: true }).click();
  await expect(page.locator('main [role="alert"]')).toHaveText('비밀번호 확인이 일치하지 않아요.');
  expect(mock.calls.some((call) => call.path === '/api/auth/sign-up/email')).toBe(false);
  await page.getByLabel('비밀번호 확인', { exact: true }).fill('password-1');
  await page.getByRole('button', { name: '회원가입하기', exact: true }).click();
  await expect(page.locator('main [role="alert"]')).toContainText('이미 사용 중인 아이디예요');
  await page.getByRole('textbox', { name: '아이디', exact: true }).fill('new_member');
  await page.getByRole('button', { name: '회원가입하기', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '내 공간에서 시작하세요.' })).toBeVisible();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true, includeHidden: true })).toHaveCount(
    1,
  );
  expect(mock.calls.filter((call) => call.path === '/api/auth/sign-up/email').at(-1)?.body).toEqual({
    username: 'new_member',
    password: 'password-1',
  });
  expect(mock.googleNavigations).toHaveLength(0);
});

test('아이디 로그인 실패를 안내하고 다시 시도해 로그인한다 (인증 모의)', async ({ page }) => {
  const mock = await mockLogin(page);
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Google로 계속하기', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '로그인하기', exact: true }).click();
  await expect(page.locator('main [role="alert"]')).toHaveText('아이디와 비밀번호를 입력해 주세요.');
  await page.getByRole('textbox', { name: '아이디', exact: true }).fill('member_1');
  await page.getByLabel('비밀번호', { exact: true }).fill('wrong-pass');
  await page.getByRole('button', { name: '로그인하기', exact: true }).click();
  await expect(page.locator('main [role="alert"]')).toHaveText('아이디 또는 비밀번호가 맞지 않아요.');
  await expect(page.getByLabel('비밀번호', { exact: true })).toBeEnabled();
  await page.getByLabel('비밀번호', { exact: true }).fill('correct-pass');
  await page.getByLabel('비밀번호', { exact: true }).press('Enter');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '내 공간에서 시작하세요.' })).toBeVisible();
  expect(mock.calls.filter((call) => call.path === '/api/auth/sign-in/username')).toHaveLength(2);
});

test('기존 세션으로 로그인 화면을 다시 열면 내 프로젝트로 이동한다 (세션 모의)', async ({ page }) => {
  const mock = await mockLogin(page, { signedIn: true });
  await page.goto('/login');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '내 공간에서 시작하세요.' })).toBeVisible();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true, includeHidden: true })).toHaveCount(
    1,
  );
  expect(mock.calls.some((call) => call.path === '/api/auth/sign-in/social')).toBe(false);
  expect(mock.googleNavigations).toHaveLength(0);
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`Google 동의 취소를 설명하고 다시 시작할 수 있다 · ${viewport.width}px (콜백 모의)`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const mock = await mockLogin(page);
    // Actual Better Auth callback appends error=access_denied to errorCallbackURL.
    await page.goto('/login?authError=google&error=access_denied&error_description=PROVIDER_RAW_TEXT');
    await expect(page.locator('main [role="alert"]')).toContainText('Google 로그인을 취소했어요');
    await expect(page.getByText('PROVIDER_RAW_TEXT')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Google로 계속하기', exact: true })).toBeEnabled();
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width);
    const screenshot = testInfo.outputPath(`google-login-cancelled-${viewport.width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach('로그인 취소 안내', { path: screenshot, contentType: 'image/png' });
    await page.getByRole('button', { name: 'Google로 계속하기', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: '내 공간에서 시작하세요.' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: '로그아웃', exact: true, includeHidden: true }),
    ).toHaveCount(1);
    expect(mock.googleNavigations).toHaveLength(1);
  });
}

test('신뢰하지 않는 로그인 리디렉션은 열지 않고 재시도를 제공한다', async ({ page }) => {
  const mock = await mockLogin(page, { invalidRedirect: true });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Google로 계속하기', exact: true }).click();
  await expect(page.locator('main [role="alert"]')).toContainText('Google 로그인 주소가 올바르지 않아요');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Google로 계속하기', exact: true })).toBeEnabled();
  expect(mock.googleNavigations).toHaveLength(0);
});

test('오래된 로컬 설정은 계정 인증으로 받아들이지 않고 공개 메인 탐색은 유지한다', async ({ page }) => {
  const mock = await mockLogin(page, { local: true });
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Google로 계속하기', exact: true })).toBeDisabled();
  await expect(page.locator('main').getByRole('alert')).toContainText('로그인 연결을 준비하지 못했어요');
  await expect(page.getByRole('button', { name: /로컬로 시작/ })).toHaveCount(0);
  await page.getByRole('link', { name: '← 메인으로', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled();
  await expect(
    page.getByText('로그인 없이 빈 공간을 만들고, 마음에 드는 자재를 배치해 보세요.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toHaveCount(0);
  expect(
    mock.calls.some((call) => call.path.startsWith('/api/auth') || call.path.startsWith('/api/d1/')),
  ).toBe(false);
});
