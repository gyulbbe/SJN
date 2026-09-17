import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import type { Page as AuthenticatedPage } from '@playwright/test';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

const authenticatedTests = new WeakMap<AuthenticatedPage, AuthenticatedApp>();
test.beforeEach(async ({ page }) => {
  authenticatedTests.set(page, await authenticatedApp(page));
});
test.afterEach(async ({ page }) => {
  await authenticatedTests.get(page)?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000 });
const createDialog = (page: Page) =>
  page.getByRole('dialog', { name: '사진으로 비교 공간 만들기', exact: true });
const aiRadio = (page: Page) => page.getByRole('radio', { name: /^AI 정밀 분석/ });
const browserRadio = (page: Page) => page.getByRole('radio', { name: /브라우저 기본 분석/ });

async function availability(page: Page, available = true) {
  await page.route('**/api/reconstruction/cloud', (route) => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json: { available, reason: available ? undefined : 'Gemma 연결 확인 필요' } });
  });
  await page.route(/\/api\/(reconstruction\/local|reconstruction-lab\/engine)/, () => {
    throw new Error('Retired AI endpoint must not be requested by the UI');
  });
}
async function open(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
  await expect(createDialog(page)).toBeVisible();
}
async function upload(page: Page) {
  const buffer = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#b8a58f' } })
    .png()
    .toBuffer();
  await page
    .getByTestId('reconstruction-upload')
    .setInputFiles({ name: 'profile-fixture.png', mimeType: 'image/png', buffer });
}
async function manualProject(page: Page) {
  await open(page);
  await upload(page);
  await createDialog(page).getByRole('button', { name: '분석 없이 직접 구성', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 45000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
}
async function openRebuild(page: Page) {
  await page.getByRole('button', { name: '기존 공간 수정', exact: true }).click();
  await page.getByRole('button', { name: '사진 다시 분석', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Before 사진 다시 분석', exact: true })).toBeVisible();
}

// These tests mock availability only. They deliberately do not run or claim to validate AI inference.
test('new project prefers Gemma and browser MoGe when cloud is ready; log download is not form submission', async ({
  page,
}) => {
  await availability(page);
  await open(page);
  await expect(aiRadio(page)).toBeChecked();
  await expect(page.getByRole('radio', { name: /로컬 정밀 분석/ })).toHaveCount(0);
  await expect(page.getByText(/서버 연결을 확인했어요/)).toBeVisible();
  await upload(page);
  await expect(
    createDialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true }),
  ).toBeEnabled();
  await createDialog(page).getByRole('button', { name: '진단 로그 JSON', exact: true }).click();
  await expect(createDialog(page)).toBeVisible();
  await expect(
    createDialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true }),
  ).toBeEnabled();
  await expect(page.getByText('새로 실행한 분석부터 진단이 보관돼요.', { exact: false })).toBeVisible();
});

test('unavailable cloud is explained and defaults a new project to browser basic', async ({ page }) => {
  await availability(page, false);
  await open(page);
  await expect(browserRadio(page)).toBeChecked();
  await expect(aiRadio(page)).toBeDisabled();
  await expect(page.getByText(/AI 정밀 분석 연결:/)).toContainText('Gemma 연결 확인 필요');
  await upload(page);
  await expect(
    createDialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true }),
  ).toBeEnabled();
});

test('a user choice made during connection checks survives a late successful response', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/reconstruction/cloud', async (route) => {
    await pending;
    await route.fulfill({ json: { available: true } });
  });
  await open(page);
  await upload(page);
  await expect(
    createDialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true }),
  ).toBeEnabled();
  await expect(
    createDialog(page).getByRole('button', { name: '분석 없이 직접 구성', exact: true }),
  ).toBeEnabled();
  // The already selected basic radio must count as an explicit choice while checking.
  await browserRadio(page).click();
  release();
  await expect(page.getByText(/서버 연결을 확인했어요/)).toBeVisible();
  await expect(browserRadio(page)).toBeChecked();
  await expect(
    createDialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true }),
  ).toBeEnabled();
});

test('connection recheck does not overwrite an explicit browser selection', async ({ page }) => {
  await availability(page);
  await open(page);
  await expect(aiRadio(page)).toBeChecked();
  await browserRadio(page).check();
  await page.getByRole('button', { name: '분석 연결 다시 확인', exact: true }).click();
  await expect(page.getByText(/서버 연결을 확인했어요/)).toBeVisible();
  await expect(browserRadio(page)).toBeChecked();
});

test('an older project keeps browser analysis on rebuild even when Gemma is ready', async ({ page }) => {
  await availability(page);
  await manualProject(page);
  await openRebuild(page);
  await expect(page.getByText(/서버 연결을 확인했어요/)).toBeVisible();
  await expect(browserRadio(page)).toBeChecked();
  await expect(page.getByRole('button', { name: 'Before 다시 만들기', exact: true })).toBeEnabled();
});

test('saved local profile explains migration and requires a ready cloud or explicit basic choice', async ({
  page,
}) => {
  await availability(page, false);
  await manualProject(page);
  const projectId = page.url().split('/').at(-1)!;
  await page.evaluate(async (id) => {
    async function operation(body: object) {
      const response = await fetch('/api/d1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }
    const project = await operation({ operation: 'load', id });
    project.shared.comparison.review.analysisProfile = 'local-quality-v1';
    await operation({
      operation: 'save',
      document: project,
      expectedStorageRevision: project.storageRevision,
    });
  }, projectId);
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await openRebuild(page);
  await expect(page.getByText(/선택한 분석을 유지했어요/)).toBeVisible();
  await expect(aiRadio(page)).toBeChecked();
  await expect(page.getByText(/기존 로컬 분석이 종료되어/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Before 다시 만들기', exact: true })).toBeDisabled();
  await browserRadio(page).check();
  await expect(page.getByRole('button', { name: 'Before 다시 만들기', exact: true })).toBeEnabled();
});

test('old lab address opens the current Gemma and browser MoGe test screen', async ({ page }) => {
  await availability(page);
  await page.goto('/reconstruction-lab');
  await expect(page).toHaveURL(/\/reconstruction-performance$/);
  await expect(page.getByRole('button', { name: '개선 후보 전체 실행', exact: true })).toHaveCount(0);
});
