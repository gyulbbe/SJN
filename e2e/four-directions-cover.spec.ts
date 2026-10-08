import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { savedProject } from '../tests/helpers/editor-actions';

let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(240000);

const red = [210, 40, 40, 255];
const green = [30, 180, 80, 255];
async function imageFile(name: string, color: number[]) {
  const buffer = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: color[0], g: color[1], b: color[2], alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return { name, mimeType: 'image/png', buffer };
}
async function imageColor(locator: Locator, expected: number[]) {
  await expect
    .poll(async () =>
      locator.evaluate((element) => {
        if (!(element instanceof HTMLImageElement) || !element.complete || !element.naturalWidth) return [];
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d')!;
        context.drawImage(element, 0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      }),
    )
    .toEqual(expected);
}
async function openRegistration(page: Page, name: string) {
  await page.goto('/admin/materials');
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption('toilet');
  await form.getByLabel('상품명').fill(name);
  return form;
}
const card = (page: Page, name: string) => page.locator('article').filter({ hasText: name });
/** The editor's material list shows the same picture (a new room, the 위생도기 tab). */
async function editorTileColor(page: Page, name: string, color: number[]) {
  await page.goto('/');
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await savedProject(page);
  await page.getByRole('button', { name: '위생도기', exact: true }).click();
  await imageColor(
    page.locator('button.material-tile').filter({ hasText: name }).getByRole('img', { name, exact: true }),
    color,
  );
}

test('방향은 정면·왼쪽·오른쪽·뒤 네 개만, 안내가 보이고, 대표 이미지를 올리고 지우면 목록 그림이 바뀐다', async ({
  page,
}, info) => {
  const name = '대표 이미지 검증 변기';
  const form = await openRegistration(page, name);
  const upload = form.getByLabel('+ 제품 이미지 올리기', { exact: true });
  await upload.setInputFiles(await imageFile('front-green.png', green));
  await expect(form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })).toHaveCount(
    1,
  );
  // The list has four names: no 위 and no 아래.
  const direction = form.getByLabel('촬영 방향 1', { exact: true });
  await expect(direction).toHaveValue('정면');
  const options = (await direction.locator('option').allTextContents()).map((text) =>
    text.replace(/ \(사용 중\)$/, ''),
  );
  expect(options).toEqual(['정면', '왼쪽', '오른쪽', '뒤']);
  // The guidance is said as it is: a missing direction is stood in for by another photo.
  const guide = form.getByTestId('view-guide');
  await expect(guide).toContainText('정면 사진 1장이면 시작할 수 있어요');
  await expect(guide).toContainText('사진을 올리지 않은 방향에서는 다른 방향 사진이 대신 보여요');
  await expect(guide).toContainText('위·아래에서 찍은 사진은 방 화면에 쓰이지 않아요');
  await expect(guide).toContainText('눈높이에서 약 10° 위에서 찍은 사진을 올려 주세요');
  await expect(guide).toContainText('위에서 찍은 사진은 대표 이미지로 쓰세요');
  // At most four photos: one more than that is refused, with the room left.
  await upload.setInputFiles([
    await imageFile('a.png', green),
    await imageFile('b.png', green),
    await imageFile('c.png', green),
    await imageFile('d.png', green),
  ]);
  await expect(form.getByRole('alert')).toContainText('최대 4장까지 올릴 수 있어요');
  await expect(form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })).toHaveCount(
    1,
  );
  // The 대표 이미지 is optional and separate from the direction photos.
  await expect(form.getByTestId('cover-card')).toHaveCount(0);
  await form
    .getByLabel('+ 대표 이미지 올리기(선택)', { exact: true })
    .setInputFiles(await imageFile('cover-red.png', red));
  await expect(form.getByTestId('cover-card')).toBeVisible();
  await expect(form.getByRole('img', { name: '대표 이미지', exact: true })).toBeVisible();
  await expect(form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })).toHaveCount(
    1,
  );
  await form.getByLabel('기준 단가', { exact: true }).fill('150000');
  await form.getByTestId('view-guide').scrollIntoViewIfNeeded();
  await form.screenshot({ path: info.outputPath('cover-form.png') });
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);
  // The lists show the 대표 이미지 (red), not the 정면 photo (green).
  await expect(card(page, name)).toBeVisible();
  await imageColor(card(page, name).getByRole('img', { name, exact: true }), red);
  await editorTileColor(page, name, red);

  // Taking it away shows the 정면 photo again, and the direction photo is still there.
  await page.goto('/admin/materials');
  await card(page, name).getByRole('button', { name: '정보 수정', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '자재 수정', exact: true });
  await expect(edit.getByTestId('cover-card')).toBeVisible();
  await edit.getByRole('button', { name: '대표 이미지 지우기', exact: true }).click();
  await expect(edit.getByTestId('cover-card')).toHaveCount(0);
  await edit.getByRole('button', { name: '새 버전 저장', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await page.reload();
  await imageColor(card(page, name).getByRole('img', { name, exact: true }), green);
  await editorTileColor(page, name, green);
});

