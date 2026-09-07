import { test, expect, type Page } from '@playwright/test';
import { seedTestTiles } from '../tests/helpers/catalog-fixtures.mjs';
import { savedProject, storedProject } from '../tests/helpers/editor-actions';
import type { ProjectDocument } from '../src/lib/types';

// Every test gets Playwright's isolated storage context; no personal browser data is opened.
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
  await expect(page).toHaveURL(/\/projects\/[\w-]+$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
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
async function assetCount(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gongganmiri-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = database.transaction('assets').objectStore('assets').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

for (const failureName of ['QuotaExceededError', 'AbortError']) {
  test(`다중 시안 ${failureName}: 기존 저장본·현재 복사본·자재 금액을 보존하고 명시적 저장으로 복구한다`, async ({
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
      originalAssetCount = await assetCount(page);
    await page.evaluate((failureName) => {
      const state = window as unknown as {
        __designStorageFault: { enabled: boolean; failures: number; restore: () => void };
      };
      const nativePut = IDBObjectStore.prototype.put;
      state.__designStorageFault = {
        enabled: true,
        failures: 0,
        restore: () => {
          IDBObjectStore.prototype.put = nativePut;
        },
      };
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        if (this.name === 'projects' && state.__designStorageFault.enabled) {
          state.__designStorageFault.failures++;
          throw new DOMException('검증용 시안 저장 실패: ' + failureName, failureName);
        }
        return Reflect.apply(nativePut, this, key === undefined ? [value] : [value, key]);
      };
    }, failureName);
    await copyCurrent(page, active(before).name);
    await expect(price).toHaveValue('30000');
    await price.fill('45000');
    await price.press('Enter');
    await expect(page.getByTestId('save-status')).toHaveText('저장 실패 · 다시 시도');
    await expect(page.locator('.editor-error[role="alert"]')).toContainText(failureName);
    await expect(page.getByTestId('active-design-name')).toHaveText(active(before).name + ' 복사본');
    expect(await storedProject(page)).toEqual(before);
    expect(await assetCount(page)).toBe(originalAssetCount);
    await page.screenshot({ path: info.outputPath(failureName + '-preserved.png'), fullPage: true });
    const thrown = await page.evaluate(() => {
      const fault = (
        window as unknown as {
          __designStorageFault: { enabled: boolean; failures: number; restore: () => void };
        }
      ).__designStorageFault;
      fault.enabled = false;
      fault.restore();
      return fault.failures;
    });
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
    expect(await assetCount(page)).toBe(originalAssetCount);
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

test('다른 탭은 시안 조회만 허용하며 첫 탭 종료 후 편집권을 이어받는다', async ({ page, context }, info) => {
  await start(page);
  await copyCurrent(page, '시안 A');
  await savedProject(page);
  const original = await storedProject(page),
    url = page.url();
  const viewer = await context.newPage();
  await viewer.goto(url);
  await expect(viewer.locator('.readonly-banner')).toContainText('읽기 전용');
  await expect(viewer.getByTestId('editor-canvas')).toBeVisible();
  await expect(viewer.locator('.canvas-loading')).toHaveCount(0);
  await expect(viewer.getByLabel('프로젝트명', { exact: true })).toBeDisabled();
  await expect(viewer.getByRole('button', { name: '지금 저장', exact: true })).toBeDisabled();
  await openManager(viewer);
  await expect(manager(viewer).getByRole('button', { name: '새 시안', exact: true })).toBeDisabled();
  for (const design of original.designs) {
    for (const action of ['복제', '이름 변경', '삭제'])
      await expect(
        manager(viewer).getByRole('button', { name: `${design.name} ${action}`, exact: true }),
      ).toBeDisabled();
  }
  await manager(viewer).getByRole('button', { name: '시안 A 열기', exact: true }).click();
  await expect(viewer.getByTestId('active-design-name')).toHaveText('시안 A');
  await viewer.getByRole('button', { name: 'Before', exact: true }).click();
  await viewer.getByRole('button', { name: 'After', exact: true }).click();
  expect(await storedProject(viewer)).toEqual(original);
  await viewer.screenshot({ path: info.outputPath('readonly-designs.png'), fullPage: true });
  await page.close();
  await expect(viewer.locator('.readonly-banner')).toHaveCount(0);
  await expect(viewer.getByLabel('프로젝트명', { exact: true })).toBeEnabled();
  await openManager(viewer);
  await expect(manager(viewer).getByRole('button', { name: '새 시안', exact: true })).toBeEnabled();
  await manager(viewer).getByRole('button', { name: '새 시안', exact: true }).click();
  await expect(manager(viewer).getByTestId('design-card')).toHaveCount(3);
  await manager(viewer).getByRole('button', { name: '시안 관리 닫기', exact: true }).click();
  const saved = await savedProject(viewer, original.editRevision);
  expect(saved.designs).toHaveLength(3);
  await info.attach('writer-handoff', {
    body: JSON.stringify({
      initiallyReadonly: true,
      viewingDidNotWrite: true,
      finalDesigns: saved.designs.length,
      originalStorageRevision: original.storageRevision,
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
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
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
