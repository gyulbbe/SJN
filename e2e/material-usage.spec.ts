import { test, expect, type Page, type Locator } from '@playwright/test';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { getActiveDesign } from '../src/lib/designs';
import { savedProject, storedProject, selectFixture, selectSurface } from '../tests/helpers/editor-actions';

test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(150000);
const tileName = '수량 검증 타일';
const fixtureName = '수량 검증 세면대';
const rows = (page: Page) => page.getByTestId('usage-row');
const row = (page: Page, name = tileName) =>
  rows(page).filter({ has: page.getByText(name, { exact: true }) });
const manager = (page: Page) => page.getByRole('dialog', { name: /^시안 관리/ });
async function commit(input: Locator, value: string) {
  await input.fill(value);
  await input.press('Enter');
}
async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '공간 크기 설정', exact: true });
  await dialog.getByLabel('가로 (m)', { exact: true }).fill('3');
  await dialog.getByLabel('깊이 (m)', { exact: true }).fill('4');
  await dialog.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await savedProject(page);
  await expect(page.getByRole('button', { name: '견적서', exact: true })).toHaveCount(0);
  await expect(page.getByText('자재 수량·금액', { exact: true })).toBeVisible();
}
async function register(page: Page, category: 'tile' | 'basin' = 'tile') {
  const buffer = await sharp({ create: { width: 180, height: 180, channels: 4, background: '#84aaa4' } })
    .png()
    .toBuffer();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await form.getByLabel('상품명').fill(category === 'tile' ? tileName : fixtureName);
  await form.getByLabel('카테고리', { exact: true }).selectOption(category);
  await form.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await form.getByLabel(category === 'tile' ? '세로 (mm)' : '높이 (mm)', { exact: true }).fill('600');
  await form
    .getByLabel('대표 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'QA-material.png', mimeType: 'image/png', buffer });
  await expect(form.getByLabel('대표 이미지 변경', { exact: true })).toBeEnabled();
  await form
    .getByLabel(category === 'tile' ? '+ 타일 텍스처 올리기' : '+ 제품 방향 이미지 올리기', { exact: true })
    .setInputFiles({ name: 'QA-content.png', mimeType: 'image/png', buffer });
  if (category === 'tile') {
    await expect(form.getByRole('img', { name: '타일 텍스처 1', exact: true })).toBeVisible();
    await form.getByLabel('판매 단위', { exact: true }).selectOption('box');
    await form.getByLabel('박스당 면적 (㎡)', { exact: true }).fill('1.44');
    await form.getByLabel('박스당 수량 (장)', { exact: true }).fill('4');
  } else {
    await expect(
      form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }),
    ).toBeVisible();
    await expect(form.getByLabel('판매 단위', { exact: true }).locator('option')).toHaveCount(1);
  }
  await form.getByLabel('기준 단가', { exact: true }).fill(category === 'tile' ? '40000' : '150000');
  await expect(form.getByLabel('타일 여유율 (%)', { exact: true })).toHaveCount(0);
  await expect(form).not.toContainText('부가세');
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page
    .getByRole('button', { name: category === 'tile' ? '바닥 타일' : '위생도기', exact: true })
    .click();
  await page
    .locator('button.material-tile')
    .filter({ hasText: category === 'tile' ? tileName : fixtureName })
    .click();
  await savedProject(page);
}
async function canvasPixels(page: Page) {
  return page
    .locator('[data-testid="canvas-frame"] canvas')
    .evaluate((c) => (c as HTMLCanvasElement).toDataURL());
}
async function copy(page: Page, from: string, to: string) {
  await page.getByRole('button', { name: '시안 관리', exact: true }).click();
  await manager(page)
    .getByRole('button', { name: from + ' 복제', exact: true })
    .click();
  await manager(page)
    .getByRole('button', { name: from + ' 복사본 이름 변경', exact: true })
    .click();
  await manager(page).getByLabel('새 시안 이름', { exact: true }).fill(to);
  await manager(page).getByRole('button', { name: '시안 이름 저장', exact: true }).click();
  await manager(page)
    .getByRole('button', { name: to + ' 편집하기', exact: true })
    .click();
  await savedProject(page);
}

