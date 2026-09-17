import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { test, expect, type Page } from '@playwright/test';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
import { savedProject, storedProject } from '../tests/helpers/editor-actions';
import type { ProjectDocument } from '../src/lib/types';

// Every test gets Playwright's isolated storage context; no personal browser data is opened.
let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});

test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(150000);
const active = (project: ProjectDocument) =>
  project.designs.find((design) => design.id === project.activeDesignId)!;
const manager = (page: Page) => page.getByRole('dialog', { name: /시안 관리/ });
async function start(page: Page) {
  await page.goto('/');
  await seedTestTiles(page);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+$/, { timeout: 30000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 30000 });
  return savedProject(page);
}
async function openManager(page: Page) {
  await page.getByRole('button', { name: '시안 관리', exact: true }).click();
  await expect(manager(page)).toBeVisible();
}
async function copyCurrent(page: Page, sourceName: string) {
  await openManager(page);
  await manager(page)
    .getByRole('button', { name: sourceName + ' 복제', exact: true })
    .click();
  await expect(manager(page).getByTestId('design-card')).toHaveCount(2);
  await manager(page).getByRole('button', { name: '시안 관리 닫기', exact: true }).click();
  await expect(page.getByTestId('active-design-name')).toHaveText(sourceName + ' 복사본');
}
async function assetCount() {
  return (await app.snapshot()).assets.length;
}

for (const failureName of ['QuotaExceededError', 'AbortError']) {
  test(`다중 시안 서버 응답 ${failureName}: 기존 저장본·현재 복사본·자재 금액을 보존하고 명시적 저장으로 복구한다`, async ({
    page,
  }, info) => {
    const errors: string[] = [],
      forbiddenRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (/\/api\/cloud\/|\/models\/|supabase\.co/.test(request.url())) forbiddenRequests.push(request.url());
    });
    const initial = await start(page);
    await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
    await page.locator('button.material-tile').filter({ hasText: '차콜 스톤' }).click();
    await savedProject(page, initial.editRevision);
    const price = page.getByLabel('차콜 스톤 단가 (원)', { exact: true });
    await price.fill('30000');
    await price.press('Enter');
    const before = await savedProject(page),
      originalAssetCount = await assetCount();
    // Fault only the authenticated save response; real D1/R2 preserve the last commit.
    let faultEnabled = true,
      thrown = 0;
    await page.route('**/api/d1/projects', (route) => {
      if (faultEnabled && route.request().postDataJSON()?.operation === 'save') {
        thrown++;
        return route.fulfill({ status: 503, json: { error: '검증용 서버 저장 실패: ' + failureName } });
      }
      return route.fallback();
    });
    await copyCurrent(page, active(before).name);
    await expect(price).toHaveValue('30000');
    await price.fill('45000');
    await price.press('Enter');
    await expect(page.getByTestId('save-status')).toHaveText('저장 실패 · 다시 시도');
    await expect(page.locator('.editor-error[role="alert"]')).toContainText(failureName);
    await expect(page.getByTestId('active-design-name')).toHaveText(active(before).name + ' 복사본');
    expect(await storedProject(page)).toEqual(before);
    expect(await assetCount()).toBe(originalAssetCount);
    await page.screenshot({ path: info.outputPath(failureName + '-preserved.png'), fullPage: true });
    faultEnabled = false;
    expect(thrown).toBeGreaterThan(0);
    await page.getByRole('button', { name: '지금 저장', exact: true }).click();
    const recovered = await savedProject(page, before.editRevision);
    expect(recovered.designs).toHaveLength(2);
    expect(recovered.designs[0]).toEqual(before.designs[0]);
    expect(
      active(recovered).materialUsage!.assignments[active(recovered).scene.surfaces[0].id].pricing.unitPrice,
    ).toBe(45000);
    expect(
      active(before).materialUsage!.assignments[active(before).scene.surfaces[0].id].pricing.unitPrice,
    ).toBe(30000);
    expect(active(recovered).scene.surfaces[0].materialVersionId).toBe(
      active(before).scene.surfaces[0].materialVersionId,
    );
    expect(recovered.storageRevision).toBe(before.storageRevision + 1);
    expect(await assetCount()).toBe(originalAssetCount);
    await page.reload();
    await savedProject(page);
    expect(await storedProject(page)).toEqual(recovered);
    await expect(price).toHaveValue('45000');
    expect(errors).toEqual([]);
    expect(forbiddenRequests).toEqual([]);
    await info.attach('failure-recovery', {
      body: JSON.stringify({
        failureName,
        thrown,
        originalAssetCount,
        oldRevision: before.storageRevision,
        savedRevision: recovered.storageRevision,
        designs: recovered.designs.length,
        errors,
        forbiddenRequests,
      }),
      contentType: 'application/json',
    });
  });
}