test('위·아래로 저장돼 있던 사진은 목록에 안 나오고, 수정해서 저장하면 새 버전에서 빠지며, 이전 버전은 그대로다', async ({
  page,
}, info) => {
  const name = '옛 위 사진 변기';
  const form = await openRegistration(page, name);
  await form
    .getByLabel('+ 제품 이미지 올리기', { exact: true })
    .setInputFiles([await imageFile('front-red.png', red), await imageFile('second-green.png', green)]);
  await expect(form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })).toHaveCount(
    2,
  );
  await form.getByLabel('기준 단가', { exact: true }).fill('120000');
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(form).toHaveCount(0);

  // What the list allowed before: the second photo was saved as 위 (and one more as 아래).
  const row = await app.env.DB.prepare(
    `SELECT id, payload_json FROM d1_material_versions WHERE json_extract(payload_json,'$.name')=?`,
  )
    .bind(name)
    .first<{ id: string; payload_json: string }>();
  const stored = JSON.parse(row!.payload_json);
  expect(stored.views.map((view: { direction: string }) => view.direction)).toEqual(['정면', '왼쪽']);
  stored.views[1].direction = '위';
  stored.views.push({ ...stored.views[1], direction: '아래' });
  await app.env.DB.prepare('UPDATE d1_material_versions SET payload_json=?, view_count=3 WHERE id=?')
    .bind(JSON.stringify(stored), row!.id)
    .run();

  await page.goto('/admin/materials');
  // The list counts and shows the direction photos only: the 위·아래 ones are not there.
  await expect(card(page, name)).toContainText('2D · 1방향');
  await card(page, name)
    .getByRole('button', { name: `${name} 상세 보기`, exact: true })
    .click();
  const detail = page.getByRole('dialog', { name, exact: true });
  await expect(detail).toContainText('2D 제품 이미지 1방향');
  await expect(detail.getByText('위', { exact: true })).toHaveCount(0);
  await expect(detail.getByText('아래', { exact: true })).toHaveCount(0);
  await detail.getByRole('button', { name: '닫기', exact: true }).click();

  await card(page, name).getByRole('button', { name: '정보 수정', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '자재 수정', exact: true });
  await expect(edit.getByTestId('retired-views-notice')).toContainText('위·아래에서 찍은 사진 2장');
  await expect(edit.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true })).toHaveCount(
    1,
  );
  await expect(edit.getByLabel('촬영 방향 1', { exact: true })).toHaveValue('정면');
  await expect(edit.getByLabel('촬영 방향 2', { exact: true })).toHaveCount(0);
  await edit.screenshot({ path: info.outputPath('retired-notice.png') });
  await edit.getByRole('button', { name: '새 버전 저장', exact: true }).click();
  await expect(edit).toHaveCount(0);

  const versions = (
    await app.env.DB.prepare(
      `SELECT version, payload_json FROM d1_material_versions WHERE json_extract(payload_json,'$.name')=? ORDER BY version`,
    )
      .bind(name)
      .all<{ version: number; payload_json: string }>()
  ).results.map((entry) => ({
    version: entry.version,
    directions: JSON.parse(entry.payload_json).views.map((view: { direction: string }) => view.direction),
  }));
  // The new version has the direction photo only; the stored one is as it was (projects keep using it).
  expect(versions).toEqual([
    { version: 1, directions: ['정면', '위', '아래'] },
    { version: 2, directions: ['정면'] },
  ]);
});