test('12㎡ 9박스 360,000원 · 수동 수량·0원·실행 취소·재진입·출력 도구 제외', async ({ page }, info) => {
  const errors: string[] = [],
    forbidden: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (/supabase\.co|api\.openai\.com|\/api\/cloud|\/models\//.test(r.url())) forbidden.push(r.url());
  });
  await start(page);
  await register(page);
  await expect(row(page).getByLabel(tileName + ' 구매 수량', { exact: true })).toHaveValue('9');
  await expect(page.getByTestId('usage-total')).toHaveText('360,000원');
  await expect(row(page)).toContainText('36장');
  await expect(row(page)).toContainText('12.96㎡');
  const baseline = await savedProject(page),
    visual = await canvasPixels(page);
  const price = row(page).getByLabel(tileName + ' 단가 (원)', { exact: true });
  await commit(price, '50000');
  const priced = await savedProject(page, baseline.editRevision);
  expect(getActiveDesign(priced)!.revision).toBe(getActiveDesign(baseline)!.revision + 1);
  expect(getActiveDesign(priced)!.renderRevision).toBe(getActiveDesign(baseline)!.renderRevision);
  expect(getActiveDesign(priced)!.history.past.length).toBe(
    getActiveDesign(baseline)!.history.past.length + 1,
  );
  expect(await canvasPixels(page)).toBe(visual);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(page.getByTestId('usage-total')).toHaveText('360,000원');
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await expect(page.getByTestId('usage-total')).toHaveText('450,000원');
  await commit(price, '');
  await expect(row(page)).toContainText('계산 전');
  await expect(page.getByText('확인된 자재비', { exact: true })).toBeVisible();
  await commit(price, '0');
  await expect(page.getByTestId('usage-total')).toHaveText('0원');
  await expect(page.getByText('예상 자재비 합계', { exact: true })).toBeVisible();
  await commit(price, '40000');
  await commit(row(page).getByLabel(tileName + ' 구매 수량', { exact: true }), '10');
  await commit(row(page).getByLabel('바닥 면적 (㎡)', { exact: true }), '20');
  await expect(row(page).getByLabel(tileName + ' 구매 수량', { exact: true })).toHaveValue('10');
  await expect(row(page)).toContainText('자동 계산 14');
  await expect(page.getByTestId('usage-total')).toHaveText('400,000원');
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect(page.getByTestId('usage-total')).toHaveText('400,000원');
  await expect(page.getByText(/사용량과 금액은 이 시안의 After 기준/)).toBeVisible();
  await page.getByRole('button', { name: 'After', exact: true }).click();
  await savedProject(page);
  await page.reload();
  await savedProject(page);
  await expect(page.getByTestId('usage-total')).toHaveText('400,000원');
  await row(page)
    .getByRole('button', { name: tileName + ' 구매 수량 자동 계산', exact: true })
    .click();
  await expect(page.getByTestId('usage-total')).toHaveText('560,000원');
  await row(page).getByRole('button', { name: '바닥 면적 초기화', exact: true }).click();
  await expect(page.getByTestId('usage-total')).toHaveText('360,000원');
  await page.screenshot({ path: info.outputPath('usage-desktop.png'), fullPage: true });
  const clean = await canvasPixels(page);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '이미지 다운로드', exact: true }).click();
  const output = await download;
  const outputPath = info.outputPath('after.png');
  await output.saveAs(outputPath);
  const exported = await sharp(await readFile(outputPath))
    .resize(64, 64)
    .removeAlpha()
    .raw()
    .toBuffer();
  const canvas = await sharp(Buffer.from(clean.split(',')[1], 'base64'))
    .resize(64, 64)
    .removeAlpha()
    .raw()
    .toBuffer();
  const difference =
    exported.reduce((sum, value, i) => sum + Math.abs(value - canvas[i]), 0) / exported.length;
  await info.attach('output-pixel-difference', {
    body: JSON.stringify({ meanChannelDifference: difference }),
    contentType: 'application/json',
  });
  expect(difference).toBeLessThan(2);
  expect(errors).toEqual([]);
  expect(forbidden).toEqual([]);
});

