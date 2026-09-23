import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { handleD1Request } from '../src/lib/d1';
import { publicMaterials, type PublicMaterial } from '../src/lib/catalog/public';
import { getActiveDesign, duplicateProjectDocument } from '../src/lib/designs';
import type { ProjectDocument, MaterialInput, MaterialVersion } from '../src/lib/types';
let app: AuthenticatedApp;
let versions: MaterialVersion[];
const draftKey = 'sjn:guest-draft:v1';
test.use({ channel: 'chrome' });
test.setTimeout(240000);
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

const captureRoot = process.env.SJN_STUDIO_OUTPUT_ROOT ?? 'test-results/ui-studio';
const phase = process.env.SJN_STUDIO_PHASE === 'before' ? 'before' : 'after';
const widths = [390, 768, 1024, 1440, 2560];
async function capture(page: Page, name: string) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    if (phase === 'after') await noOverflow(page);
    await page.screenshot({
      path: captureRoot + '/' + phase + '/' + name + '-' + width + '.png',
      fullPage: true,
      animations: 'disabled',
    });
  }
}
test('핵심 화면의 다섯 화면 폭 비교 캡처', async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false, admin: true });
  try {
    versions = await seed();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '내 공간에서 시작하세요.' })).toBeVisible();
    await capture(page, 'home');
    await page.goto('/materials');
    await expect(page.getByRole('heading', { name: '체험 그레이 타일' })).toBeVisible();
    await capture(page, 'catalog');
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Google로 계속하기' })).toBeEnabled();
    await capture(page, 'login');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await create(page);
    await place(page);
    await capture(page, 'editor');
  } finally {
    await app?.dispose();
  }
});

async function noOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
}
async function mobileMenu(page: Page) {
  const button = page.getByRole('button', { name: '메뉴 열기', exact: true });
  await button.click();
  return page.getByRole('complementary', { name: '작업 공간 탐색', exact: true });
}
test('모바일 공개 메뉴와 로그인 팝업의 키보드·초점·중앙 정렬', async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false, admin: false });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const menuToggle = page.getByRole('button', { name: '메뉴 열기', exact: true });
    const nav = await mobileMenu(page);
    await expect(nav.getByRole('link', { name: '자재 라이브러리' })).toBeVisible();
    await expect(nav.getByRole('link', { name: '회원 관리' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menuToggle).toBeFocused();
    await menuToggle.press('Enter');
    await expect(nav).toBeVisible();
    await nav.getByRole('link', { name: '자재 라이브러리' }).click();
    await expect(page).toHaveURL(/\/materials$/);
    await noOverflow(page);
    await page.goto('/');
    await page.getByRole('button', { name: '로그인 / 회원가입', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: '로그인 / 회원가입' });
    await expect(dialog).toBeVisible();
    for (const height of [844, 420]) {
      await page.setViewportSize({ width: 390, height });
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs(box!.x + box!.width / 2 - 195)).toBeLessThan(2);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
      if (height === 844)
        await page.screenshot({
          path: captureRoot + '/after/login-prompt-390.png',
          fullPage: false,
          animations: 'disabled',
        });
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: '로그인 / 회원가입', exact: true }).first()).toBeFocused();
  } finally {
    await app?.dispose();
  }
});
for (const admin of [false, true])
  test((admin ? '관리자' : '일반 회원') + ' 모바일 메뉴와 계정 동작', async ({ page }) => {
    app = await authenticatedApp(page, { admin });
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/');
      const nav = await mobileMenu(page);
      await expect(nav.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
      for (const name of ['회원 관리', '전체 프로젝트']) {
        if (admin) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
        else await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
      }
      await page.screenshot({
        path: 'test-results/ui-studio/after/home-' + (admin ? 'admin' : 'member') + '-mobile-menu.png',
        fullPage: true,
      });
      await nav.getByRole('button', { name: '로그아웃', exact: true }).click();
      await expect(
        page.getByRole('button', { name: '로그인 / 회원가입', exact: true }).first(),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: '회원 관리', exact: true })).toHaveCount(0);
      await noOverflow(page);
    } finally {
      await app?.dispose();
    }
  });
