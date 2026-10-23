import { test, expect, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';

/**
 * Size filter order (docs/size-order-and-contact-results-20261024.md): the common tile sizes come first
 * (600X1200, 1200X600, 600X600, 600X300, 300X600, 300X300), then largest first; product sizes keep
 * their order. The public list and the editor drawer show the order the server sorted.
 */
let app: AuthenticatedApp | undefined;
test.afterEach(async () => {
  await app?.dispose();
  app = undefined;
});
test.use({ channel: 'chrome', actionTimeout: 20000 });
test.setTimeout(180000);

const TILE_SIZES = [
  '1200X2400',
  '300X300',
  '400X250',
  '600X300',
  '1200X1200',
  '600X1200',
  '600X600',
  '300X600',
  '200X200',
];
const EXPECTED = [
  '600X1200',
  '600X600',
  '600X300',
  '300X600',
  '300X300',
  '1200X2400',
  '1200X1200',
  '400X250',
  '200X200',
];

async function seedSizes(app: AuthenticatedApp) {
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#b9b5aa' } })
    .png()
    .toBuffer();
  const owner = app.actor.id;
  const statements = [];
  const items = [
    ...TILE_SIZES.map((size) => ({ size, category: 'tile' as const })),
    { size: '600X450X400', category: 'basin' as const },
  ];
  for (const [i, { size, category }] of items.entries()) {
    const [width, height, depth] = size.split('X').map(Number);
    const assetId = crypto.randomUUID(),
      materialId = crypto.randomUUID(),
      versionId = crypto.randomUUID();
    const key = `assets/${owner}/${assetId}/1`;
    const created = new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
    const tile = category === 'tile';
    await app.env.ASSET_BUCKET.put(key, png, { httpMetadata: { contentType: 'image/png' } });
    statements.push(
      app.env.DB.prepare(
        'INSERT INTO d1_assets(id,owner_id,object_key,metadata_json,content_hash,created_at) VALUES(?,?,?,?,?,?)',
      ).bind(
        assetId,
        owner,
        key,
        JSON.stringify({
          id: assetId,
          ownerId: owner,
          name: 'size.png',
          kind: tile ? 'texture' : 'product',
          mime: 'image/png',
          width: 16,
          height: 16,
          size: png.length,
          createdAt: created,
        }),
        'hash-' + assetId,
        created,
      ),
      app.env.DB.prepare(
        "INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose) VALUES(?,?,'shared',?,?,?,'catalog')",
      ).bind(materialId, owner, versionId, created, created),
      app.env.DB.prepare(
        'INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES(?,?,1,?,?,?,?)',
      ).bind(
        versionId,
        materialId,
        JSON.stringify({
          id: versionId,
          materialId,
          version: 1,
          name: `규격 시험 ${size}`,
          brand: '',
          code: 'SZ-' + i,
          category,
          scope: 'shared',
          description: '',
          color: '화이트',
          finish: '무광',
          widthMm: width,
          heightMm: height,
          depthMm: depth ?? 10,
          usage: 'both',
          installation: tile ? 'floor' : 'floor',
          textureAssetIds: tile ? [assetId] : [],
          views: tile ? [] : [{ assetId, direction: '정면', anchor: { x: 0.5, y: 1 } }],
          defaultGroutWidth: 2,
          defaultGroutColor: '#d5d1c9',
          defaultPattern: 'grid',
          createdAt: created,
        }),
        category,
        tile ? 0 : 1,
        created,
      ),
      app.env.DB.prepare('INSERT INTO d1_material_assets(version_id,asset_id) VALUES(?,?)').bind(
        versionId,
        assetId,
      ),
    );
  }
  await app.env.DB.batch(statements);
}
async function sizeOrder(page: Page, scope: Locator) {
  const toggle = scope.getByRole('button', { name: /^사이즈/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const group = scope.getByRole('group', { name: '사이즈', exact: true });
  await expect(group.getByRole('checkbox').first()).toBeVisible();
  return group
    .locator('label')
    .allInnerTexts()
    .then((texts) => texts.map((text) => text.trim()));
}

test('사이즈 분류: 많이 쓰는 타일 크기가 먼저, 나머지는 큰 순(공개 자재·편집기 서랍)', async ({ page }) => {
  app = await authenticatedApp(page);
  await seedSizes(app);
  await page.setViewportSize({ width: 1280, height: 900 });
  // The public list: tiles only, then everything (products after the common tile sizes).
  await page.goto('/materials');
  await expect(page.locator('main [data-page-item]')).toHaveCount(TILE_SIZES.length + 1);
  await page.getByLabel('제품 종류').selectOption('tile');
  await expect(page.locator('main [data-page-item]')).toHaveCount(TILE_SIZES.length);
  expect(await sizeOrder(page, page.locator('main'))).toEqual(EXPECTED);
  await page.getByLabel('제품 종류').selectOption('');
  await expect(page.locator('main [data-page-item]')).toHaveCount(TILE_SIZES.length + 1);
  expect(await sizeOrder(page, page.locator('main'))).toEqual([
    ...EXPECTED.slice(0, 7),
    // A product size stays among the rest, by width as before.
    '600X450X400',
    ...EXPECTED.slice(7),
  ]);
  // The editor drawer's floor tiles.
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  const panel = page.locator('aside.catalog-panel');
  await expect(panel.locator('button.material-tile')).toHaveCount(TILE_SIZES.length);
  expect(await sizeOrder(page, panel)).toEqual(EXPECTED);
});