test('회원의 두 탭은 D1 버전 충돌을 보존하고 서버 저장본 확인 후 편집을 계속한다', async ({
  page,
  context,
}, info) => {
  await start(page);
  await copyCurrent(page, '시안 A');
  await savedProject(page);
  const original = await storedProject(page),
    url = page.url();
  const viewer = await context.newPage();
  await viewer.goto(url);
  await expect(viewer.getByTestId('editor-canvas')).toBeVisible({ timeout: 30000 });
  await expect(viewer.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await expect(viewer.getByLabel('프로젝트명', { exact: true })).toBeEnabled();
  await viewer.getByRole('button', { name: 'Before', exact: true }).click();
  await viewer.getByRole('button', { name: 'After', exact: true }).click();
  expect(await storedProject(viewer)).toEqual(original);

  // D1 uses optimistic revisions; the local-only exclusive writer lock does not apply.
  await page.getByLabel('프로젝트명', { exact: true }).fill('첫 탭에서 확정한 프로젝트');
  const committed = await savedProject(page, original.editRevision);
  await openManager(viewer);
  await manager(viewer).getByRole('button', { name: '새 시안', exact: true }).click();
  await manager(viewer).getByRole('button', { name: '시안 관리 닫기', exact: true }).click();
  const recovery = viewer.getByRole('dialog', { name: '클라우드 작업 복구' });
  await expect(recovery).toContainText('서버 저장본과 다른 복구본', { timeout: 30000 });
  expect(await storedProject(viewer)).toEqual(committed);
  await expect(recovery.getByRole('button', { name: '복구본 이어서 편집', exact: true })).toHaveCount(0);
  await viewer.screenshot({ path: info.outputPath('conflicting-designs-preserved.png'), fullPage: true });
  await recovery.getByRole('button', { name: '서버 저장본 사용 · 복구본 보관' }).click();
  await expect(recovery).toHaveCount(0);
  await expect(viewer.getByLabel('프로젝트명', { exact: true })).toHaveValue(committed.name);
  expect(await storedProject(viewer)).toEqual(committed);

  await page.close();
  await openManager(viewer);
  await manager(viewer).getByRole('button', { name: '새 시안', exact: true }).click();
  await expect(manager(viewer).getByTestId('design-card')).toHaveCount(3);
  await manager(viewer).getByRole('button', { name: '시안 관리 닫기', exact: true }).click();
  const saved = await savedProject(viewer, committed.editRevision);
  expect(saved.designs).toHaveLength(3);
  expect(saved.storageRevision).toBe(committed.storageRevision + 1);
  await info.attach('cloud-writer-conflict', {
    body: JSON.stringify({
      viewingDidNotWrite: true,
      staleSavePreservedServer: true,
      finalDesigns: saved.designs.length,
      originalStorageRevision: original.storageRevision,
      committedStorageRevision: committed.storageRevision,
      finalStorageRevision: saved.storageRevision,
    }),
    contentType: 'application/json',
  });
});

test('WebGL 실패 시 문서를 보존하고 비교 카드 재시도·편집기 재진입으로 복구한다', async ({ page }, info) => {
  await start(page);
  await copyCurrent(page, '시안 A');
  await savedProject(page);
  await openManager(page);
  await manager(page).getByRole('checkbox', { name: '시안 A 비교 선택', exact: true }).check();
  await manager(page).getByRole('checkbox', { name: '시안 A 복사본 비교 선택', exact: true }).check();
  await manager(page).getByRole('button', { name: '시안 관리 닫기', exact: true }).click();
  const before = await savedProject(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('design-webgl-recovered') === 'yes') return;
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;
    (window as unknown as { __restoreDesignWebGL: () => void }).__restoreDesignWebGL = () => {
      HTMLCanvasElement.prototype.getContext = nativeGetContext;
      sessionStorage.setItem('design-webgl-recovered', 'yes');
    };
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      writable: true,
      value(this: HTMLCanvasElement, kind: string, options?: unknown) {
        if (kind === 'webgl2' || kind === 'webgl' || kind === 'experimental-webgl') return null;
        return Reflect.apply(nativeGetContext, this, [kind, options]);
      },
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.reload();
  await expect(page.locator('.editor-error[role="alert"]')).toContainText('WebGL을 시작할 수 없어요');
  await expect(page.locator('.editor-error[role="alert"]')).toContainText('하드웨어 가속');
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByTestId('active-design-name')).toHaveText(active(before).name);
  expect(await storedProject(page)).toEqual(before);
  await openManager(page);
  await expect(manager(page).getByTestId('design-card')).toHaveCount(2);
  await manager(page).getByRole('button', { name: '시안 관리 닫기', exact: true }).click();
  await page.screenshot({ path: info.outputPath('webgl-guidance.png'), fullPage: true });
  await page.getByRole('button', { name: '시안 비교', exact: true }).click();
  const cards = page.getByTestId('comparison-card');
  await expect(cards).toHaveCount(2);
  for (const index of [0, 1]) {
    await expect(cards.nth(index).getByRole('alert')).toContainText('WebGL');
    await expect(cards.nth(index).getByRole('button', { name: '다시 시도', exact: true })).toBeEnabled();
  }
  await page.screenshot({ path: info.outputPath('comparison-webgl-failure.png'), fullPage: true });
  expect(await storedProject(page)).toEqual(before);
  await page.evaluate(() =>
    (window as unknown as { __restoreDesignWebGL: () => void }).__restoreDesignWebGL(),
  );
  for (const index of [0, 1])
    await cards.nth(index).getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(cards.getByRole('alert')).toHaveCount(0);
  await expect(cards.getByRole('img')).toHaveCount(2);
  await expect
    .poll(() =>
      cards
        .getByRole('img')
        .evaluateAll((images) =>
          images.every(
            (image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  await page.getByRole('button', { name: '편집으로 돌아가기', exact: true }).click();
  await savedProject(page);
  expect(await storedProject(page)).toEqual(before);
  await page.reload();
  await savedProject(page);
  await expect(page.locator('[data-testid="canvas-frame"] canvas')).toBeVisible();
  expect(await storedProject(page)).toEqual(before);
  expect(errors).toEqual([]);
  await info.attach('webgl-recovery', {
    body: JSON.stringify({
      preservedDesigns: before.designs.length,
      noInfiniteSpinner: true,
      recoveredOnReload: true,
      comparisonCardRetrySucceeded: true,
      errors,
    }),
    contentType: 'application/json',
  });
});
