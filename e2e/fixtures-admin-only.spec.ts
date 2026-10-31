import { expect, test, type Page } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { savedProject } from '../tests/helpers/editor-actions';

/** 위생도기 in a project is administrators' only for now (src/lib/fixture-access.ts). */
let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(240000);

const tab = (page: Page, name: string) =>
  page.locator('aside.catalog-panel').getByRole('button', { name, exact: true });

async function openMemberRoom(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(tab(page, '바닥 타일')).toBeVisible();
}

test('일반 회원: 프로젝트에 위생도기 탭이 없고 타일 탭은 그대로다', async ({ page }) => {
  app = await authenticatedApp(page, { admin: false });
  let roleAnswered = false;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/d1/role') roleAnswered = true;
  });
  await openMemberRoom(page);
  await expect.poll(() => roleAnswered).toBe(true);
  await expect(tab(page, '위생도기')).toHaveCount(0);
  await tab(page, '벽 타일').click();
  await expect(tab(page, '벽 타일')).toHaveAttribute('aria-pressed', 'true');
});

test('게스트: 체험 공간에 위생도기 탭이 없다', async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false });
  await page.goto('/');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정' })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await expect(page).toHaveURL(/\/try$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(tab(page, '바닥 타일')).toBeVisible();
  await expect(tab(page, '위생도기')).toHaveCount(0);
});

test('관리자: 탭이 보이고, 권한을 잃으면 탭이 사라져 바닥 타일로 돌아오며 저장에는 변화가 없다', async ({
  page,
}) => {
  app = await authenticatedApp(page);
  await openMemberRoom(page);
  await tab(page, '위생도기').click();
  await expect(tab(page, '위생도기')).toHaveAttribute('aria-pressed', 'true');
  const before = await savedProject(page);
  await page.route('**/api/d1/role', (route) => route.fulfill({ json: { isAdmin: false } }));
  await page.evaluate(() => window.dispatchEvent(new Event('sjn-admin-role-changed')));
  await expect(tab(page, '위생도기')).toHaveCount(0);
  await expect(tab(page, '바닥 타일')).toHaveAttribute('aria-pressed', 'true');
  expect((await savedProject(page)).editRevision).toBe(before.editRevision);
});
