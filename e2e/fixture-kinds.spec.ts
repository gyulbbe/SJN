import { mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { seed, seedProducts } from './helpers/material-seed';
import { getActiveDesign } from '../src/lib/designs';
import type { ProjectDocument } from '../src/lib/types';

/**
 * 위생도기 kinds an administrator manages (migration 0012, docs/fixture-kinds-results-20261028.md): one
 * added in 분류 관리 shows in the editor's chips, the public kinds and the material form; a material of
 * it is placed, saved and reopened; hiding it takes it off the chips while '전체' and the project keep
 * it. A chip asks for its kind's first page once.
 */
const shots = 'test-results/fixture-kinds';
mkdirSync(shots, { recursive: true });
let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(300000);

const png = async (background: string) => ({
  name: 'towel-bar.png',
  mimeType: 'image/png',
  buffer: await sharp({ create: { width: 120, height: 60, channels: 3, background } })
    .png()
    .toBuffer(),
});
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}
/** 분류 관리 on its 위생도기 종류 list. */
async function kindsAdmin(page: Page) {
  await page.goto('/admin/catalog');
  const kind = page.locator('form select').first();
  await expect(kind).toBeEnabled();
  await kind.selectOption('materialKind');
  const table = page.getByRole('table', { name: '위생도기 종류' });
  await expect(table.getByRole('row')).not.toHaveCount(1);
  return table;
}
async function saveKindForm(page: Page) {
  await page.getByRole('button', { name: /^(항목 등록|변경 저장)$/ }).click();
  await expect(page.getByRole('button', { name: '항목 등록', exact: true })).toBeVisible();
}
/** List requests and the kind each asked for (member page, guest GET). */
function lists(page: Page) {
  const kinds: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/d1/materials') {
      const body = JSON.parse(request.postData() ?? 'null');
      if (body?.operation === 'page') kinds.push(body.query?.category ?? '');
    } else if (url.pathname === '/api/catalog/placement' && url.searchParams.has('category'))
      kinds.push(url.searchParams.get('category')!);
  });
  return kinds;
}
async function newRoomFixtures(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  return openFixtures(page);
}
async function openFixtures(page: Page) {
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  const panel = page.locator('aside.catalog-panel');
  const open = page.getByRole('button', { name: '자재 목록', exact: true });
  if (await open.isVisible()) await open.click();
  await panel.getByRole('button', { name: '위생도기', exact: true }).click();
  const chips = panel.getByRole('group', { name: '위생도기 종류' });
  await expect(chips).toBeVisible();
  return { panel, chips, tiles: panel.locator('button.material-tile') };
}
const names = (chips: Locator) => chips.getByRole('button').allInnerTexts();