test('카탈로그 상태·검색 초기화·긴 이름·이미지 대체·팝업 키보드', async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false, admin: true });
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    versions = await seed();
    const base = (await (await publicMaterials(app.env)).json()) as { materials: PublicMaterial[] };
    const rows = Array.from({ length: 28 }, (_, i) => ({
      ...base.materials[i % base.materials.length],
      id: 'studio-' + i,
      color: ['화이트', '그레이', '베이지'][i % 3],
      finish: i % 2 ? '유광' : '무광',
      name:
        i === 0
          ? '긴 자재명 '.repeat(12)
          : i === 1
            ? '이미지 없는 자재'
            : i === 2
              ? '이미지 실패 자재'
              : '쇼룸 자재 ' + i,
      images:
        i === 1
          ? []
          : i === 2
            ? [{ url: '/studio-missing-image.png', label: '정면' }]
            : base.materials[i % 2].images,
    }));
    let state: 'rows' | 'empty' | 'error' = 'rows';
    await page.route('**/studio-missing-image.png', (route) => route.fulfill({ status: 404, body: '' }));
    await page.route('**/api/catalog/materials', async (route) => {
      await ready;
      await route.fulfill(
        state === 'error'
          ? { status: 503, json: { error: '검증용 연결 오류' } }
          : { json: { materials: state === 'empty' ? [] : rows } },
      );
    });
    await page.goto('/materials');
    await expect(page.getByRole('status').filter({ hasText: '자재를 불러오는 중' })).toBeVisible();
    release();
    await expect(page.getByRole('heading', { name: '이미지 없는 자재', exact: true })).toBeVisible();
    await expect(page.getByText('등록된 이미지가 없어요', { exact: true })).toBeVisible();
    await expect(page.getByText('이미지를 불러오지 못했어요', { exact: true })).toBeVisible();
    await capture(page, 'catalog-many');
    await page.getByLabel('자재 검색', { exact: true }).fill('없는검색어');
    await expect(page.getByText('조건에 맞는 자재가 없어요.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '조건 초기화', exact: true }).click();
    await expect(page.getByLabel('자재 검색', { exact: true })).toHaveValue('');
    const beige = page.getByRole('group', { name: '색상' }).getByRole('button', { name: '베이지', exact: true });
    await beige.click();
    await expect(beige).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status').filter({ hasText: '개의 자재' })).toContainText('9개의 자재');
    await page.getByRole('group', { name: '표면' }).getByRole('button', { name: '유광', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '개의 자재' })).toContainText('4개의 자재');
    await page.getByRole('button', { name: '조건 초기화', exact: true }).click();
    await expect(beige).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('status').filter({ hasText: '개의 자재' })).toContainText('28개의 자재');
    await page.getByLabel('자재 검색', { exact: true }).fill('쇼룸 자재 3');
    const card = page
      .getByRole('button')
      .filter({ has: page.getByRole('heading', { name: '쇼룸 자재 3', exact: true }) });
    await card.focus();
    await card.press('Enter');
    const dialog = page.getByRole('dialog', { name: '자재 상세' });
    await expect(dialog).toBeVisible();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await noOverflow(page);
      await page.screenshot({
        path: 'test-results/ui-studio/after/catalog-detail-' + width + '.png',
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(card).toBeFocused();
    state = 'empty';
    await page.reload();
    await expect(page.getByText('아직 등록된 자재가 없어요.', { exact: true })).toBeVisible();
    state = 'error';
    await page.reload();
    await expect(page.getByRole('alert').filter({ hasText: /검증용 연결 오류|Google 로그인/ })).toContainText(
      '검증용 연결 오류',
    );
    state = 'rows';
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByRole('heading', { name: '이미지 없는 자재', exact: true })).toBeVisible();
  } finally {
    release();
    await app?.dispose();
  }
});
test('로그인 취소·실패 안내와 재시도는 외부 인증 없이 확인한다', async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false, admin: false });
  try {
    await page.goto('/login?error=access_denied');
    await expect(page.getByRole('alert').filter({ hasText: /검증용 연결 오류|Google 로그인/ })).toContainText(
      '취소',
    );
    await page.goto('/login?error=verification_failed');
    await expect(page.getByRole('alert').filter({ hasText: /검증용 연결 오류|Google 로그인/ })).toContainText(
      '완료되지',
    );
    await expect(page.getByRole('button', { name: 'Google로 계속하기', exact: true })).toBeEnabled();
  } finally {
    await app?.dispose();
  }
});

