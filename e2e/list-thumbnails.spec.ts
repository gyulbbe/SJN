import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { PRODUCTS, seed, TILES } from './helpers/material-seed';
import { LIST_IMAGE_EDGE } from '../src/lib/d1/list-images';

/**
 * List images in the browser (docs/list-thumbnails-results-20261023.md): the administrator's button
 * makes the missing ones once, a newly registered material gets its own, and every card (library,
 * editor drawer, public list, guest drawer) asks for its image with `size=list` and gets the small copy.
 */
let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(300000);

/** Card image answers: URL and whether the list image came back. */
function cardImages(page: Page) {
  const seen: { url: URL; listed: string | null; type: string | null }[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.searchParams.get('size') !== 'list') return;
    seen.push({
      url,
      listed: response.headers()['x-sjn-list-image'] ?? null,
      type: response.headers()['content-type'] ?? null,
    });
  });
  return seen;
}
const listRows = async (app: AuthenticatedApp) =>
  (
    await app.env.DB.prepare(
      `SELECT id,object_key,source_asset_id,metadata_json FROM d1_assets
       WHERE deleting=0 AND json_extract(metadata_json,'$.derivation')='list'`,
    ).all<{ id: string; object_key: string; source_asset_id: string; metadata_json: string }>()
  ).results;
/** List images for seeded rows straight into D1/R2 (what the backfill would have made). */
async function addListImages(app: AuthenticatedApp, sources: string[]) {
  const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#556677' } })
    .webp()
    .toBuffer();
  const owner = app.actor.id;
  const created = new Date().toISOString();
  const statements = [];
  for (const source of sources) {
    const id = crypto.randomUUID();
    const key = `assets/${owner}/${id}/1`;
    await app.env.ASSET_BUCKET.put(key, webp, { httpMetadata: { contentType: 'image/webp' } });
    statements.push(
      app.env.DB.prepare(
        'INSERT INTO d1_assets(id,owner_id,object_key,source_asset_id,metadata_json,content_hash,created_at) VALUES(?,?,?,?,?,?,?)',
      ).bind(
        id,
        owner,
        key,
        source,
        JSON.stringify({
          id,
          ownerId: owner,
          name: '목록 이미지.webp',
          kind: 'thumbnail',
          derivation: 'list',
          sourceAssetId: source,
          mime: 'image/webp',
          width: 8,
          height: 8,
          size: webp.length,
          createdAt: created,
        }),
        'hash-' + id,
        created,
      ),
    );
  }
  await app.env.DB.batch(statements);
}

test('관리자 버튼: 없는 목록 이미지를 한 번 만들고, 다시 눌러도 더 만들지 않는다', async ({ page }) => {
  app = await authenticatedApp(page);
  const rows = await seed(app);
  const total = TILES + PRODUCTS;
  await page.setViewportSize({ width: 1440, height: 900 });
  const answers = cardImages(page);
  let pages = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/d1/materials') && request.postData()?.includes('"listImages"')) pages++;
  });
  await page.goto('/admin/materials');
  await expect(page.locator('main article')).toHaveCount(48);
  // Before the backfill the cards get their images themselves.
  await expect.poll(() => answers.length).toBeGreaterThan(0);
  expect(answers.every((answer) => answer.listed === '0')).toBe(true);
  const backfill = page.getByTestId('list-image-backfill');
  await backfill.getByRole('button', { name: '목록 이미지 만들기' }).click();
  await expect(backfill.getByRole('status')).toContainText(
    `끝 · 확인 ${total} / ${total}개, 새로 만듦 ${total}개`,
    { timeout: 180000 },
  );
  // One list image per card image, each a small WebP.
  const made = await listRows(app);
  expect(made).toHaveLength(total);
  expect(new Set(made.map((row) => row.source_asset_id))).toEqual(new Set(rows.map((row) => row.assetId)));
  const object = await app.env.ASSET_BUCKET.get(made[0].object_key);
  const meta = await sharp(Buffer.from(await object!.arrayBuffer())).metadata();
  expect(meta.format).toBe('webp');
  expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(LIST_IMAGE_EDGE);
  // Pages of 48, active then deactivated materials.
  expect(pages).toBe(Math.ceil(total / 48) + 1);
  // Pressing it again only checks.
  await backfill.getByRole('button', { name: '목록 이미지 만들기' }).click();
  await expect(backfill.getByRole('status')).toContainText(`끝 · 확인 ${total} / ${total}개, 새로 만듦 0개`, {
    timeout: 60000,
  });
  expect(await listRows(app)).toHaveLength(total);
  // The cards now get the list images.
  answers.length = 0;
  await page.reload();
  await expect(page.locator('main article')).toHaveCount(48);
  await expect.poll(() => answers.length).toBeGreaterThan(0);
  expect(answers.every((answer) => answer.listed === '1' && answer.type === 'image/webp')).toBe(true);
  expect(answers.every((answer) => answer.url.pathname === '/api/d1/assets')).toBe(true);
});

