import { test, expect, type Page } from '@playwright/test';
import { catalogSeed } from '../src/lib/catalog/seed';

test.use({ channel: 'chrome', actionTimeout: 15000 });

const localStatus = { mode: 'local', ready: true, reason: 'local_environment', authRequired: false };
const cloudStatus = { mode: 'd1', ready: true, reason: 'ready', authRequired: true };
const memberId = 'b19e14ea-5f5a-4a8d-aa16-e9baef686d32';
const sample = {
  id: 'ad43af34-2a14-48ce-883f-6c60f0b56358',
  name: '그레이 테스트 세면대',
  brand: 'TOTO',
  category: 'basin',
  subcategoryName: '탑볼',
  color: '그레이',
  composition: '도기',
  finish: '무광',
  description: '공개 자재 설명',
  code: 'PUBLIC-001',
  widthMm: 600,
  heightMm: 180,
  depthMm: 420,
  images: [{ url: '/api/catalog/images?id=4280e7c4-e7df-48b7-a460-d283fcae201b', label: '정면' }],
};
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

// These tests only exercise catalog/auth UI. No inference or model download can leave the browser.
test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/(?:reconstruction(?:-lab)?\/|export\/photoreal)/, (route) =>
    route.fulfill({ status: 503, json: { error: 'Inference is disabled in this test.' } }),
  );
  await page.route(/\/models\//, (route) => route.abort());
});
async function local(page: Page) {
  await page.route('**/api/storage/status', (route) => route.fulfill({ json: localStatus }));
}
async function cloud(page: Page, options: { member?: boolean; broken?: boolean } = {}) {
  let signedIn = !!options.member;
  const calls: { path: string; method: string; body: unknown }[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({ path, method: request.method(), body: request.postData() ? request.postDataJSON() : null });
    switch (path) {
      case '/api/storage/status':
        return route.fulfill({
          json: options.broken ? { ...cloudStatus, ready: false, reason: 'connection_failed' } : cloudStatus,
        });
      case '/api/auth/get-session':
        return route.fulfill({
          json: signedIn ? { user: { id: memberId, name: '일반 회원', email: 'member@example.test' } } : null,
        });
      case '/api/d1/role':
        return route.fulfill({ json: { isAdmin: false } });
      case '/api/catalog/materials':
        return route.fulfill({ json: { materials: [sample], catalog: catalogSeed } });
      case '/api/catalog/images':
        return route.fulfill({ contentType: 'image/png', body: pixel });
      case '/api/auth/sign-in/social':
        return route.fulfill({ status: 503, json: { error: 'OAuth unavailable for test' } });
      case '/api/auth/sign-out':
        signedIn = false;
        return route.fulfill({ json: { success: true } });
      default:
        return route.fulfill({ status: 403, json: { error: 'Unexpected API request blocked by test.' } });
    }
  });
  return calls;
}
async function materialForm(page: Page) {
  await page.goto('/admin/materials');
  const open = page.getByRole('button', { name: '자재 등록', exact: true }).first();
  await expect(open).toBeEnabled();
  await open.click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await expect(form.getByRole('combobox', { name: '색상', exact: true })).toBeVisible();
  return form;
}

test('로컬 분류 관리에서 등록·수정·비활성 상태를 저장하고 중복 이름을 거부한다', async ({ page }) => {
  await local(page);
  await page.goto('/admin/catalog');
  await expect(page.getByRole('heading', { name: '자재 분류 관리' })).toBeVisible();
  await page.getByLabel('항목 이름', { exact: true }).fill('테스트 올리브');
  await page.getByLabel('색상 HEX (선택)', { exact: true }).fill('#667744');
  await page.getByLabel('표시 순서', { exact: true }).fill('50');
  await page.getByRole('button', { name: '항목 등록', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '테스트 올리브' })).toContainText('사용');

  await page.getByRole('button', { name: '수정 · 테스트 올리브', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '종류', exact: true })).toBeDisabled();
  await page.getByLabel('항목 이름', { exact: true }).fill('테스트 올리브 수정');
  await page.getByRole('checkbox', { name: '사용', exact: true }).uncheck();
  await page.getByRole('button', { name: '변경 저장', exact: true }).click();
  await page.reload();
  const saved = page.getByRole('row').filter({ hasText: '테스트 올리브 수정' });
  await expect(saved).toContainText('비활성');
  await expect(saved).toContainText('50');
  await expect(saved).not.toContainText('타일');
  await page.screenshot({ path: 'tmp/catalog-admin-visual.png', fullPage: true });

  await page.getByRole('combobox', { name: '종류', exact: true }).selectOption('brand');
  await page.getByLabel('항목 이름', { exact: true }).fill('  toto  ');
  await page.getByRole('button', { name: '항목 등록', exact: true }).click();
  await expect(page.locator('main [role="alert"]')).toContainText('같은 이름의 항목');
  await expect(page.getByRole('button', { name: '수정 · TOTO', exact: true })).toHaveCount(1);

  await page.getByRole('combobox', { name: '종류', exact: true }).selectOption('subcategory');
  await page.getByRole('combobox', { name: '상위 카테고리', exact: true }).selectOption('toilet');
  await page.getByLabel('항목 이름', { exact: true }).fill('테스트 변기 분류');
  await page.getByRole('button', { name: '항목 등록', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '테스트 변기 분류' })).toContainText('변기');
  await page.getByRole('button', { name: '수정 · 테스트 변기 분류', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '상위 카테고리', exact: true })).toBeDisabled();
});

