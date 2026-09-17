import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { normalizeProjectDocument } from '../src/lib/comparison';
import { DEFAULT_COLOR, EMPTY_MASK, type ProjectDocument } from '../src/lib/types';

test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(90000);

/** Auth/storage responses here are deliberate control-flow fixtures, not live D1 or Google verification. */
async function cloudFixture(page: Page) {
  const ownerId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    assetId = crypto.randomUUID();
  let document = normalizeProjectDocument({
    id,
    ownerId,
    name: '클라우드 편집 테스트',
    schemaVersion: 2,
    storageRevision: 1,
    editRevision: 0,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
    scene: {
      originalAssetId: assetId,
      previewAssetId: assetId,
      imageWidth: 300,
      imageHeight: 200,
      surfaces: [],
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
  });
  const fixture = {
    failure: 0,
    accountChanged: false,
    saves: [] as { time: number; document: ProjectDocument; expected: number }[],
    get server() {
      return document;
    },
    set server(value: ProjectDocument) {
      document = value;
    },
  };
  const image = await sharp({ create: { width: 300, height: 200, channels: 4, background: '#e1dfd9' } })
    .png()
    .toBuffer();
  page.on('dialog', async (dialog) => {
    await dialog.accept();
  });
  await page.route('**/api/storage/status', (route) =>
    route.fulfill({
      json: {
        mode: 'd1',
        ready: true,
        reason: 'ready',
        authRequired: true,
      },
    }),
  );
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({ json: { user: { id: ownerId, email: 'fixture@example.test' } } }),
  );
  await page.route('**/api/d1/role', (route) => route.fulfill({ json: { isAdmin: false } }));
  await page.route('**/api/d1/materials', (route) => route.fulfill({ json: [] }));
  const contentHash = createHash('sha256').update(image).digest('hex');
  await page.route('**/api/d1/assets?*', (route) => {
    if (new URL(route.request().url()).searchParams.get('raw') === '1')
      return route.fulfill({ contentType: 'image/png', body: image });
    return route.fulfill({
      json: {
        asset: {
          id: assetId,
          ownerId,
          name: 'fixture.png',
          kind: 'original',
          mime: 'image/png',
          size: image.length,
          width: 300,
          height: 200,
          createdAt: document.createdAt,
        },
        contentHash,
        url: '/api/d1/assets?id=' + assetId + '&raw=1',
      },
    });
  });
  await page.route('**/api/d1/projects', async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation === 'save') {
      fixture.saves.push({
        time: Date.now(),
        document: body.document,
        expected: body.expectedStorageRevision,
      });
      if (fixture.failure)
        return route.fulfill({
          status: fixture.failure,
          json: { error: '테스트 저장 실패', ...(fixture.accountChanged ? { code: 'ACCOUNT_CHANGED' } : {}) },
        });
      if (body.expectedStorageRevision !== document.storageRevision)
        return route.fulfill({ status: 409, json: { error: '충돌' } });
      document = {
        ...body.document,
        storageRevision: document.storageRevision + 1,
        updatedAt: new Date().toISOString(),
      };
      return route.fulfill({ json: document });
    }
    if (body.operation === 'list')
      return route.fulfill({
        json: [
          {
            id: document.id,
            name: document.name,
            updatedAt: document.updatedAt,
            previewAssetId: assetId,
            activeDesignId: document.activeDesignId,
            activeDesignRevision: 0,
            sharedRevision: 0,
          },
        ],
      });
    if (body.operation === 'create') return route.fulfill({ json: { ...body.document, storageRevision: 1 } });
    return route.fulfill({ json: document });
  });
  await page.goto('/projects/' + id);
  await expect(page.getByLabel('프로젝트명', { exact: true })).toHaveValue(document.name);
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  await expect(page.locator('.editor-error')).toHaveCount(0);
  return fixture;
}
async function drafts(page: Page, store = 'drafts') {
  return page.evaluate(async (storeName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gongganmiri-cloud-recovery-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ document: ProjectDocument; scope: { userId: string } }[]>(
        (resolve, reject) => {
          const request = database.transaction(storeName).objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        },
      );
    } finally {
      database.close();
    }
  }, store);
}

test('cloud autosave keeps a 500ms local recovery before the coalesced 2s save, with no Before-only writes', async ({
  page,
}) => {
  const fixture = await cloudFixture(page);
  const started = Date.now();
  await page.getByLabel('프로젝트명', { exact: true }).fill('수정한 클라우드 프로젝트');
  await expect(page.getByTestId('recovery-status')).toHaveText('이 기기에 복구본 저장됨');
  expect(fixture.saves).toHaveLength(0);
  expect((await drafts(page))[0].document.name).toBe('수정한 클라우드 프로젝트');
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
  expect(fixture.saves).toHaveLength(1);
  expect(fixture.saves[0].time - started).toBeGreaterThanOrEqual(1500);
  await expect.poll(async () => (await drafts(page)).length).toBe(0);
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await page.waitForTimeout(2200);
  expect(fixture.saves).toHaveLength(1);
});

