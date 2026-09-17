import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { catalogSeed } from '../src/lib/catalog/seed';
import type { MaterialVersion } from '../src/lib/types';

test.use({ channel: 'chrome', actionTimeout: 15000 });

// Test-only signed-in administrator; real isolated D1/R2 handlers, no live OAuth or remote calls.
const apps = new WeakMap<Page, AuthenticatedApp>();
test.beforeEach(async ({ page }) => {
  apps.set(page, await authenticatedApp(page, { admin: true }));
});
test.afterEach(async ({ page }) => {
  await apps.get(page)?.dispose();
});

async function openForm(page: Page) {
  await page.goto('/admin/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).first().click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await expect(form.getByRole('combobox', { name: '색상', exact: true })).toBeVisible();
  return form;
}

async function choose(form: Locator, label: string, name: string) {
  const input = form.getByRole('combobox', { name: label, exact: true });
  await input.fill(name);
  await form.getByRole('option', { name, exact: true }).click();
  await expect(form.getByRole('button', { name: `${label} ${name} 제거`, exact: true })).toBeVisible();
}

async function versions(page: Page, name: string): Promise<MaterialVersion[]> {
  return apps.get(page)!.versions(name);
}

test('선택 목록은 실제 마우스 휠로 스크롤하고 부분 검색 결과를 선택할 수 있다', async ({ page }) => {
  const form = await openForm(page);
  const color = form.getByRole('combobox', { name: '색상', exact: true });
  await color.click();
  const list = form.getByRole('listbox', { name: '색상 선택 목록', exact: true });
  await expect(list.getByRole('option')).toHaveCount(9);
  const metrics = await list.evaluate((element) => ({
    scroll: element.scrollHeight,
    visible: element.clientHeight,
  }));
  expect(metrics.scroll).toBeGreaterThan(metrics.visible);
  await list.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await list.getByRole('option', { name: '그린', exact: true }).click();
  await expect(form.getByRole('button', { name: '색상 그린 제거', exact: true })).toBeVisible();

  await color.fill('그레');
  await expect(list.getByRole('option', { name: '그레이', exact: true })).toBeVisible();
  await expect(list.getByRole('option')).toHaveCount(1);
  await form.screenshot({ path: test.info().outputPath('catalog-partial-search-open.png') });
  await list.getByRole('option', { name: '그레이', exact: true }).click();
  await expect(form.getByRole('button', { name: '색상 그레이 제거', exact: true })).toBeVisible();
  await expect(color).toHaveValue('');
});

test('키보드 위쪽 탐색으로 마지막 항목을 선택하고 Tab 이동 시 이전 목록을 닫는다', async ({ page }) => {
  const form = await openForm(page);
  const color = form.getByRole('combobox', { name: '색상', exact: true });
  await color.focus();
  await color.press('ArrowUp');
  const list = form.getByRole('listbox', { name: '색상 선택 목록', exact: true });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const activeId = await color.getAttribute('aria-activedescendant');
  expect(activeId).toBeTruthy();
  expect(await page.evaluate((id) => document.getElementById(id!)?.textContent, activeId)).toBe('그린');
  await color.press('Enter');
  await expect(form.getByRole('button', { name: '색상 그린 제거', exact: true })).toBeVisible();
  await color.press('Tab');
  const composition = form.getByRole('combobox', { name: '재질', exact: true });
  await expect(composition).toBeFocused();
  await expect(color).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toHaveCount(0);
  await expect(form.getByRole('listbox')).toHaveCount(1);
  await composition.press('Escape');
  await expect(form.getByRole('listbox')).toHaveCount(0);
  await composition.press('ArrowDown');
  await composition.press('Enter');
  await expect(form.getByRole('button', { name: '재질 포세린 제거', exact: true })).toBeVisible();
});

test('선택 ID를 저장·재진입하고 비활성 항목을 새 버전에서 교체해도 이전 버전은 보존한다', async ({
  page,
}) => {
  let form = await openForm(page);
  const name = '분류 저장 독립성 검증 타일';
  await form.getByLabel('상품명 *', { exact: true }).fill(name);
  await choose(form, '브랜드', 'TOTO');
  await choose(form, '하위 카테고리', '포세린 타일');
  for (const [label, entries] of [
    ['색상', ['그레이', '화이트']],
    ['재질', ['포세린', '세라믹']],
    ['마감', ['무광', '유광']],
  ] as const) {
    for (const entry of entries) await choose(form, label, entry);
  }
  const texture = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#c4c4c4' } })
    .png()
    .toBuffer();
  await form.getByLabel('+ 타일 텍스처 올리기', { exact: true }).setInputFiles({
    name: 'catalog-selection-test.png',
    mimeType: 'image/png',
    buffer: texture,
  });
  await expect(form.getByRole('img', { name: '타일 텍스처 1', exact: true })).toBeVisible();
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  const before = await versions(page, name);
  expect(before).toHaveLength(1);
  const expectedId = (kind: string, label: string) =>
    catalogSeed.options.find((option) => option.kind === kind && option.name === label)!.id;
  expect(before[0].catalog).toEqual({
    brandId: expectedId('brand', 'TOTO'),
    subcategoryId: catalogSeed.subcategories.find((option) => option.name === '포세린 타일')!.id,
    colorIds: ['그레이', '화이트'].map((label) => expectedId('color', label)),
    compositionIds: ['포세린', '세라믹'].map((label) => expectedId('composition', label)),
    finishIds: ['무광', '유광'].map((label) => expectedId('finish', label)),
  });

  await page.goto('/admin/catalog');
  await page.getByRole('button', { name: '수정 · 그레이', exact: true }).click();
  await page.getByRole('checkbox', { name: '사용', exact: true }).uncheck();
  await page.getByRole('button', { name: '변경 저장', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '그레이' })).toContainText('비활성');
  await page.goto('/admin/materials');
  await page
    .locator('article')
    .filter({ hasText: name })
    .getByRole('button', { name: '정보 수정', exact: true })
    .click();
  form = page.getByRole('dialog', { name: '자재 수정', exact: true });
  const inactive = form.getByRole('button', { name: '색상 그레이 제거', exact: true });
  await expect(inactive).toContainText('비활성');
  await expect(form.getByRole('button', { name: '재질 세라믹 제거', exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: '마감 유광 제거', exact: true })).toBeVisible();
  await form.getByRole('button', { name: '새 버전 저장', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('비활성 항목을 제거');
  await inactive.click();
  await choose(form, '색상', '아이보리');
  await form.getByRole('button', { name: '새 버전 저장', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.reload();
  const after = (await versions(page, name)).sort((a, b) => a.version - b.version);
  expect(after).toHaveLength(2);
  expect(after[0]).toEqual(before[0]);
  expect(after[1].catalog?.colorIds).toEqual(
    ['화이트', '아이보리'].map((label) => expectedId('color', label)),
  );
  expect(after[1].textureAssetIds).toEqual(before[0].textureAssetIds);
});
