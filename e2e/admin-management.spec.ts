import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { D1DatabaseLike, D1Statement } from '../src/lib/d1/types';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { handleD1Request } from '../src/lib/d1';
import { normalizeProjectDocument } from '../src/lib/comparison';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { DEFAULT_COLOR, EMPTY_MASK, type ProjectDocument } from '../src/lib/types';

test.use({ channel: 'chrome', actionTimeout: 15000 });
const apps = new WeakMap<Page, AuthenticatedApp>();
test.beforeEach(async ({ page }) => {
  const app = await authenticatedApp(page, { admin: true });
  // Surface underlying isolated D1 errors in the test log, never in production responses.
  const raw = app.env.DB;
  const originals = new WeakMap<D1Statement, D1Statement>();
  function statement(value: D1Statement, query: string): D1Statement {
    const wrapped = new Proxy(value, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => statement(target.bind(...args), query);
        if (key === 'first' || key === 'all' || key === 'run')
          return async (...args: unknown[]) => {
            try {
              return await (target[key] as (...values: unknown[]) => Promise<unknown>).apply(target, args);
            } catch (error) {
              console.error('ISOLATED_D1_ERROR', query, error);
              throw error;
            }
          };
        return Reflect.get(target, key);
      },
    });
    originals.set(wrapped, value);
    return wrapped;
  }
  app.env.DB = {
    prepare(query) {
      return statement(raw.prepare(query), query);
    },
    async batch(statements) {
      try {
        return await raw.batch(statements.map((value) => originals.get(value) ?? value));
      } catch (error) {
        console.error('ISOLATED_D1_BATCH_ERROR', error);
        throw error;
      }
    },
  } as D1DatabaseLike;
  apps.set(page, app);
});
test.afterEach(async ({ page }) => {
  await apps.get(page)?.dispose();
});
async function seedUser(app: AuthenticatedApp, name: string) {
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  await app.env.DB.prepare(
    'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)',
  )
    .bind(id, name, id + '@example.test', now, now)
    .run();
  return { id, name, email: id + '@example.test', isAdmin: false };
}
async function seedProject(app: AuthenticatedApp, comparison = false) {
  const owner = await seedUser(app, '프로젝트 소유 회원');
  const assetId = crypto.randomUUID();
  const png = new Uint8Array(
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#dddddd' } })
      .png()
      .toBuffer(),
  );
  const form = new FormData();
  form.set(
    'metadata',
    JSON.stringify({
      id: assetId,
      kind: 'original',
      name: 'private-room.png',
      width: 32,
      height: 32,
      ownerId: owner.id,
    }),
  );
  form.set('file', new Blob([png], { type: 'image/png' }), 'private-room.png');
  const uploaded = await handleD1Request(
    'assets',
    new Request('http://127.0.0.1:3000/api/d1/assets', { method: 'POST', body: form }),
    app.env,
    owner,
  );
  expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  const now = new Date().toISOString();
  const document = normalizeProjectDocument({
    id: crypto.randomUUID(),
    ownerId: owner.id,
    name: '다른 회원의 욕실',
    schemaVersion: 2,
    storageRevision: 0,
    editRevision: 0,
    createdAt: now,
    updatedAt: now,
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
    scene: {
      originalAssetId: assetId,
      previewAssetId: assetId,
      imageWidth: 32,
      imageHeight: 32,
      room: { ...DEFAULT_ROOM },
      surfaces: createRoomSurfaces(DEFAULT_ROOM),
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
  });
  if (comparison) {
    document.shared.comparison = {
      before: structuredClone(document.shared.baseline),
      room: { ...DEFAULT_ROOM },
      cameraVersion: 1,
      aspect: 1,
      referenceOriginalAssetId: assetId,
      referencePreviewAssetId: assetId,
      status: 'draft',
      review: { version: 2, analysis: 'manual', planes: [], candidates: [], warnings: [] },
    };
  }
  const response = await handleD1Request(
    'projects',
    new Request('http://127.0.0.1:3000/api/d1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'create', document }),
    }),
    app.env,
    owner,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return { owner, assetId, document: (await response.json()) as ProjectDocument };
}

test('회원 목록 25명 페이지·이름/email/ID 검색과 권한·정지 확인 및 자기 정지 보호', async ({
  page,
}, testInfo) => {
  const app = apps.get(page)!;
  const users = [];
  for (let i = 0; i < 26; i++) users.push(await seedUser(app, `검증 대상 ${String(i).padStart(2, '0')}`));
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: '회원 관리', exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(25);
  await page.getByRole('button', { name: '다음 25명 더 보기', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(27);
  const target = users[0];
  for (const q of [target.name, target.email, target.id]) {
    await page.getByLabel('회원 검색', { exact: true }).fill(q);
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody')).toContainText(target.email);
  }
  await page.getByRole('button', { name: target.name + ' 권한 변경', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '회원 변경 확인' });
  await expect(dialog).toContainText(target.email);
  await expect(dialog).toContainText(target.id);
  await dialog.getByRole('button', { name: '확인 후 변경' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('tbody')).toContainText('관리자');
  await page.getByRole('button', { name: target.name + ' 이용 상태 변경', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '확인 후 변경' })).toBeDisabled();
  await dialog.getByLabel('정지 사유', { exact: true }).fill('브라우저 격리 테스트');
  await dialog.getByRole('button', { name: '확인 후 변경' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('tbody')).toContainText('정지');
  await page.getByLabel('회원 검색', { exact: true }).fill(app.actor.id);
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: '브라우저 검증 회원 이용 상태 변경', exact: true }).click();
  await dialog.getByLabel('정지 사유', { exact: true }).fill('자기 정지 거부 검증');
  await dialog.getByRole('button', { name: '확인 후 변경' }).click();
  await expect(dialog.getByRole('alert')).toContainText(/자신|자기/);
  await page.screenshot({ path: testInfo.outputPath('admin-user-confirmation.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('admin-user-confirmation-mobile.png'), fullPage: true });
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByLabel('회원 검색', { exact: true }).fill('');
  await page.getByRole('combobox', { name: '권한', exact: true }).selectOption('admin');
  await page.getByRole('combobox', { name: '이용 상태', exact: true }).selectOption('suspended');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText(target.email);
  await expect(page.getByRole('link', { name: '0개 프로젝트', exact: true })).toHaveAttribute(
    'href',
    '/admin/projects?ownerId=' + target.id,
  );
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('admin-users-mobile.png'), fullPage: true });
  await page.getByRole('combobox', { name: '권한', exact: true }).selectOption('member');
  await expect(page.getByText('검색한 회원이 없어요.', { exact: true })).toBeVisible();
});

test('권한이 회수되면 관리자 내용과 메뉴를 제거한다', async ({ page }) => {
  const app = apps.get(page)!;
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: '회원 관리', exact: true })).toBeVisible();
  await app.env.DB.prepare('DELETE FROM admin_roles WHERE user_id=?').bind(app.actor.id).run();
  await page.evaluate(() => window.dispatchEvent(new Event('sjn-admin-role-changed')));
  await expect(page.getByRole('heading', { name: '관리자 전용', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.goto('/materials');
  await expect(page.getByRole('heading', { name: '내 공간을 완성할 자재' })).toBeVisible();
  await expect(page.getByRole('link', { name: '회원 관리', exact: true })).toHaveCount(0);
});

test('관리자 전체 프로젝트에서 소유자별 조회·편집·저장하며 소유권과 원본을 보존하고 영구 캐시를 남기지 않는다', async ({
  page,
}, testInfo) => {
  const app = apps.get(page)!;
  const { owner, assetId, document } = await seedProject(app);
  const calls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/')) calls.push(new URL(request.url()).pathname);
  });
  await page.goto(`/admin/projects?ownerId=${owner.id}`);
  await expect(page.getByLabel('소유자 ID', { exact: true })).toHaveValue(owner.id);
  await expect(page.locator('tbody')).toContainText(owner.email);
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /삭제|복제|소유자 이전/ })).toHaveCount(0);
  await page.getByRole('link', { name: '조회·수정', exact: true }).click();
  await expect(page.getByText(`관리자 편집 · ${owner.name} (${owner.email})`, { exact: true })).toBeVisible({
    timeout: 20000,
  });
  const title = page.getByRole('textbox', { name: '프로젝트명', exact: true });
  await expect(title).toHaveValue(document.name);
  await title.fill('관리자가 수정한 욕실');
  await title.press('Tab');
  await expect
    .poll(async () =>
      app.env.DB.prepare('SELECT name FROM d1_projects WHERE id=?')
        .bind(document.id)
        .first<{ name: string }>(),
      { timeout: 15000 },
    )
    .toMatchObject({ name: '관리자가 수정한 욕실' });
  await expect(page.getByTestId('save-status')).toContainText('클라우드에 저장됨');
  await page.screenshot({ path: testInfo.outputPath('admin-other-owner-workspace.png'), fullPage: true });
  await page.getByRole('button', { name: '시안 관리', exact: true }).click();
  await expect(page.getByRole('dialog', { name: /^시안 관리/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-other-owner-editor.png'), fullPage: true });
  const row = await app.env.DB.prepare('SELECT owner_id FROM d1_projects WHERE id=?')
    .bind(document.id)
    .first<{ owner_id: string }>();
  expect(row?.owner_id).toBe(owner.id);
  const metadata = await app.env.DB.prepare('SELECT owner_id FROM d1_assets WHERE id=?')
    .bind(assetId)
    .first<{ owner_id: string }>();
  expect(metadata?.owner_id).toBe(owner.id);
  expect(calls).toContain('/api/admin/project-assets');
  expect(calls).not.toContain('/api/d1/assets');
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map((entry) => entry.name));
  expect(databases).not.toContain('gongganmiri-cloud-recovery-v1');
  expect(databases).not.toContain('gongganmiri-design-previews-v1');
});

