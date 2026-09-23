import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { handleD1Request } from '../src/lib/d1';
import { getActiveDesign } from '../src/lib/designs';
import type { ProjectDocument, MaterialInput, MaterialVersion } from '../src/lib/types';

test.use({ channel: 'chrome', hasTouch: true, actionTimeout: 15000 });
test.setTimeout(150000);
let app: AuthenticatedApp;
let calls: { path: string; method: string; body: string | null }[];
let versions: MaterialVersion[];
let modelRequests: string[];
const draftKey = 'sjn:guest-draft:v1';
async function seed() {
  const png = new Uint8Array(
    await sharp({ create: { width: 120, height: 120, channels: 4, background: '#adc9bd' } })
      .png()
      .toBuffer(),
  );
  const results: MaterialVersion[] = [];
  for (const category of ['tile', 'basin'] as const) {
    const id = crypto.randomUUID();
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({ id, name: 'guest-test.png', kind: category === 'tile' ? 'texture' : 'product' }),
    );
    form.set('file', new Blob([png], { type: 'image/png' }), 'guest-test.png');
    const uploaded = await handleD1Request(
      'assets',
      new Request('https://test/api/d1/assets', { method: 'POST', body: form }),
      app.env,
      app.actor,
    );
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const input: MaterialInput = {
      name: category === 'tile' ? '체험 그레이 타일' : '체험 벽걸이 세면대',
      brand: '',
      code: '',
      category,
      scope: 'shared',
      description: '격리 검증 자재',
      color: '',
      finish: '',
      widthMm: 600,
      heightMm: category === 'tile' ? 600 : 450,
      depthMm: 400,
      usage: category === 'tile' ? 'both' : 'wall',
      installation: 'wall',
      coverAssetId: id,
      imageAssetIds: [id],
      textureAssetIds: category === 'tile' ? [id] : [],
      views: category === 'tile' ? [] : [{ assetId: id, direction: '정면', anchor: { x: 0.5, y: 1 } }],
      defaultGroutWidth: 2,
      defaultGroutColor: '#ffffff',
      defaultPattern: 'grid',
      pricing:
        category === 'tile'
          ? { unit: 'box', unitPrice: 40000, boxCoverageM2: 1.44, piecesPerBox: 4, wastePercent: 0 }
          : { unit: 'piece', unitPrice: 150000, boxCoverageM2: null, piecesPerBox: null, wastePercent: 0 },
    };
    const created = await handleD1Request(
      'materials',
      new Request('https://test/api/d1/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'create', input }),
      }),
      app.env,
      app.actor,
    );
    expect(created.status, await created.clone().text()).toBe(200);
    results.push((await created.json()) as MaterialVersion);
  }
  await app.env.DB.prepare('DELETE FROM admin_roles WHERE user_id=?').bind(app.actor.id).run();
  app.actor.isAdmin = false;
  return results;
}
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false, admin: true });
  versions = await seed();
  modelRequests = [];
  calls = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (/\/models\/|\.(onnx|safetensors|gguf)(?:$|\?)/i.test(u.pathname)) modelRequests.push(u.pathname);
    if (u.pathname.startsWith('/api/'))
      calls.push({ path: u.pathname, method: r.method(), body: r.postData() });
  });
});
test.afterEach(async () => {
  try {
    expect(modelRequests).toEqual([]);
  } finally {
    await app?.dispose();
  }
});
async function draft(page: Page): Promise<ProjectDocument> {
  return page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).document, draftKey);
}
async function create(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '공간 크기 설정' });
  await dialog.getByRole('spinbutton', { name: '가로 (m)' }).fill('2.8');
  await dialog.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/try$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
}
async function place(page: Page) {
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await page.getByRole('textbox', { name: '편집기 자재 검색' }).fill('그레이');
  await page.locator('button.material-tile').filter({ hasText: '체험 그레이 타일' }).click();
  await expect
    .poll(async () =>
      getActiveDesign(await draft(page))!.scene.surfaces.some((s) => s.materialVersionId === versions[0].id),
    )
    .toBe(true);
  await page.getByRole('textbox', { name: '편집기 자재 검색' }).fill('');
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '체험 벽걸이 세면대' }).click();
  await expect.poll(async () => getActiveDesign(await draft(page))!.scene.fixtures.length).toBe(1);
}
function guestWrites() {
  return calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/api/auth/'));
}
async function dialogLocked(page: Page, button: string) {
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect(page.getByRole('dialog', { name: '로그인 / 회원가입' })).toBeVisible();
  await page.getByRole('button', { name: '로그인 안내 닫기', exact: true }).click();
}