test('모바일 편집기 더보기의 로그인 제한과 견적·속성 이동의 입력 보존', async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false, admin: true });
  const writes: string[] = [];
  const modelRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith('/api/') &&
      request.method() !== 'GET' &&
      !url.pathname.startsWith('/api/auth/')
    )
      writes.push(url.pathname);
    if (/models|\.(onnx|safetensors|gguf)(?:$|\?)/.test(url.pathname)) modelRequests.push(url.pathname);
  });
  try {
    versions = await seed();
    await create(page);
    await place(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const more = page.getByRole('button', { name: '더보기', exact: true });
    await more.click();
    await expect(page.getByRole('button', { name: '지금 저장', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/ui-studio/after/editor-390-more.png', fullPage: true });
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    await more.click();
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '로그인 / 회원가입' })).toBeVisible();
    await page.getByRole('button', { name: '로그인 안내 닫기', exact: true }).click();
    await page.getByRole('button', { name: '자재 수량·금액 및 속성', exact: true }).click();
    const price = page.getByLabel('체험 벽걸이 세면대 단가 (원)', { exact: true });
    await price.fill('175000');
    await page.getByRole('button', { name: '편집 속성으로 이동', exact: true }).click();
    await expect(page.locator('.usage-properties > summary')).toBeInViewport();
    await page.getByLabel('노출', { exact: true }).fill('0.2');
    await page.getByRole('button', { name: '견적으로 이동', exact: true }).click();
    await expect(price).toHaveValue('175000');
    await expect(page.getByTestId('usage-total')).toHaveText('375,000원');
    await page.getByRole('button', { name: '편집 속성으로 이동', exact: true }).click();
    await expect(page.getByLabel('노출', { exact: true })).toHaveValue('0.2');
    await page.setViewportSize({ width: 1100, height: 1000 });
    await page.screenshot({ path: 'test-results/ui-studio/after/editor-1100-drawer.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'test-results/ui-studio/after/editor-390-properties.png', fullPage: true });
    await page.getByRole('button', { name: '사용 내역 닫기', exact: true }).click();
    await noOverflow(page);
    expect(writes).toEqual([]);
    expect(modelRequests).toEqual([]);
  } finally {
    await app?.dispose();
  }
});

test('회원 프로젝트의 긴 이름·여러 카드·검색 초기화·편집 진입', async ({ page }) => {
  app = await authenticatedApp(page, { admin: false });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
    await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/[\w-]+$/);
    await expect(page.getByTestId('editor-canvas')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨');
    const original = await app.project();
    for (let i = 0; i < 8; i++) {
      const document = duplicateProjectDocument(original);
      document.name =
        i === 0
          ? '오후 햇살이 들어오는 우리 가족의 욕실 리모델링과 새로운 생활을 위한 공간'
          : '쇼룸 프로젝트 ' + i;
      const response = await handleD1Request(
        'projects',
        new Request('https://test/api/d1/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation: 'create', document }),
        }),
        app.env,
        app.actor,
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
    await page.goto('/');
    await expect(page.locator('.project-card')).toHaveCount(9);
    await capture(page, 'home-projects');
    await page.getByRole('textbox', { name: '프로젝트 검색', exact: true }).fill('없는프로젝트');
    await expect(page.getByRole('heading', { name: '검색한 프로젝트가 없어요' })).toBeVisible();
    await page.getByRole('button', { name: '검색 초기화', exact: true }).click();
    await expect(page.locator('.project-card')).toHaveCount(9);
    await page.getByRole('textbox', { name: '프로젝트 검색', exact: true }).fill('  쇼룸  ');
    await expect(page.locator('.project-card')).toHaveCount(7);
    await page.locator('.project-card').first().getByRole('link').first().click();
    await expect(page).toHaveURL(/\/projects\/[\w-]+$/);
    await expect(page.getByTestId('editor-canvas')).toBeVisible();
  } finally {
    await app?.dispose();
  }
});