test('등록: 새 자재의 카드 이미지에 256px 목록 이미지가 생긴다', async ({ page }) => {
  app = await authenticatedApp(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 30000 });
  const texture = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#2277ee' } })
    .png()
    .toBuffer();
  await page.getByRole('button', { name: '신규 자재 등록', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '신규 자재 등록', exact: true });
  await dialog.getByLabel('상품명').fill('목록 이미지 확인 타일');
  await dialog.getByLabel('카테고리', { exact: true }).selectOption('tile');
  await dialog.getByLabel('가로 (mm)', { exact: true }).fill('600');
  await dialog.getByLabel('세로 (mm)', { exact: true }).fill('300');
  await dialog
    .getByLabel('+ 타일 텍스처 올리기', { exact: true })
    .setInputFiles({ name: 'texture.png', mimeType: 'image/png', buffer: texture });
  await expect(dialog.getByRole('img', { name: '타일 텍스처 1', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '자재 등록', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await listRows(app!)).length, { timeout: 30000 }).toBe(1);
  const [list] = await listRows(app);
  const version = await app.env.DB.prepare(
    `SELECT v.payload_json FROM d1_material_versions v JOIN d1_materials m ON m.current_version_id=v.id
     WHERE json_extract(v.payload_json,'$.name')='목록 이미지 확인 타일'`,
  ).first<{ payload_json: string }>();
  const imageId = JSON.parse(version!.payload_json).textureAssetIds[0];
  expect(list.source_asset_id).toBe(imageId);
  const source = JSON.parse(
    (await app.env.DB.prepare('SELECT metadata_json FROM d1_assets WHERE id=?').bind(imageId).first<{
      metadata_json: string;
    }>())!.metadata_json,
  );
  const scale = Math.min(1, LIST_IMAGE_EDGE / Math.max(source.width, source.height));
  const bytes = Buffer.from(await (await app.env.ASSET_BUCKET.get(list.object_key))!.arrayBuffer());
  const meta = await sharp(bytes).metadata();
  expect(meta.format).toBe('webp');
  expect([meta.width, meta.height]).toEqual([
    Math.round(source.width * scale),
    Math.round(source.height * scale),
  ]);
  expect(JSON.parse(list.metadata_json)).toMatchObject({ kind: 'thumbnail', derivation: 'list' });
});

test('공개·게스트 카드: size=list로 목록 이미지를 받고, 고른 자재는 원본 이미지를 쓴다', async ({ page }) => {
  app = await authenticatedApp(page, { signedIn: false });
  const rows = await seed(app);
  await addListImages(
    app,
    rows.map((row) => row.assetId),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  const answers = cardImages(page);
  const images: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/catalog/images') images.push(url);
  });
  await page.goto('/materials');
  await expect(page.locator('main [data-page-item]')).toHaveCount(48);
  await expect.poll(() => answers.length).toBeGreaterThan(0);
  expect(answers.every((answer) => answer.listed === '1' && answer.type === 'image/webp')).toBe(true);
  // Cards never ask for the image whole.
  expect(images.every((url) => url.searchParams.get('size') === 'list')).toBe(true);
  // The guest drawer.
  answers.length = 0;
  images.length = 0;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  await page
    .getByRole('dialog', { name: '공간 크기 설정' })
    .getByRole('button', { name: '공간 만들기', exact: true })
    .click();
  await expect(page).toHaveURL(/\/try$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await page.getByRole('button', { name: '자재 목록', exact: true }).click();
  const tiles = page.locator('aside.catalog-panel button.material-tile');
  await expect(tiles).toHaveCount(48);
  await expect.poll(() => answers.length).toBeGreaterThan(0);
  expect(answers.every((answer) => answer.listed === '1' && answer.type === 'image/webp')).toBe(true);
  // Picking a tile puts the image itself in the scene.
  const picked = rows.filter((row) => row.category === 'tile' && row.usage !== 'wall')[0];
  await page.getByRole('textbox', { name: '편집기 자재 검색' }).fill(picked.name);
  await expect(tiles).toHaveCount(1);
  await tiles.first().click();
  await expect
    .poll(() =>
      images.some((url) => url.searchParams.get('id') === picked.assetId && !url.searchParams.has('size')),
    )
    .toBe(true);
});
