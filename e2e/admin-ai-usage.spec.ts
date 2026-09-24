import { test, expect, type Page } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import type { AiUsageSummary } from '../src/lib/admin/ai-usage-contract';

const apps = new WeakMap<Page, AuthenticatedApp>();
test.use({ channel: 'chrome' });
test.afterEach(async ({ page }) => {
  await apps.get(page)?.dispose();
});

const summary: AiUsageSummary = {
  checkedAt: '2026-09-25T05:30:00.000Z',
  dayStart: '2026-09-25T00:00:00.000Z',
  resetAt: '2026-09-26T00:00:00.000Z',
  freeNeurons: 10000,
  usedNeurons: 4001.4,
  remainingNeurons: 5998.6,
  requests: 36,
  overageNeurons: 0,
  overageUsd: 0,
  models: [
    { modelId: '@cf/black-forest-labs/flux-2-klein-4b', neurons: 2400, requests: 4 },
    { modelId: '@cf/google/gemma-4-26b-a4b-it', neurons: 1601.4, requests: 32 },
  ],
  days: ['19', '20', '21', '22', '23', '24', '25'].map((day, i) => ({
    date: `2026-09-${day}`,
    neurons: i === 4 ? 12000 : i === 6 ? 4001.4 : 800,
    requests: 10,
  })),
};

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test('관리자는 오늘 남은 무료 뉴런·모델별 사용·최근 7일을 본다', async ({ page }, testInfo) => {
  apps.set(page, await authenticatedApp(page, { admin: true }));
  let calls = 0;
  await page.route('**/api/admin/ai-usage', (route) => {
    calls++;
    return route.fulfill({ json: summary });
  });
  await page.goto('/admin/ai-usage');
  await expect(page.getByRole('heading', { name: 'AI 사용량', exact: true })).toBeVisible();
  const today = page.getByRole('region', { name: '오늘 남은 무료 뉴런' });
  await expect(today).toContainText('5,999');
  await expect(today).toContainText('/ 10,000');
  await expect(today.getByRole('progressbar', { name: '오늘 사용한 비율' })).toHaveAttribute(
    'aria-valuenow',
    '40',
  );
  await expect(today).toContainText('36회');
  const models = page.getByRole('region', { name: '모델별 사용' }).getByRole('listitem');
  await expect(models).toHaveCount(2);
  await expect(models.first()).toContainText('AI 현장 사진 · FLUX.2 klein 4B');
  await expect(models.nth(1)).toContainText('사진 분석 · Gemma');
  await expect(page.getByRole('region', { name: '최근 7일' }).getByRole('listitem')).toHaveCount(7);
  await expect(page.getByRole('link', { name: 'AI 사용량', exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('ai-usage-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('ai-usage-mobile.png'), fullPage: true });
  const before = calls;
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect.poll(() => calls).toBe(before + 1);
});

test('설정이 없으면 등록해야 할 값을 안내하고 외부 서비스를 부르지 않는다', async ({ page }) => {
  apps.set(page, await authenticatedApp(page, { admin: true }));
  await page.goto('/admin/ai-usage');
  // Filter by text: the framework's route announcer is also an alert region.
  await expect(page.getByRole('alert').filter({ hasText: 'CLOUDFLARE_ANALYTICS_TOKEN' })).toContainText(
    '설정되지 않았어요',
  );
  await expect(page.getByRole('region', { name: '오늘 남은 무료 뉴런' })).toHaveCount(0);
});

test('일반 회원은 AI 사용량 화면과 API를 쓸 수 없다', async ({ page }) => {
  apps.set(page, await authenticatedApp(page, { admin: false }));
  await page.goto('/admin/ai-usage');
  await expect(page.getByRole('heading', { name: '관리자 전용', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '오늘 남은 무료 뉴런' })).toHaveCount(0);
  const status = await page.evaluate(async () => (await fetch('/api/admin/ai-usage')).status);
  expect(status).toBe(403);
});