test('자재 속성은 부분 검색·복수 선택·IME·키보드를 지원하고 검색어만 저장하지 않는다', async ({ page }) => {
  await local(page);
  const form = await materialForm(page);
  await form.getByLabel('상품명 *', { exact: true }).fill('검색 선택 검증 자재');
  const color = form.getByRole('combobox', { name: '색상', exact: true });
  await color.fill('그레');
  await expect(form.getByRole('option', { name: '그레이', exact: true })).toBeVisible();
  await expect(form.getByRole('option', { name: '화이트', exact: true })).toHaveCount(0);
  await color.dispatchEvent('compositionstart', { data: '그레' });
  await color.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
  await expect(form.getByRole('button', { name: '색상 그레이 제거', exact: true })).toHaveCount(0);
  await expect(color).toHaveValue('그레');
  await color.dispatchEvent('compositionend', { data: '그레' });
  await color.press('ArrowDown');
  await color.press('Enter');
  await expect(form.getByRole('button', { name: '색상 그레이 제거', exact: true })).toBeVisible();
  await expect(color).toHaveValue('');
  await color.fill('화이');
  await form.getByRole('option', { name: '화이트', exact: true }).click();
  await expect(form.getByRole('button', { name: '색상 화이트 제거', exact: true })).toBeVisible();
  await form.getByRole('button', { name: '색상 그레이 제거', exact: true }).click();
  await expect(form.getByRole('button', { name: '색상 그레이 제거', exact: true })).toHaveCount(0);
  await color.press('Escape');
  await expect(color).toHaveAttribute('aria-expanded', 'false');

  const brand = form.getByRole('combobox', { name: '브랜드', exact: true });
  await brand.fill('toTo');
  await brand.press('Enter');
  await expect(form.getByRole('button', { name: '브랜드 TOTO 제거', exact: true })).toBeVisible();
  await brand.click();
  await brand.press('ArrowDown');
  await brand.press('ArrowDown');
  await brand.press('ArrowUp');
  await brand.press('Enter');
  await expect(form.getByRole('button', { name: '브랜드 대림바스 제거', exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: '브랜드 TOTO 제거', exact: true })).toHaveCount(0);

  const finish = form.getByRole('combobox', { name: '마감', exact: true });
  await finish.fill('무광');
  await finish.press('Enter');
  await finish.fill('브러');
  await finish.press('Enter');
  await expect(form.getByRole('button', { name: '마감 무광 제거', exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: '마감 브러시드 제거', exact: true })).toBeVisible();

  await color.fill('등록되지않은색상');
  await expect(form.getByText('등록된 항목이 없어요.', { exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: /새 항목 만들기/ })).toHaveCount(0);
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('검색한 항목을 선택하거나 검색어를 지워');
  await expect(form).toBeVisible();
  // Clearing the query advances to image validation, proving it is separate from selected IDs.
  await color.fill('');
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('텍스처를 한 장 이상');
  expect(await page.evaluate(() => localStorage.getItem('sjn-local-catalog-v1'))).toBeNull();
});

test('비활성 분류는 자재 검색에서 제외되고 하위 분류는 제품 종류에 따라 바뀐다', async ({ page }) => {
  await local(page);
  await page.goto('/admin/catalog');
  await page.getByRole('button', { name: '수정 · 그레이', exact: true }).click();
  await page.getByRole('checkbox', { name: '사용', exact: true }).uncheck();
  await page.getByRole('button', { name: '변경 저장', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '그레이' })).toContainText('비활성');
  const form = await materialForm(page);
  const color = form.getByRole('combobox', { name: '색상', exact: true });
  await color.fill('그레');
  await expect(form.getByText('등록된 항목이 없어요.', { exact: true })).toBeVisible();
  await expect(form.getByRole('option', { name: '그레이', exact: true })).toHaveCount(0);
  await color.fill('');
  await form.getByRole('combobox', { name: '하위 카테고리', exact: true }).fill('포세');
  await expect(form.getByRole('option', { name: '포세린 타일', exact: true })).toBeVisible();
  await form.getByRole('combobox', { name: '카테고리', exact: true }).selectOption('toilet');
  const subcategory = form.getByRole('combobox', { name: '하위 카테고리', exact: true });
  await expect(subcategory).toHaveValue('');
  await subcategory.click();
  await expect(form.getByRole('option', { name: '원피스', exact: true })).toBeVisible();
  await expect(form.getByRole('option', { name: '포세린 타일', exact: true })).toHaveCount(0);
  await subcategory.fill('벽걸');
  await subcategory.press('Enter');
  await expect(form.getByRole('button', { name: '하위 카테고리 벽걸이 제거', exact: true })).toBeVisible();
});

