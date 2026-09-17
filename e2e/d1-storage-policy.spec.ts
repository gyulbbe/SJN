import { expect, test, type Page } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';

// Mock Google identity only; every project, catalog and asset call uses isolated real D1/R2 handlers.
// No production data, external OAuth or AI/model calls are allowed by authenticatedApp.
test.use({ channel: 'chrome', actionTimeout: 15000 });
const apps = new WeakMap<Page, AuthenticatedApp>();
test.afterEach(async ({ page }) => {
  await apps.get(page)?.dispose();
});
const legacyNames = ['gongganmiri-v1', 'sjn-local-catalog-v1'];
const color = {
  id: '84dcbb0c-66bd-4c1e-96c7-50ae5b6d4c4d',
  kind: 'color',
  name: '브라우저 전용 가짜색',
  active: true,
  sortOrder: -100,
};
const localCatalog = JSON.stringify({ options: [color], subcategories: [] });

async function preserveAndAuditLegacyStores(page: Page) {
  await page.route('**/__storage-policy-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Storage isolation fixture</title>',
    }),
  );
  await page.goto('/__storage-policy-fixture');
  await page.evaluate(
    async ({ names, catalog }) => {
      for (const name of names) {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name, 1);
          request.onupgradeneeded = () => request.result.createObjectStore('sentinels');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction('sentinels', 'readwrite');
          transaction
            .objectStore('sentinels')
            .put({ untouched: name, bytes: new Blob(['preserved original bytes']) }, 'source');
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
        database.close();
      }
      localStorage.setItem('sjn-local-catalog-v1', catalog);
    },
    { names: legacyNames, catalog: localCatalog },
  );
  const touches: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('SJN_LEGACY_STORE_TOUCH:')) touches.push(message.text());
  });
  await page.addInitScript(
    ({ names }) => {
      const watch = (name: string, method: string) => {
        if (names.includes(name)) console.debug(`SJN_LEGACY_STORE_TOUCH:${method}:${name}`);
      };
      const open = IDBFactory.prototype.open;
      const getItem = Storage.prototype.getItem;
      IDBFactory.prototype.open = function (name, version) {
        watch(name, 'open');
        return open.call(this, name, version);
      };
      const removeDatabase = IDBFactory.prototype.deleteDatabase;
      IDBFactory.prototype.deleteDatabase = function (name) {
        watch(name, 'deleteDatabase');
        return removeDatabase.call(this, name);
      };
      Storage.prototype.getItem = function (key) {
        watch(key, 'getItem');
        return getItem.call(this, key);
      };
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        watch(key, 'setItem');
        return setItem.call(this, key, value);
      };
      const removeItem = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) {
        watch(key, 'removeItem');
        return removeItem.call(this, key);
      };
      const clear = Storage.prototype.clear;
      Storage.prototype.clear = function () {
        console.debug('SJN_LEGACY_STORE_TOUCH:clear');
        return clear.call(this);
      };
      // Read only in the assertion via the original methods, without counting the test's own verification as app use.
      (window as unknown as { inspectLegacyStores: () => Promise<unknown> }).inspectLegacyStores =
        async () => {
          const values = [];
          for (const name of names) {
            const database = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = open.call(indexedDB, name);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            const value = await new Promise<{ untouched: string; bytes: Blob }>((resolve, reject) => {
              const request = database.transaction('sentinels').objectStore('sentinels').get('source');
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            values.push({ name, untouched: value.untouched, bytes: await value.bytes.text() });
            database.close();
          }
          return { values, catalog: getItem.call(localStorage, 'sjn-local-catalog-v1') };
        };
    },
    { names: legacyNames },
  );
  return async () => {
    expect(touches, 'The application must not access or delete preserved legacy stores').toEqual([]);
    expect(
      await page.evaluate(() =>
        (window as unknown as { inspectLegacyStores: () => Promise<unknown> }).inspectLegacyStores(),
      ),
    ).toEqual({
      values: legacyNames.map((name) => ({ name, untouched: name, bytes: 'preserved original bytes' })),
      catalog: localCatalog,
    });
  };
}

test('회원 프로젝트 생성·편집·재진입은 D1/R2만 저장하고 예전 브라우저 원본은 건드리지 않는다', async ({
  page,
}, testInfo) => {
  test.setTimeout(150000);
  const app = await authenticatedApp(page, { admin: false });
  apps.set(page, app);
  const verifyLegacy = await preserveAndAuditLegacyStores(page);
  const calls: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/d1/assets') calls.push(url.search);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정', exact: true })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 30000 });
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await page.getByLabel('프로젝트명', { exact: true }).fill('D1에만 저장하는 프로젝트');
  await page.getByLabel('프로젝트명', { exact: true }).press('Tab');
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  const saved = await app.project();
  expect(saved.name).toBe('D1에만 저장하는 프로젝트');
  expect(saved.ownerId).toBe(app.actor.id);
  const row = await app.env.DB.prepare('SELECT object_key FROM d1_projects WHERE id=? AND owner_id=?')
    .bind(saved.id, app.actor.id)
    .first<{ object_key: string }>();
  expect(row).toBeTruthy();
  const savedObject = await app.env.ASSET_BUCKET.get(row!.object_key);
  expect(savedObject).toBeTruthy();
  expect(JSON.parse(await savedObject!.text())).toMatchObject({
    id: saved.id,
    name: saved.name,
  });
  await verifyLegacy();
  calls.length = 0;
  await page.reload();
  await expect(page.getByLabel('프로젝트명', { exact: true })).toHaveValue(saved.name);
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 30000 });
  expect(calls.filter((query) => query.includes('id=') && !query.includes('raw=1')).length).toBeGreaterThan(
    0,
  );
  expect(
    calls.filter((query) => query.includes('raw=1')),
    'Authorized immutable blobs should be reused after reload',
  ).toEqual([]);
  await verifyLegacy();
  await testInfo.attach('storage-policy', {
    contentType: 'application/json',
    body: JSON.stringify(
      {
        auth: 'mock Google identity, isolated real D1/R2',
        projectId: saved.id,
        reentryAssetRequests: calls,
        legacyAccesses: 0,
      },
      null,
      2,
    ),
  });
});

test('관리자 속성 선택은 로컬 분류를 무시하고 등록된 D1 값만 보여 준다', async ({ page }, testInfo) => {
  const app = await authenticatedApp(page, { admin: true });
  apps.set(page, app);
  const verifyLegacy = await preserveAndAuditLegacyStores(page);
  await page.goto('/admin/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).first().click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true }),
    input = form.getByRole('combobox', { name: '색상', exact: true });
  await input.fill('브라우저 전용');
  await expect(form.getByRole('option', { name: color.name, exact: true })).toHaveCount(0);
  await expect(form.getByText('등록된 항목이 없어요.', { exact: true })).toBeVisible();
  await input.fill('그레');
  await expect(form.getByRole('option', { name: '그레이', exact: true })).toBeVisible();
  await form.getByRole('option', { name: '그레이', exact: true }).click();
  await expect(form.getByRole('button', { name: '색상 그레이 제거', exact: true })).toBeVisible();
  await verifyLegacy();
  await form.screenshot({ path: testInfo.outputPath('d1-only-catalog.png') });
});