test('제품은 배치에서 집계 · 복제·이동·회전·Before·삭제 · 타일 전체 제거', async ({ page }) => {
  await start(page);
  await register(page);
  await register(page, 'basin');
  await expect(row(page, fixtureName)).toContainText('배치한 제품 1개');
  const initial = await savedProject(page);
  const fixture = getActiveDesign(initial)!.scene.fixtures[0];
  await selectFixture(page, fixture);
  await page.locator('.inspector-embedded').getByRole('button', { name: '복제', exact: true }).click();
  await expect(row(page, fixtureName)).toContainText('배치한 제품 2개');
  await expect(row(page, fixtureName)).toContainText('300,000원');
  const copied = await savedProject(page);
  await selectFixture(page, getActiveDesign(copied)!.scene.fixtures[1]);
  const angle = page.getByLabel('이미지 평면 회전', { exact: true });
  await angle.fill('25');
  await angle.press('ArrowRight');
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await expect(row(page, fixtureName)).toContainText('배치한 제품 2개');
  await page.getByRole('button', { name: 'After', exact: true }).click();
  await selectFixture(page, getActiveDesign(copied)!.scene.fixtures[1]);
  await page.getByRole('button', { name: '제품 삭제', exact: true }).click();
  await expect(row(page, fixtureName)).toContainText('배치한 제품 1개');
  await selectFixture(page, fixture);
  await page.getByRole('button', { name: '제품 삭제', exact: true }).click();
  await expect(row(page, fixtureName)).toHaveCount(0);
  const floor = getActiveDesign(await savedProject(page))!.scene.surfaces.find((s) => s.kind === 'floor')!;
  await selectSurface(page, floor);
  await page.getByRole('button', { name: '이 면의 타일 초기화', exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId('usage-total')).toHaveText('0원');
});

test('5개 시안 금액·복사 독립 · 비교 상세와 편집/확대 포커스 분리', async ({ page }, info) => {
  await start(page);
  await register(page);
  for (let i = 0; i < 5; i++) {
    if (i) await copy(page, '시안 ' + String.fromCharCode(64 + i), '시안 ' + String.fromCharCode(65 + i));
    // Opening management must commit a still-focused valid price before copying.
    await row(page)
      .getByLabel(tileName + ' 단가 (원)', { exact: true })
      .fill(String((i + 1) * 1000));
    if (i === 4)
      await row(page)
        .getByLabel(tileName + ' 단가 (원)', { exact: true })
        .press('Enter');
  }
  const project = await savedProject(page);
  expect(
    project.designs.map((d) => Object.values(d.materialUsage!.assignments)[0].pricing.unitPrice),
  ).toEqual([1000, 2000, 3000, 4000, 5000]);
  await page.getByRole('button', { name: '시안 관리', exact: true }).click();
  for (const name of ['A', 'B', 'C', 'D', 'E'])
    await manager(page)
      .getByLabel('시안 ' + name + ' 비교 선택', { exact: true })
      .check();
  await manager(page).getByRole('button', { name: '선택한 시안 비교', exact: true }).click();
  const cards = page.getByTestId('comparison-card');
  await expect(cards).toHaveCount(5);
  for (let i = 0; i < 5; i++)
    await expect(cards.nth(i).getByTestId('comparison-usage-summary')).toContainText(
      ((i + 1) * 9000).toLocaleString('ko-KR') + '원',
    );
  await cards.nth(1).getByRole('button', { name: '시안 B 자재 보기', exact: true }).click();
  const detail = page.getByTestId('comparison-usage-detail');
  await expect(detail).toContainText('시안 B의 사용 자재');
  await expect(detail.getByTestId('usage-total')).toHaveText('18,000원');
  await expect(detail.getByLabel(tileName + ' 단가 (원)', { exact: true })).toHaveAttribute('readonly', '');
  await cards.nth(3).getByRole('button', { name: '시안 D 확대', exact: true }).click();
  await expect(detail).toContainText('시안 B의 사용 자재');
  expect((await storedProject(page)).activeDesignId).toBe(project.activeDesignId);
  await expect(cards.getByRole('status')).toHaveCount(0);
  await expect(cards.locator('img')).toHaveCount(5);
  await expect
    .poll(() =>
      cards
        .locator('img')
        .evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0)),
    )
    .toBe(true);
  await page.screenshot({ path: info.outputPath('five-cost-comparison.png'), fullPage: true });
  await detail.getByRole('button', { name: '이 시안 편집', exact: true }).click();
  await expect(page.getByTestId('active-design-name')).toHaveText('시안 B');
  await commit(row(page).getByLabel(tileName + ' 단가 (원)', { exact: true }), '6000');
  await page.getByRole('button', { name: '시안 비교로 돌아가기', exact: true }).click();
  await expect(cards.nth(1).getByTestId('comparison-usage-summary')).toContainText('54,000원');
  await expect(cards.nth(0).getByTestId('comparison-usage-summary')).toContainText('9,000원');
});