test('failed server save retains account-scoped recovery through reload and explicit retry without local fallback', async ({
  page,
}) => {
  const fixture = await cloudFixture(page);
  fixture.failure = 503;
  await page.getByLabel('프로젝트명', { exact: true }).fill('서버에 못 보낸 작업');
  await expect(page.getByTestId('save-status')).toContainText('저장 실패');
  await expect(page.getByTestId('recovery-status')).toHaveText('이 기기에 복구본 저장됨');
  expect((await drafts(page))[0].document.ownerId).toBe(fixture.server.ownerId);
  await page.reload();
  const recovery = page.getByRole('dialog', { name: '클라우드 작업 복구' });
  await expect(recovery).toBeVisible();
  expect(fixture.server.name).toBe('클라우드 편집 테스트');
  await recovery.getByRole('button', { name: '복구본 이어서 편집', exact: true }).click();
  await expect(page.getByLabel('프로젝트명', { exact: true })).toHaveValue('서버에 못 보낸 작업');
  await expect(page.getByTestId('save-status')).toContainText('저장 실패');
  fixture.failure = 0;
  await page.getByRole('button', { name: '저장 다시 시도', exact: true }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
  expect(fixture.server.name).toBe('서버에 못 보낸 작업');
  await expect.poll(async () => (await drafts(page)).length).toBe(0);
});

test('conflicting recovery preserves server and archived draft and resumes later edits using the server revision', async ({
  page,
}) => {
  const fixture = await cloudFixture(page);
  fixture.failure = 503;
  await page.getByLabel('프로젝트명', { exact: true }).fill('기기에 보관할 작업');
  await expect(page.getByTestId('save-status')).toContainText('저장 실패');
  fixture.server = { ...fixture.server, name: '다른 탭의 서버 작업', storageRevision: 2, editRevision: 4 };
  fixture.failure = 0;
  await page.reload();
  const recovery = page.getByRole('dialog', { name: '클라우드 작업 복구' });
  await expect(recovery).toContainText('서버 저장본과 다른 복구본');
  await expect(recovery.getByRole('button', { name: '복구본 이어서 편집', exact: true })).toHaveCount(0);
  await recovery.getByRole('button', { name: '서버 저장본 사용 · 복구본 보관' }).click();
  await expect(recovery).toHaveCount(0);
  await expect(page.getByLabel('프로젝트명', { exact: true })).toHaveValue('다른 탭의 서버 작업');
  expect((await drafts(page, 'archive'))[0].document.name).toBe('기기에 보관할 작업');
  await page.getByLabel('프로젝트명', { exact: true }).fill('충돌 해결 뒤 새 편집');
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
  expect(fixture.saves.at(-1)!.expected).toBe(2);
  expect(fixture.server.name).toBe('충돌 해결 뒤 새 편집');
  expect((await drafts(page, 'archive'))[0].document.name).toBe('기기에 보관할 작업');
});

test('만료된 세션은 편집기를 숨기고 본인 복구본을 유지하며 재인증 후 복구한다', async ({ page }) => {
  const fixture = await cloudFixture(page);
  fixture.failure = 401;
  await page.getByLabel('프로젝트명', { exact: true }).fill('세션 만료 뒤에도 보관');
  await expect(page.getByRole('button', { name: 'Google로 다시 로그인', exact: true })).toBeVisible();
  await expect(page.getByLabel('프로젝트명', { exact: true })).toHaveCount(0);
  expect((await drafts(page))[0].document.name).toBe('세션 만료 뒤에도 보관');
  expect(fixture.saves).toHaveLength(1);
  fixture.failure = 0;
  await page.reload();
  const recovery = page.getByRole('dialog', { name: '클라우드 작업 복구' });
  await expect(recovery).toBeVisible();
  await recovery.getByRole('button', { name: '복구본 이어서 편집', exact: true }).click();
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
  expect(fixture.server.name).toBe('세션 만료 뒤에도 보관');
});

test('unexpected account replacement checkpoints the old account then removes its private editor without sending a second save', async ({
  page,
}) => {
  const fixture = await cloudFixture(page);
  fixture.failure = 401;
  fixture.accountChanged = true;
  await page.getByLabel('프로젝트명', { exact: true }).fill('이전 계정의 마지막 작업');
  await expect(page.getByLabel('프로젝트명', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('editor-canvas')).toHaveCount(0);
  const retained = await drafts(page);
  expect(retained).toHaveLength(1);
  expect(retained[0].document.name).toBe('이전 계정의 마지막 작업');
  expect(retained[0].scope.userId).toBe(fixture.server.ownerId);
  await page.waitForTimeout(2200);
  expect(fixture.saves).toHaveLength(1);
  expect(fixture.server.name).toBe('클라우드 편집 테스트');
});

test('SPA back navigation before the recovery debounce still retains the departing cloud draft', async ({
  page,
}) => {
  const fixture = await cloudFixture(page);
  // Establish a same-app history entry without involving a browser reload or a model.
  await page.getByRole('button', { name: '프로젝트 목록으로', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('heading', { name: fixture.server.name, exact: true }).click();
  await expect(page.getByLabel('프로젝트명', { exact: true })).toHaveValue(fixture.server.name);
  await page.getByLabel('프로젝트명', { exact: true }).fill('즉시 뒤로 이동한 작업');
  await page.goBack();
  await expect
    .poll(async () => {
      const records = await drafts(page);
      return records[0]?.document.name ?? fixture.server.name;
    })
    .toBe('즉시 뒤로 이동한 작업');
});

test('예전 로컬 설정 응답으로는 익명 편집기를 열 수 없다', async ({ page }) => {
  await page.route('**/api/storage/status', (route) =>
    route.fulfill({ json: { mode: 'local', ready: true, reason: 'local_environment', authRequired: false } }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '공간미리 로그인' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Google로 시작하기', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '기본 공간으로 시작' })).toHaveCount(0);
});