test('관리자 저장 실패는 메모리 초안을 유지하고 충돌 시 서버본을 확인한 뒤 명시적으로 다시 읽는다', async ({
  page,
}) => {
  test.setTimeout(90000);
  const app = apps.get(page)!;
  const { owner, document } = await seedProject(app);
  await page.goto(`/admin/projects/${document.id}`);
  const title = page.getByRole('textbox', { name: '프로젝트명', exact: true });
  await expect(title).toHaveValue(document.name, { timeout: 20000 });
  let failedSaves = 0;
  await page.route('**/api/admin/projects', async (route) => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().operation === 'save') {
      failedSaves++;
      return route.fulfill({ status: 503, json: { error: '격리 테스트 저장 장애' } });
    }
    return route.fallback();
  });
  await title.fill('실패해도 보존할 관리자 초안');
  await title.press('Tab');
  await expect(page.getByRole('alert').filter({ hasText: '격리 테스트 저장 장애' })).toBeVisible({
    timeout: 15000,
  });
  expect(failedSaves).toBeGreaterThan(0);
  await expect(title).toHaveValue('실패해도 보존할 관리자 초안');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '프로젝트 목록으로', exact: true }).click();
  await expect(title).toHaveValue('실패해도 보존할 관리자 초안');
  await page.unroute('**/api/admin/projects');
  await page.getByRole('button', { name: '저장 다시 시도', exact: true }).click();
  await expect(page.getByTestId('save-status')).toContainText('클라우드에 저장됨', { timeout: 20000 });

  const loaded = await handleD1Request(
    'projects',
    new Request('http://127.0.0.1:3000/api/d1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'load', id: document.id }),
    }),
    app.env,
    owner,
  );
  expect(loaded.status, await loaded.clone().text()).toBe(200);
  const current = (await loaded.json()) as ProjectDocument;
  const response = await handleD1Request(
    'projects',
    new Request('http://127.0.0.1:3000/api/d1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'save',
        document: { ...current, name: '소유자가 먼저 저장한 이름' },
        expectedStorageRevision: current.storageRevision,
      }),
    }),
    app.env,
    owner,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  await title.fill('충돌 당시 관리자 초안');
  await title.press('Tab');
  const conflict = page.getByRole('dialog', { name: '관리자 저장 충돌', exact: true });
  await expect(conflict).toBeVisible({ timeout: 15000 });
  await expect(title).toHaveValue('충돌 당시 관리자 초안');
  await conflict.getByRole('button', { name: '서버 저장본 확인', exact: true }).click();
  await expect(
    conflict.getByRole('button', { name: '서버본 사용 · 현재 초안 버리기', exact: true }),
  ).toBeVisible();
  await conflict.locator('summary').filter({ hasText: '서버 저장본' }).click();
  await expect(conflict.locator('pre').filter({ hasText: '소유자가 먼저 저장한 이름' })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await conflict.getByRole('button', { name: '서버본 사용 · 현재 초안 버리기', exact: true }).click();
  await expect(conflict).toHaveCount(0);
  await expect(title).toHaveValue('소유자가 먼저 저장한 이름');
  await title.fill('충돌 해결 뒤 자동 저장');
  await title.press('Tab');
  await expect(page.getByTestId('save-status')).toContainText('클라우드에 저장됨', { timeout: 15000 });
  await expect
    .poll(async () =>
      app.env.DB.prepare('SELECT name FROM d1_projects WHERE id=?')
        .bind(document.id)
        .first<{ name: string }>(),
    )
    .toMatchObject({ name: '충돌 해결 뒤 자동 저장' });
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map((entry) => entry.name));
  expect(databases).not.toContain('gongganmiri-cloud-recovery-v1');
  expect(databases).not.toContain('gongganmiri-design-previews-v1');
});


