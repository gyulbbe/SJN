import { test, expect, type Page } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';

const captureRoot = process.env.SJN_LOGIN_SIMPLE_OUTPUT_ROOT ?? 'test-results/login-simple';
const phase = process.env.SJN_LOGIN_SIMPLE_PHASE === 'before' ? 'before' : 'after';
const title = phase === 'before' ? '로그인하고 이어서 이용하세요' : '로그인 / 회원가입';
const google = phase === 'before' ? 'Google로 시작하기' : 'Google로 계속하기';
const sizes = [
  { width: 390, height: 844 },
  { width: 1440, height: 1000 },
  { width: 390, height: 360 },
];
test.use({ channel: 'chrome', actionTimeout: 15000 });
let app: AuthenticatedApp;
test.afterEach(async () => {
  await app?.dispose();
});
async function screenshot(page: Page, name: string) {
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: captureRoot + '/' + phase + '/' + name + '-' + size.width + 'x' + size.height + '.png',
      fullPage: false,
      animations: 'disabled',
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
  }
}
async function minimal(page: Page) {
  const button = page.getByRole('button', { name: google, exact: true });
  await expect(button).toBeEnabled();
  if (phase === 'before') return;
  await expect(button.locator('img')).toHaveAttribute('src', '/icons/google-g.svg');
  await expect
    .poll(() => button.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth > 0))
    .toBe(true);
  await expect(button).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.getByRole('heading', { name: '로그인 / 회원가입', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '체험 계속하기', exact: true })).toHaveCount(0);
  await expect(
    page.getByText(/처음 로그인하면 회원가입|Google 계정으로 처음 로그인|기능은 로그인 후 사용할/),
  ).toHaveCount(0);
}
test('로그인 팝업·전용 화면·회원 전용 안내의 반응형 비교', async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false, admin: false });
  await page.goto('/');
  await page.getByRole('button', { name: '로그인 / 회원가입', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
  await minimal(page);
  if (phase === 'after') {
    await page.getByRole('dialog', { name: title, exact: true }).screenshot({
      path: 'test-results/login-simple/popup-preview.png',
      animations: 'disabled',
    });
  }
  await screenshot(page, 'popup');
  await page.getByRole('button', { name: '로그인 안내 닫기', exact: true }).click();
  await page.goto('/login');
  await minimal(page);
  await screenshot(page, 'login');
  await page.goto('/projects/private-project');
  await minimal(page);
  await screenshot(page, 'member-guard');
});

test('간소화된 로그인 팝업은 연결 중 닫기·중복 요청을 막고 실패 후 초점을 복귀한다', async ({ page }) => {
  test.skip(phase === 'before', '변경 후 동작 검증');
  app = await authenticatedApp(page, { signedIn: false, admin: false });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route('**/api/auth/sign-in/social', async (route) => {
    calls++;
    await released;
    await route.fulfill({ status: 503, json: { error: 'Isolated login failure' } });
  });
  try {
    await page.goto('/');
    const opener = page.getByRole('button', { name: '로그인 / 회원가입', exact: true }).first();
    await opener.click();
    const dialog = page.getByRole('dialog', { name: '로그인 / 회원가입', exact: true });
    const close = dialog.getByRole('button', { name: '로그인 안내 닫기', exact: true });
    await dialog.getByRole('button', { name: 'Google로 계속하기', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Google 연결 중…', exact: true })).toBeDisabled();
    await expect(close).toBeDisabled();
    await expect(dialog.getByRole('status')).toContainText('Google 계정 선택 화면을 열고 있어요');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    expect(calls).toBe(1);
    release();
    await expect(dialog.getByRole('alert')).toContainText('Google 로그인 연결에 실패');
    await expect(dialog.getByRole('button', { name: 'Google로 계속하기', exact: true })).toBeEnabled();
    await expect(close).toBeEnabled();
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  } finally {
    release();
  }
});
