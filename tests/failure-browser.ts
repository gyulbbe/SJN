import { getActiveDesign } from '../src/lib/designs';
import { uploadBathroomPhoto } from './helpers/catalog-fixtures.mjs';
/** Failure recovery through the real app: start localhost:3000, then node --experimental-strip-types tests/failure-browser.ts. */
import { chromium, expect, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { ProjectDocument } from '../src/lib/types';

const directory = 'test-results/failure-qa';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  browser: await browser.version(),
  runtime: process.version,
  environment: 'Windows / real Chrome headless / next dev / fresh isolated browser contexts',
  diskWasFilled: false,
};

async function storedProject(page: Page, id: string): Promise<ProjectDocument> {
  return page.evaluate(
    (projectId) =>
      new Promise<ProjectDocument>((resolve, reject) => {
        const request = indexedDB.open('gongganmiri-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const get = database.transaction('projects').objectStore('projects').get(projectId);
          get.onerror = () => {
            database.close();
            reject(get.error);
          };
          get.onsuccess = () => {
            database.close();
            resolve(get.result);
          };
        };
      }),
    id,
  );
}

async function openUploadedProject(page: Page) {
  await page.goto('http://127.0.0.1:3000');
  await uploadBathroomPhoto(page);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  return page.url().split('/').at(-1)!;
}