test('관리자 타인 사진 재분석은 모의 분석을 저장하고 사진 파생 영구 캐시를 남기지 않는다', async ({
  page,
}, testInfo) => {
  const app = apps.get(page)!;
  const { owner, assetId, document } = await seedProject(app, true);
  // Authored masks verify UI/storage boundaries only; no AI inference or model download.
  await page.addInitScript(() => {
    const calls = { jobs: 0, terminated: 0 };
    Object.assign(window, { __adminMockSegmentation: calls });
    class MockSegmentationWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      stopped = false;
      postMessage(message: { id: number }) {
        calls.jobs++;
        queueMicrotask(() => {
          if (this.stopped) return;
          this.onmessage?.(
            new MessageEvent('message', {
              data: {
                id: message.id,
                type: 'result',
                result: {
                  width: 8,
                  height: 8,
                  floor: new Uint8Array(64),
                  wall: new Uint8Array(64),
                  objects: [],
                },
              },
            }),
          );
        });
      }
      terminate() {
        if (!this.stopped) calls.terminated++;
        this.stopped = true;
      }
    }
    window.Worker = MockSegmentationWorker as unknown as typeof Worker;
  });
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(`/admin/projects/${document.id}`);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
  const beforeEditing = page.getByRole('button', { name: '기존 공간 수정', exact: true });
  if (await beforeEditing.isVisible()) await beforeEditing.click();
  await page.getByRole('button', { name: '사진 다시 분석', exact: true }).click();
  const rebuild = page.getByRole('dialog', { name: 'Before 사진 다시 분석', exact: true });
  await expect(rebuild.getByRole('radio', { name: /브라우저 기본 분석/ })).toBeChecked();
  await rebuild.getByRole('button', { name: 'Before 다시 만들기', exact: true }).click();
  await expect(rebuild).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
  const loaded = await handleD1Request(
    'projects',
    new Request('http://127.0.0.1:3000/api/d1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'load', id: document.id }),
    }),
    app.env,
    owner,
  );
  expect(loaded.status, await loaded.clone().text()).toBe(200);
  const saved = (await loaded.json()) as ProjectDocument;
  expect(saved.ownerId).toBe(owner.id);
  expect(saved.shared.comparison?.referenceOriginalAssetId).toBe(assetId);
  expect(saved.shared.comparison?.review?.analysis).not.toBe('manual');
  expect(saved.shared.comparison?.review?.analysisProfile).toBe('browser-basic');
  // The editor initializes empty usage/render metadata on legacy input; the After scene is preserved.
  expect(saved.designs).toMatchObject(document.designs);
  expect(saved.designs.map((design) => design.scene)).toEqual(document.designs.map((design) => design.scene));
  expect(
    await page.evaluate(
      () => (window as unknown as { __adminMockSegmentation: { jobs: number; terminated: number } })
        .__adminMockSegmentation,
    ),
  ).toEqual({ jobs: 1, terminated: 1 });
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map((entry) => entry.name));
  for (const name of [
    'sjn-reconstruction-cloud-stages',
    'sjn-reconstruction-segmentation',
    'sjn-browser-geometry-stages',
    'sjn-reconstruction-diagnostics',
    'gongganmiri-cloud-recovery-v1',
    'gongganmiri-design-previews-v1',
  ]) expect(databases).not.toContain(name);
  expect(failures).toEqual([]);
  await testInfo.attach('mock-admin-reanalysis-privacy', {
    body: JSON.stringify({ source: 'Authored masks; actual AI calls = 0', ownerId: saved.ownerId, databases }),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath('admin-reanalysis-transient.png'), fullPage: true });
});