test('최신 가격 확인 · 수동 수량 보존 · 판매 단위 변경 초기화 · 규격 변경 차단', async ({ page }) => {
  await start(page);
  await register(page);
  await commit(row(page).getByLabel(tileName + ' 구매 수량', { exact: true }), '10');
  const original = await savedProject(page),
    projectUrl = page.url();
  async function updateCatalog(price: string, unit?: string, width?: string) {
    await page.goto('/materials');
    await page.getByRole('button', { name: '정보 수정', exact: true }).click();
    const form = page.getByRole('dialog', { name: '자재 수정', exact: true });
    if (unit) {
      page.once('dialog', (d) => d.accept());
      await form.getByLabel('판매 단위', { exact: true }).selectOption(unit);
    }
    if (width) await form.getByLabel('가로 (mm)', { exact: true }).fill(width);
    await form.getByLabel('기준 단가', { exact: true }).fill(price);
    await form.getByRole('button', { name: '새 버전 저장', exact: true }).click();
    await expect(form).toHaveCount(0);
    await page.goto(projectUrl);
    await savedProject(page);
  }
  await updateCatalog('45000');
  await expect(row(page).getByLabel(tileName + ' 단가 (원)', { exact: true })).toHaveValue('40000');
  const oldPixels = await canvasPixels(page);
  await row(page).getByRole('button', { name: '최신 단가 적용', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '최신 단가 확인', exact: true })).toContainText('45,000원');
  await page.getByRole('button', { name: '단가 적용', exact: true }).click();
  await expect(row(page).getByLabel(tileName + ' 구매 수량', { exact: true })).toHaveValue('10');
  await expect(page.getByTestId('usage-total')).toHaveText('450,000원');
  const updated = await savedProject(page, original.editRevision);
  expect(getActiveDesign(updated)!.scene).toEqual(getActiveDesign(original)!.scene);
  expect(getActiveDesign(updated)!.renderRevision).toBe(getActiveDesign(original)!.renderRevision);
  expect(await canvasPixels(page)).toBe(oldPixels);
  await updateCatalog('10000', 'piece');
  await row(page).getByRole('button', { name: '최신 단가 적용', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '최신 단가 확인', exact: true })).toContainText(
    '수동 구매 수량을 초기화',
  );
  await page.getByRole('button', { name: '단가 적용', exact: true }).click();
  await expect(row(page).getByLabel(tileName + ' 구매 수량', { exact: true })).toHaveValue('34');
  await savedProject(page);
  await updateCatalog('11000', undefined, '300');
  await expect(row(page)).toContainText('자재를 다시 선택');
  await expect(row(page).getByRole('button', { name: '최신 단가 적용', exact: true })).toBeDisabled();
});

test('모바일 드로어·고정 합계·잘못된 숫자 입력 차단', async ({ page }, info) => {
  await start(page);
  await register(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '자재 수량·금액 및 속성', exact: true }).click();
  await expect(page.getByTestId('usage-total')).toBeVisible();
  const footer = page.locator('.mu-footer');
  const before = await footer.boundingBox();
  await page.locator('.mu-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect((await footer.boundingBox())!.y).toBe(before!.y);
  const price = row(page).getByLabel(tileName + ' 단가 (원)', { exact: true });
  await price.fill('-100');
  await price.press('Enter');
  await expect(row(page).getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('usage-total')).toHaveText('360,000원');
  await price.press('Escape');
  await expect(price).toHaveValue('40000');
  await page.screenshot({ path: info.outputPath('usage-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '사용 내역 닫기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
});