test('게스트가 자재를 배치·실행 취소하고 새로고침해도 보존하며 회원 기능은 잠긴다', async ({ page }) => {
  await create(page);
  await place(page);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => getActiveDesign(await draft(page))!.scene.fixtures.length).toBe(0);
  await page.keyboard.press('Control+y');
  await expect.poll(async () => getActiveDesign(await draft(page))!.scene.fixtures.length).toBe(1);
  const before = await draft(page);
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect.poll(async () => getActiveDesign(await draft(page))!.scene.fixtures.length).toBe(1);
  expect((await draft(page)).id).toBe(before.id);
  expect((await draft(page)).shared.baseline.room?.widthMm).toBe(2800);
  for (const name of ['공간 둘러보기', '공간 크기', '내보내기', '지금 저장']) await dialogLocked(page, name);
  await page.getByRole('button', { name: /AI 고화질 보정/ }).click();
  await expect(page.getByRole('dialog', { name: '로그인 / 회원가입' })).toBeVisible();
  await page.getByRole('button', { name: '로그인 안내 닫기', exact: true }).click();
  for (const name of ['Before', '드래그 비교', 'After']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('dialog', { name: '로그인 / 회원가입' })).toHaveCount(0);
  }
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('dialog', { name: '로그인 / 회원가입' })).toBeVisible();
  await page.getByRole('button', { name: '로그인 안내 닫기', exact: true }).click();
  expect(guestWrites()).toEqual([]);
  expect(calls.some((c) => /reconstruction|photoreal|diagnostics/.test(c.path))).toBe(false);
  expect(await app.env.DB.prepare('SELECT COUNT(*) AS n FROM d1_projects').first()).toEqual({ n: 0 });
  await page.screenshot({ path: 'test-results/guest-workspace-desktop.png', fullPage: true });
});