test('관리자가 종류를 더하면 칩·공개 자재·양식에 나오고, 그 종류 자재를 놓고 저장·다시 열고, 숨기면 칩에서만 빠진다', async ({
  page,
}) => {
  app = await authenticatedApp(page);
  await seed(app);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1. 분류 관리: add 수건걸이 (order 2); a built-in kind's name is fixed; an empty added kind can go.
  let table = await kindsAdmin(page);
  await page.getByLabel('항목 이름').fill('수건걸이');
  await page.getByLabel('표시 순서').fill('2');
  await saveKindForm(page);
  await expect(table.getByRole('row').filter({ hasText: '수건걸이' })).toContainText('추가');
  await table.getByRole('button', { name: '수정 · 변기', exact: true }).click();
  await expect(page.getByLabel('항목 이름')).toBeDisabled();
  await page.getByRole('button', { name: '수정 취소', exact: true }).click();
  await page.getByLabel('항목 이름').fill('빈 종류');
  await saveKindForm(page);
  page.once('dialog', (dialog) => dialog.accept());
  await table.getByRole('button', { name: '삭제 · 빈 종류', exact: true }).click();
  await expect(table.getByRole('row').filter({ hasText: '빈 종류' })).toHaveCount(0);
  await page.screenshot({ path: `${shots}/admin-kinds.png`, fullPage: true });
  const code = (await app.env.DB.prepare("SELECT code FROM d1_material_kinds WHERE name='수건걸이'").first<{
    code: string;
  }>())!.code;

  // 2·3. The material form offers it (no 문·창); a material of it is registered.
  await page.goto('/admin/materials');
  await expect(page.locator('main').getByRole('button', { name: '수건걸이', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  const kinds = await form.getByLabel('카테고리', { exact: true }).locator('option').allInnerTexts();
  expect(kinds).toContain('수건걸이');
  for (const name of ['문', '창', '샤워 커튼']) expect(kinds).not.toContain(name);
  expect(kinds.indexOf('수건걸이')).toBeLessThan(kinds.indexOf('하부장'));
  await form.getByLabel('카테고리', { exact: true }).selectOption(code);
  await form.getByLabel('상품명').fill('수건걸이 A');
  await form.getByLabel('+ 제품 이미지 올리기', { exact: true }).setInputFiles(await png('#8a8f99'));
  await expect(form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })).toHaveCount(
    1,
  );
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  const [saved] = await app.versions('수건걸이 A');
  expect(saved.category).toBe(code);
  const card = page.locator('main article').filter({ hasText: '수건걸이 A' });
  await expect(card).toContainText('수건걸이');

  // The public kinds offer it.
  await page.goto('/materials');
  const kind = page.getByLabel('제품 종류');
  // The kinds arrive with the first page.
  await expect(kind.locator('option', { hasText: '수건걸이' })).toHaveCount(1);
  await kind.selectOption(code);
  await expect(page.locator('main [data-page-item]')).toHaveCount(1);

  // 4. The editor's chips: in its order; picking it asks for its first page once.
  const { panel, chips, tiles } = await newRoomFixtures(page);
  const chipNames = await names(chips);
  expect(chipNames.indexOf('수건걸이')).toBe(chipNames.indexOf('세면대') + 1);
  for (const name of ['문', '창']) expect(chipNames).not.toContain(name);
  const asked = lists(page);
  await chips.getByRole('button', { name: '수건걸이', exact: true }).click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText('수건걸이 A');
  expect(asked).toEqual([code]);
  await page.screenshot({ path: `${shots}/editor-added-kind.png` });

  // 5. Placed, saved, reopened.
  await tiles.first().click();
  await expect(page.getByText('배치한 제품 1개')).toBeVisible();
  await page.keyboard.press('Control+s');
  const projectId = page.url().split('/').at(-1)!;
  await expect
    .poll(
      async () =>
        getActiveDesign((await app!.project(projectId)) as ProjectDocument)!.scene.fixtures.map(
          (fixture) => fixture.materialVersionId,
        ),
      { timeout: 30000 },
    )
    .toContain(saved.id);
  await page.reload();
  await openFixtures(page);
  await expect(page.getByText('배치한 제품 1개')).toBeVisible();

  // 6. Hidden: off the chips, still in '전체' and in the project.
  table = await kindsAdmin(page);
  await table.getByRole('button', { name: '수정 · 수건걸이', exact: true }).click();
  await page.getByRole('checkbox', { name: '사용' }).uncheck();
  await saveKindForm(page);
  await expect(table.getByRole('row').filter({ hasText: '수건걸이' })).toContainText('숨김');
  await page.goto(`/projects/${projectId}`);
  const reopened = await openFixtures(page);
  await expect(reopened.chips.getByRole('button', { name: '수건걸이', exact: true })).toHaveCount(0);
  await expect(reopened.tiles.filter({ hasText: '수건걸이 A' })).toHaveCount(1);
  await expect(page.getByText('배치한 제품 1개')).toBeVisible();
  void panel;

  // 375px: the admin list and the editor fit.
  await page.setViewportSize({ width: 375, height: 812 });
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}/editor-375.png` });
  await kindsAdmin(page);
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}/admin-375.png`, fullPage: true });
});

test('게스트: 관리자가 더한 종류의 칩이 공개 배치 목록의 그 종류를 받는다 · 375px', async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false });
  // 위생도기 is administrators' only for now (src/lib/fixture-access.ts); guests' products stay tested.
  await page.addInitScript(() => sessionStorage.setItem('sjn:test:fixtures-open', '1'));
  await seed(app);
  const code = 'k-towelbar01';
  await app.env.DB.prepare(
    "INSERT INTO d1_material_kinds(code,name,normalized_name,display_order,builtin) VALUES(?,'수건걸이','수건걸이',2,0)",
  )
    .bind(code)
    .run();
  await seedProducts(app, [{ name: '게스트 수건걸이', category: code, installation: 'wall' }]);
  await page.setViewportSize({ width: 375, height: 812 });
  const asked = lists(page);
  await page.goto('/');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정' })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await expect(page).toHaveURL(/\/try$/);
  const { chips, tiles } = await openFixtures(page);
  await expect(chips.getByRole('button', { name: '수건걸이', exact: true })).toBeVisible();
  await chips.getByRole('button', { name: '수건걸이', exact: true }).click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText('게스트 수건걸이');
  expect(asked.filter((kind) => kind === code)).toHaveLength(1);
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}/guest-375.png` });
});