try {
  await mkdir(directory, { recursive: true });
  const webglContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await webglContext.addInitScript(() => {
    if (sessionStorage.getItem('failure-qa-webgl-recovered') === 'yes') return;
    const state = window as unknown as { __webglFailureCalls: number };
    state.__webglFailureCalls = 0;
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      writable: true,
      value(this: HTMLCanvasElement, kind: string, options?: unknown) {
        if (kind === 'webgl2') {
          state.__webglFailureCalls++;
          return null;
        }
        return Reflect.apply(nativeGetContext, this, [kind, options]);
      },
    });
  });
  const webglPage = await webglContext.newPage();
  webglPage.setDefaultTimeout(30000);
  const webglErrors: string[] = [];
  const webglConsoleErrors: string[] = [];
  const webglHttpErrors: { url: string; status: number }[] = [];
  webglPage.on('pageerror', (error) => webglErrors.push(error.message));
  webglPage.on('response', (response) => {
    if (response.status() >= 400) webglHttpErrors.push({ url: response.url(), status: response.status() });
  });
  webglPage.on('console', (message) => {
    if (message.type() === 'error') webglConsoleErrors.push(message.text());
  });
  const webglId = await openUploadedProject(webglPage);
  await expect(webglPage.locator('.editor-error[role="alert"]')).toContainText('WebGL을 시작할 수 없어요');
  await expect(webglPage.locator('.editor-error[role="alert"]')).toContainText('하드웨어 가속');
  await expect(webglPage.locator('.canvas-loading')).toHaveCount(0);
  const afterFailure = await storedProject(webglPage, webglId);
  assert.ok(getActiveDesign(afterFailure)!.scene.originalAssetId);
  assert.equal(afterFailure.storageRevision, 1);
  const originalAsset = await webglPage.evaluate(
    (assetId) =>
      new Promise<{ id: string; bytes: number }>((resolve, reject) => {
        const request = indexedDB.open('gongganmiri-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const get = database.transaction('assets').objectStore('assets').get(assetId);
          get.onerror = () => {
            database.close();
            reject(get.error);
          };
          get.onsuccess = () => {
            database.close();
            resolve({ id: get.result.id, bytes: get.result.blob.size });
          };
        };
      }),
    ((value) => value.designs.find((item) => item.id === value.activeDesignId)!)(afterFailure).scene.originalAssetId,
  );
  assert.ok(originalAsset.bytes > 0);
  const injectionCalls = await webglPage.evaluate(
    () => (window as unknown as { __webglFailureCalls: number }).__webglFailureCalls,
  );
  assert.ok(injectionCalls > 0);
  await webglPage.screenshot({ path: `${directory}/webgl-failure.png`, fullPage: true });

  // Removing the fault and reopening must render the exact saved document.
  await webglPage.evaluate(() => sessionStorage.setItem('failure-qa-webgl-recovered', 'yes'));
  await webglPage.reload();
  await expect(webglPage.getByTestId('editor-canvas')).toBeVisible();
  await expect(webglPage.locator('.canvas-loading')).toHaveCount(0);
  await expect(webglPage.locator('.editor-error[role="alert"]')).toHaveCount(0);
  await expect
    .poll(() =>
      webglPage
        .locator('[data-testid="canvas-frame"] canvas')
        .evaluate((canvas) => !!(canvas as HTMLCanvasElement).getContext('webgl2')),
    )
    .toBe(true);
  assert.deepEqual(await storedProject(webglPage, webglId), afterFailure);
  assert.deepEqual(webglErrors, []);
  report.webglFailure = {
    passed: true,
    injection: 'HTMLCanvasElement.getContext("webgl2") returns null',
    injectionCalls,
    errorGuidanceVisible: true,
    noInfiniteSpinner: true,
    projectAndOriginalAssetPreserved: true,
    originalAsset,
    storageRevision: afterFailure.storageRevision,
    reopenedAfterRemovingFault: true,
    uncaughtPageErrors: webglErrors,
    consoleErrors: webglConsoleErrors,
    httpErrors: webglHttpErrors,
    screenshot: `${directory}/webgl-failure.png`,
  };
  await webglContext.close();

  const quotaContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const quotaPage = await quotaContext.newPage();
  quotaPage.setDefaultTimeout(30000);
  const quotaErrors: string[] = [];
  quotaPage.on('pageerror', (error) => quotaErrors.push(error.message));
  const quotaId = await openUploadedProject(quotaPage);
  await expect(quotaPage.locator('.canvas-loading')).toHaveCount(0);
  const beforeQuota = await storedProject(quotaPage, quotaId);
  await quotaPage.evaluate(() => {
    const state = window as unknown as {
      __quotaFailure: { remaining: number; thrown: number; projectPuts: number };
    };
    state.__quotaFailure = { remaining: 1, thrown: 0, projectPuts: 0 };
    const nativePut = IDBObjectStore.prototype.put;
    Object.defineProperty(IDBObjectStore.prototype, 'put', {
      configurable: true,
      writable: true,
      value(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (this.name === 'projects') {
          state.__quotaFailure.projectPuts++;
          if (state.__quotaFailure.remaining > 0) {
            state.__quotaFailure.remaining--;
            state.__quotaFailure.thrown++;
            throw new DOMException('검증용 저장 공간 부족 (실제 디스크 변경 없음)', 'QuotaExceededError');
          }
        }
        return Reflect.apply(nativePut, this, key === undefined ? [value] : [value, key]);
      },
    });
  });
  const newName = '저장 실패 후에도 유지되는 현재 작업';
  await quotaPage.getByLabel('프로젝트명', { exact: true }).fill(newName);
  await quotaPage.getByLabel('프로젝트명', { exact: true }).blur();
  await expect(quotaPage.getByTestId('save-status')).toHaveText('저장 실패 · 다시 시도');
  await expect(quotaPage.locator('.editor-error[role="alert"]')).toContainText('검증용 저장 공간 부족');
  await expect(quotaPage.getByLabel('프로젝트명', { exact: true })).toHaveValue(newName);
  assert.deepEqual(await storedProject(quotaPage, quotaId), beforeQuota);
  const afterInjectedFailure = await quotaPage.evaluate(
    () =>
      (window as unknown as { __quotaFailure: { remaining: number; thrown: number; projectPuts: number } })
        .__quotaFailure,
  );
  assert.equal(afterInjectedFailure.thrown, 1);
  assert.equal(afterInjectedFailure.remaining, 0);
  await quotaPage.screenshot({ path: `${directory}/quota-failure.png`, fullPage: true });

  await quotaPage.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(quotaPage.getByRole('button', { name: '지금 저장', exact: true })).toBeEnabled();
  await expect(quotaPage.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  const afterRetry = await storedProject(quotaPage, quotaId);
  assert.equal(afterRetry.name, newName);
  assert.ok(afterRetry.storageRevision > beforeQuota.storageRevision);
  assert.deepEqual(getActiveDesign(afterRetry)!.scene, getActiveDesign(beforeQuota)!.scene);
  await expect(quotaPage.getByLabel('프로젝트명', { exact: true })).toHaveValue(newName);
  const injectionAfterRetry = await quotaPage.evaluate(
    () =>
      (window as unknown as { __quotaFailure: { remaining: number; thrown: number; projectPuts: number } })
        .__quotaFailure,
  );
  assert.equal(injectionAfterRetry.thrown, 1);
  await expect(quotaPage.locator('.editor-error[role="alert"]')).toHaveCount(0);
  const staleAlertAfterRetry = await quotaPage.locator('.editor-error[role="alert"]').allTextContents();
  await quotaPage.screenshot({ path: `${directory}/quota-recovered.png`, fullPage: true });
  await quotaPage.reload();
  await expect(quotaPage.getByLabel('프로젝트명', { exact: true })).toHaveValue(newName);
  await expect(quotaPage.getByTestId('save-status')).toHaveText('이 브라우저에 저장됨');
  assert.deepEqual(await storedProject(quotaPage, quotaId), afterRetry);
  assert.deepEqual(quotaErrors, []);
  report.quotaFailure = {
    passed: true,
    injection: 'one QuotaExceededError from IDBObjectStore.put, only projects store',
    priorDocumentUnchangedOnFailure: true,
    currentFormPreserved: true,
    errorStatusVisible: true,
    explicitSaveRetrySucceeded: true,
    reloadRetainsRecoveredDocument: true,
    beforeStorageRevision: beforeQuota.storageRevision,
    recoveredStorageRevision: afterRetry.storageRevision,
    injectionAfterRetry,
    staleAlertAfterRetry,
    uncaughtPageErrors: quotaErrors,
    screenshots: [`${directory}/quota-failure.png`, `${directory}/quota-recovered.png`],
  };
  await quotaContext.close();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