test('모의 Google 왕복 후 여러 시안·수정 견적·비교 선택을 본인 프로젝트로 한 번만 저장한다', async ({
  page,
}) => {
  await create(page);
  await place(page);
  const price = page.getByLabel('체험 벽걸이 세면대 단가 (원)', { exact: true });
  await price.fill('175000');
  await price.press('Enter');
  await expect(page.getByTestId('usage-total')).toHaveText('375,000원');
  const original = getActiveDesign(await draft(page))!;
  await page.getByRole('button', { name: '시안 관리', exact: true }).click();
  const manager = page.getByRole('dialog', { name: /^시안 관리/ });
  await manager.getByRole('button', { name: original.name + ' 복제', exact: true }).click();
  await expect.poll(async () => (await draft(page)).designs.length).toBe(2);
  const copied = (await draft(page)).designs.find((design) => design.id !== original.id)!;
  await manager.getByRole('checkbox', { name: original.name + ' 비교 선택', exact: true }).check();
  await manager.getByRole('checkbox', { name: copied.name + ' 비교 선택', exact: true }).check();
  await manager.getByRole('button', { name: '시안 관리 닫기', exact: true }).click();
  await expect.poll(async () => (await draft(page)).comparisonDesignIds.length).toBe(2);
  const before = await draft(page);
  for (const design of before.designs) {
    const fixture = design.scene.fixtures[0];
    expect(design.materialUsage!.assignments[fixture.id].pricing.unitPrice).toBe(175000);
  }
  expect(guestWrites()).toEqual([]);
  const origin = new URL(page.url()).origin;
  await page.route('**/api/auth/sign-in/social', (route) =>
    route.fulfill({ json: { url: 'https://accounts.google.com/o/oauth2/auth?sjn-fixture=1' } }),
  );
  await page.route('https://accounts.google.com/**', async (route) => {
    app.signIn();
    await route.fulfill({ status: 302, headers: { location: origin + '/try?resume=1' } });
  });
  await page.getByRole('button', { name: '로그인 / 회원가입', exact: true }).first().click();
  await page.getByRole('button', { name: 'Google로 계속하기', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/projects/' + before.id + '$'), { timeout: 60000 });
  const saved = await app.project(before.id);
  expect(saved.ownerId).toBe(app.actor.id);
  expect(saved.designs).toEqual(before.designs);
  expect(saved.comparisonDesignIds).toEqual(before.comparisonDesignIds);
  expect(saved.activeDesignId).toBe(before.activeDesignId);
  expect(saved.shared.baseline.room).toEqual(before.shared.baseline.room);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
  expect(await app.env.DB.prepare('SELECT COUNT(*) AS n FROM d1_projects').first()).toEqual({ n: 1 });
  const signIn = calls.find((c) => c.path === '/api/auth/sign-in/social');
  expect(JSON.parse(signIn!.body!)).toMatchObject({
    callbackURL: '/try?resume=1',
    errorCallbackURL: '/login?authError=google&resume=guest',
  });
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  expect(await app.env.DB.prepare('SELECT COUNT(*) AS n FROM d1_projects').first()).toEqual({ n: 1 });
});

test('체험 자재 패널에서 사이즈 분류를 열어 선택하고 해제한다', async ({ page }) => {
  await create(page);
  const catalog = page.locator('aside.catalog-panel');
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await catalog.screenshot({ path: 'test-results/facets/editor-1440-closed.png', animations: 'disabled' });
  const toggle = catalog.getByRole('button', { name: /^사이즈/ });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const size = catalog.getByRole('group', { name: '사이즈' }).getByRole('checkbox', { name: '600X600', exact: true });
  await size.check();
  await expect(toggle).toHaveAccessibleName('사이즈 1개 선택');
  await expect(catalog.locator('button.material-tile').filter({ hasText: '체험 그레이 타일' })).toBeVisible();
  await catalog.screenshot({ path: 'test-results/facets/editor-1440-open.png', animations: 'disabled' });
  // Fixtures have no 600X600 option, so the tile-only choice is ignored there.
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await expect(catalog.locator('button.material-tile').filter({ hasText: '체험 벽걸이 세면대' })).toBeVisible();
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await size.uncheck();
  await expect(toggle).toHaveAccessibleName('사이즈');
  // Escape closes only the panel, not the editor's catalog drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '자재 목록', exact: true }).click();
  await expect(catalog).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await size.check();
  await page.screenshot({ path: 'test-results/facets/editor-390-drawer-open.png', animations: 'disabled' });
  // From the button (not an input) the editor's window Escape would otherwise close the drawer.
  await toggle.focus();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await expect(catalog).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
});

test('체험 중 아이디로 회원가입하면 체험 작업을 본인 프로젝트로 저장한다', async ({ page }) => {
  await create(page);
  await place(page);
  const before = await draft(page);
  const signUps: unknown[] = [];
  await page.route('**/api/auth/sign-up/email', async (route) => {
    signUps.push(route.request().postDataJSON());
    app.signIn();
    await route.fulfill({ json: { token: 'test-only', user: { id: app.actor.id } } });
  });
  await page.getByRole('button', { name: '로그인 / 회원가입', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '로그인 / 회원가입', exact: true });
  await dialog.getByRole('button', { name: '회원가입', exact: true }).click();
  await dialog.getByRole('textbox', { name: '아이디', exact: true }).fill('guest_member');
  await dialog.getByLabel('비밀번호', { exact: true }).fill('password-1');
  await dialog.getByLabel('비밀번호 확인', { exact: true }).fill('password-1');
  await dialog.getByRole('button', { name: '회원가입하기', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/projects/' + before.id + '$'), { timeout: 60000 });
  expect(signUps).toEqual([{ username: 'guest_member', password: 'password-1' }]);
  const saved = await app.project(before.id);
  expect(saved.ownerId).toBe(app.actor.id);
  expect(saved.designs).toEqual(before.designs);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
});

test('로그인 취소와 sessionStorage 실패 때 체험 상태를 버리거나 OAuth로 이동하지 않는다', async ({
  page,
}) => {
  await create(page);
  await place(page);
  const before = await draft(page);
  await page.goto('/login?authError=google&error=access_denied&resume=guest');
  await expect(page.locator('main').getByRole('alert')).toContainText('취소');
  await page.getByRole('link', { name: '← 체험 작업으로 돌아가기' }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  expect((await draft(page)).id).toBe(before.id);
  await page.evaluate(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException('Full', 'QuotaExceededError');
    };
  });
  await page.getByRole('button', { name: '로그인 / 회원가입', exact: true }).first().click();
  await page.getByRole('button', { name: 'Google로 계속하기', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('보관');
  expect(calls.some((c) => c.path === '/api/auth/sign-in/social')).toBe(false);
  expect((await draft(page)).id).toBe(before.id);
});

test('모바일 터치로 체험 생성하고 사진 기능은 로그인 안내로 연결한다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '사진으로 시작', exact: true }).tap();
  await expect(page.getByRole('dialog', { name: '로그인 / 회원가입' })).toBeVisible();
  await page.getByRole('button', { name: '로그인 안내 닫기' }).tap();
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).tap();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).tap();
  await expect(page).toHaveURL(/\/try$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await page.getByRole('button', { name: '자재 목록', exact: true }).tap();
  await page.getByRole('button', { name: '위생도기', exact: true }).tap();
  await page.locator('button.material-tile').filter({ hasText: '체험 벽걸이 세면대' }).tap();
  await expect.poll(async () => getActiveDesign(await draft(page))!.scene.fixtures.length).toBe(1);
  await page.getByRole('button', { name: '자재 수량·금액 및 속성', exact: true }).tap();
  await expect(page.getByLabel('제품 배율', { exact: true })).toBeVisible();
  await expect(page.getByTestId('usage-total')).toHaveText('150,000원');
  const mobilePrice = page.getByLabel('체험 벽걸이 세면대 단가 (원)', { exact: true });
  await mobilePrice.tap();
  await mobilePrice.fill('160000');
  await mobilePrice.press('Enter');
  await expect(page.getByTestId('usage-total')).toHaveText('160,000원');
  await expect(page.getByLabel('노출', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '제품 삭제', exact: true }).tap();
  await expect.poll(async () => getActiveDesign(await draft(page))!.scene.fixtures.length).toBe(0);
  await page.getByRole('button', { name: '사용 내역 닫기', exact: true }).tap();
  expect(guestWrites()).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/guest-workspace-mobile.png', fullPage: true });
});

test('체험 제품과 오른쪽 공간 크기를 조절하고 상단 보호 기능은 로그인 안내로 연결한다', async ({ page }) => {
  await create(page);
  await place(page);
  const before = getActiveDesign(await draft(page))!.scene.fixtures[0];
  const box = await page.locator('rect[data-entity="' + before.id + '"]').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 30, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => getActiveDesign(await draft(page))!.scene.fixtures[0].roomPlacement!.u)
    .not.toBe(before.roomPlacement!.u);
  await page.getByLabel('제품 배율', { exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Tab');
  await expect
    .poll(async () => getActiveDesign(await draft(page))!.scene.fixtures[0].roomPlacement!.scale)
    .toBe(1.01);
  await page.getByLabel('이미지 평면 회전', { exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Tab');
  await expect.poll(async () => getActiveDesign(await draft(page))!.scene.fixtures[0].rotation).toBe(1);
  await dialogLocked(page, '공간 크기');
  await page.getByRole('button', { name: '공간 크기 변경', exact: true }).click();
  const room = page.getByRole('dialog', { name: '공간 크기 설정' });
  await room.getByLabel('깊이 (m)', { exact: true }).fill('3.1');
  await room.getByRole('button', { name: '크기 적용', exact: true }).click();
  await expect(room).toHaveCount(0);
  await expect.poll(async () => (await draft(page)).shared.baseline.room?.depthMm).toBe(3100);
  await dialogLocked(page, '공간 둘러보기');
  const saved = await draft(page);
  await page.getByRole('button', { name: '자재 라이브러리', exact: true }).click();
  await expect(page).toHaveURL(/\/materials$/);
  await page.goto('/try');
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  expect((await draft(page)).id).toBe(saved.id);
  expect(getActiveDesign(await draft(page))!.scene.fixtures).toEqual(getActiveDesign(saved)!.scene.fixtures);
  expect((await draft(page)).shared.baseline.room?.depthMm).toBe(3100);
  const files = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['ignored'], 'photo.jpg', { type: 'image/jpeg' }));
    return data;
  });
  await page.locator('.editor-shell').dispatchEvent('drop', { dataTransfer: files });
  await expect(page.getByRole('dialog', { name: '로그인 / 회원가입' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Google로 계속하기', exact: true })).toBeEnabled();
  await files.dispose();
  expect(guestWrites()).toEqual([]);
});

test('비로그인 견적·타일·색감·그림자·복제·잠금 조절이 저장되고 실행 취소된다', async ({ page }) => {
  await create(page);
  await place(page);
  await expect(page.getByTestId('usage-total')).toHaveText('350,000원');
  const price = page.getByLabel('체험 벽걸이 세면대 단가 (원)', { exact: true });
  await expect(price).toBeEditable();
  await price.fill('175000');
  await price.press('Enter');
  await expect(page.getByTestId('usage-total')).toHaveText('375,000원');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(page.getByTestId('usage-total')).toHaveText('350,000원');
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await expect(page.getByTestId('usage-total')).toHaveText('375,000원');
  await page.getByLabel('그림자 진하기', { exact: true }).fill('0.6');
  await page.getByLabel('그림자 진하기', { exact: true }).press('Tab');
  await expect
    .poll(async () => getActiveDesign(await draft(page))!.scene.fixtures[0].shadow.opacity)
    .toBe(0.6);
  await page.getByLabel('노출', { exact: true }).fill('0.2');
  await page.getByLabel('노출', { exact: true }).press('Tab');
  await expect.poll(async () => getActiveDesign(await draft(page))!.scene.color.exposure).toBe(0.2);
  await page.getByRole('button', { name: '배치 잠금', exact: true }).click();
  await expect(page.getByRole('button', { name: '제품 삭제', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '잠금 해제', exact: true }).click();
  await page.locator('.inspector-embedded').getByRole('button', { name: '복제', exact: true }).click();
  await expect.poll(async () => getActiveDesign(await draft(page))!.scene.fixtures.length).toBe(2);
  await expect(page.getByTestId('usage-total')).toHaveText('550,000원');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect.poll(async () => getActiveDesign(await draft(page))!.scene.fixtures.length).toBe(1);
  await expect(page.getByTestId('usage-total')).toHaveText('375,000원');
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  const floor = getActiveDesign(await draft(page))!.scene.surfaces.find(
    (surface) => surface.kind === 'floor',
  )!;
  await page.getByLabel('타일 적용 위치', { exact: true }).selectOption(floor.id);
  await page.getByLabel('타일 배열', { exact: true }).selectOption('brick');
  await page.getByLabel('줄눈 색상', { exact: true }).fill('#ccddee');
  await page.getByLabel('줄눈 폭', { exact: true }).fill('4');
  await page.getByLabel('줄눈 폭', { exact: true }).press('Tab');
  await expect
    .poll(
      async () =>
        getActiveDesign(await draft(page))!.scene.surfaces.find((surface) => surface.id === floor.id)!.tile
          .groutWidth,
    )
    .toBe(4);
  await expect(page.getByRole('dialog', { name: '로그인 / 회원가입' })).toHaveCount(0);
  const saved = getActiveDesign(await draft(page))!;
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.getByTestId('usage-total')).toHaveText('375,000원');
  const restored = getActiveDesign(await draft(page))!;
  expect(restored.materialUsage).toEqual(saved.materialUsage);
  expect(restored.scene.color.exposure).toBe(0.2);
  expect(restored.scene.fixtures[0].shadow.opacity).toBe(0.6);
  expect(restored.scene.surfaces.find((surface) => surface.id === floor.id)!.tile).toMatchObject({
    pattern: 'brick',
    groutColor: '#ccddee',
    groutWidth: 4,
  });
  expect(guestWrites()).toEqual([]);
  expect(calls.some((call) => /reconstruction|photoreal|diagnostics/.test(call.path))).toBe(false);
});

test('체험 시안 추가·복제·비교와 재진입은 허용하고 비교 이미지 출력은 로그인으로 제한한다', async ({
  page,
}) => {
  await create(page);
  await place(page);
  const original = getActiveDesign(await draft(page))!;
  await page.getByRole('button', { name: '시안 관리', exact: true }).click();
  const manager = page.getByRole('dialog', { name: /^시안 관리/ });
  await manager.getByRole('button', { name: original.name + ' 복제', exact: true }).click();
  await expect.poll(async () => (await draft(page)).designs.length).toBe(2);
  const copied = (await draft(page)).designs.find((design) => design.id !== original.id)!;
  expect(copied.scene.fixtures).toHaveLength(1);
  await manager.getByRole('button', { name: '새 시안', exact: true }).click();
  await expect.poll(async () => (await draft(page)).designs.length).toBe(3);
  await manager.getByRole('checkbox', { name: original.name + ' 비교 선택', exact: true }).check();
  await manager.getByRole('checkbox', { name: copied.name + ' 비교 선택', exact: true }).check();
  await manager.getByRole('button', { name: '선택한 시안 비교', exact: true }).click();
  const comparison = page.getByRole('region', { name: '시안 나란히 비교', exact: true });
  await expect(comparison).toBeVisible();
  await expect(page.getByRole('dialog', { name: '로그인 / 회원가입' })).toHaveCount(0);
  await comparison.getByRole('button', { name: '비교 PNG', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '로그인 / 회원가입' })).toBeVisible();
  await page.getByRole('button', { name: '로그인 안내 닫기', exact: true }).click();
  await comparison.getByRole('button', { name: original.name + ' PNG 다운로드', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '로그인 / 회원가입' })).toBeVisible();
  await page.getByRole('button', { name: '로그인 안내 닫기', exact: true }).click();
  await comparison.getByRole('button', { name: '편집으로 돌아가기', exact: true }).click();
  const saved = await draft(page);
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  expect((await draft(page)).designs.map((design) => design.id)).toEqual(
    saved.designs.map((design) => design.id),
  );
  expect((await draft(page)).comparisonDesignIds).toEqual(saved.comparisonDesignIds);
  await page.getByRole('button', { name: /시안 비교/ }).click();
  await expect(comparison).toBeVisible();
  expect(guestWrites()).toEqual([]);
  expect(await app.env.DB.prepare('SELECT COUNT(*) AS n FROM d1_projects').first()).toEqual({ n: 0 });
});

test('로그인 상태가 늦게 확인되어도 열린 공간 크기와 입력값을 보존하고 회원 프로젝트로 만든다', async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/auth/get-session', async (route) => {
    await pending;
    await route.fulfill({
      json: { user: { id: app.actor.id, name: '지연 검증 회원', email: 'delayed@example.test' } },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  const room = page.getByRole('dialog', { name: '공간 크기 설정' });
  await room.getByLabel('가로 (m)', { exact: true }).fill('3.6');
  app.signIn();
  release();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true, includeHidden: true })).toHaveCount(
    1,
  );
  await expect(room).toBeVisible();
  await expect(room.getByLabel('가로 (m)', { exact: true })).toHaveValue('3.6');
  await room.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+$/, { timeout: 45000 });
  expect((await app.project()).shared.baseline.room?.widthMm).toBe(3600);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
});