test('비로그인 사용자는 공개 자재와 상세를 보고 프로젝트 생성에서 Google 로그인으로 이동한다', async ({
  page,
}) => {
  const calls = await cloud(page);
  await page.goto('/materials');
  await expect(page.getByRole('heading', { name: '내 공간을 완성할 자재' })).toBeVisible();
  await page.getByLabel('자재 검색', { exact: true }).fill('그레');
  await expect(page.getByRole('heading', { name: sample.name, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '자재 관리', exact: true })).toHaveCount(0);
  await page
    .getByRole('button')
    .filter({ has: page.getByRole('heading', { name: sample.name, exact: true }) })
    .click();
  const detail = page.getByRole('dialog', { name: '자재 상세' });
  await expect(detail).toContainText('공개 자재 설명');
  await expect(detail.getByAltText('정면')).toBeVisible();
  await expect(detail).toContainText('600 × 180 × 420 mm');
  await detail.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('link', { name: '프로젝트 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Google로 시작하기', exact: true })).toBeEnabled();
  expect(calls.some((call) => call.path.startsWith('/api/d1/projects'))).toBe(false);
});

test('일반 회원은 관리자 화면과 등록 버튼에 접근할 수 없다', async ({ page }) => {
  const calls = await cloud(page, { member: true });
  for (const path of ['/admin/materials', '/admin/catalog']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: '관리자 전용', exact: true })).toBeVisible();
    await expect.poll(() => calls.filter((call) => call.path === '/api/d1/role').length).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: '자재 등록', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '항목 등록', exact: true })).toHaveCount(0);
  }
  await page.goto('/materials');
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '분류 관리', exact: true })).toHaveCount(0);
  expect(calls.some((call) => call.path === '/api/d1/catalog' || call.path === '/api/d1/materials')).toBe(
    false,
  );
});

for (const failure of ['reported', 'network'] as const) {
  test(`운영 연결 장애(${failure})에서 이전 로컬 선택이 있어도 익명 편집으로 전환하지 않는다`, async ({
    page,
  }) => {
    await cloud(page, { broken: true });
    if (failure === 'network') await page.route('**/api/storage/status', (route) => route.abort());
    await page.addInitScript(() => sessionStorage.setItem('sjn-workspace', 'local'));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '공간미리 로그인', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Google로 시작하기', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '기본 공간으로 시작', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /로컬 자료 열기|로그인 없이.*편집/ })).toHaveCount(0);
    await page.getByRole('link', { name: '로그인 없이 자재 둘러보기', exact: true }).click();
    await expect(page.getByRole('heading', { name: sample.name, exact: true })).toBeVisible();
  });
}

test('Google 로그인 요청 실패와 OAuth 취소 안내를 표시하고 다시 시도할 수 있다', async ({ page }) => {
  const calls = await cloud(page);
  await page.goto('/login');
  const signIn = page.getByRole('button', { name: 'Google로 시작하기', exact: true });
  await expect(signIn).toBeEnabled();
  await signIn.click();
  await expect(page.locator('main [role="alert"]')).toContainText('Google 로그인 연결에 실패');
  await expect(signIn).toBeEnabled();
  expect(calls.find((call) => call.path === '/api/auth/sign-in/social')?.body).toMatchObject({
    provider: 'google',
    callbackURL: '/',
    errorCallbackURL: '/login?authError=google',
  });
  await page.goto('/login?authError=google');
  await expect(page.locator('main [role="alert"]')).toContainText('Google 로그인이 완료되지 않았어요');
  await expect(signIn).toBeEnabled();
});

test('회원 로그아웃 후 프로젝트 화면은 로그인으로 보호되고 공개 자재는 계속 볼 수 있다', async ({ page }) => {
  const calls = await cloud(page, { member: true });
  await page.goto('/materials');
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '공간미리 로그인', exact: true })).toBeVisible();
  expect(calls.filter((call) => call.path === '/api/auth/sign-out')).toHaveLength(1);
  await page.getByRole('link', { name: '로그인 없이 자재 둘러보기', exact: true }).click();
  await expect(page.getByRole('heading', { name: sample.name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Google로 시작하기', exact: true })).toBeVisible();
});
