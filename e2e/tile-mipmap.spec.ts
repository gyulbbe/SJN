import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { addWallNiche, savedProject } from '../tests/helpers/editor-actions';
import { getActiveDesign } from '../src/lib/designs';

/**
 * Tile mipmaps on the real editor (docs/tile-mipmap-results-20261105.md): a ribbed wall tile in a
 * default room draws on the 2D stage and, after a wall niche, on the 3D stage, without errors.
 * Screens go to test-results/tile-mipmap/screens/<TILE_MIPMAP_LABEL>-{2d,3d}.png. A real texture
 * (e.g. DWJ 9881, never committed) is used when TILE_MIPMAP_TEXTURE names a local JPEG/PNG;
 * otherwise a drawn one with 5 px ribs.
 */
let app: AuthenticatedApp;
test.afterEach(async () => {
  await app?.dispose();
});
test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(300000);

const SHOTS = 'test-results/tile-mipmap/screens';
const LABEL = process.env.TILE_MIPMAP_LABEL ?? 'current';
const TEXTURE = process.env.TILE_MIPMAP_TEXTURE;

const settled = async (page: Page) => {
  await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 60000 });
  await expect(page.locator('.editor-error')).toHaveCount(0);
};

/** One shared 600 × 300 ribbed tile in the isolated catalogue, through the app's own API. */
async function seedRibbedTile(page: Page) {
  const real = TEXTURE && existsSync(TEXTURE) ? readFileSync(TEXTURE).toString('base64') : undefined;
  await page.evaluate(async (real) => {
    async function api(path: string, body: unknown) {
      const response = await fetch(
        '/api/d1/' + path,
        body instanceof FormData
          ? { method: 'POST', body }
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }
    let blob: Blob, width: number, height: number;
    if (real) {
      blob = await (await fetch('data:image/jpeg;base64,' + real)).blob();
      const bitmap = await createImageBitmap(blob);
      [width, height] = [bitmap.width, bitmap.height];
      bitmap.close();
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = width = 1024;
      canvas.height = height = 512;
      const c = canvas.getContext('2d')!;
      c.fillStyle = '#e6e1d8';
      c.fillRect(0, 0, width, height);
      c.fillStyle = '#8a8378';
      for (let y = 0; y < height; y += 5) c.fillRect(0, y, width, 2.5);
      blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    }
    const catalog = await api('catalog', { operation: 'list' });
    const brand =
      catalog.options.find(
        (row: { kind: string; name: string }) => row.kind === 'brand' && row.name === '검증용 자재',
      ) ??
      (await api('catalog', {
        operation: 'create',
        input: { kind: 'brand', name: '검증용 자재', active: true, sortOrder: 100 },
      }));
    const createdAt = new Date().toISOString();
    const assetId = crypto.randomUUID(),
      materialId = crypto.randomUUID(),
      versionId = crypto.randomUUID();
    const name = '리브 검증 타일.' + (real ? 'jpg' : 'png');
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({
        id: assetId,
        ownerId: 'local',
        name,
        mime: blob.type,
        size: blob.size,
        width,
        height,
        kind: 'texture',
        createdAt,
      }),
    );
    form.set('file', blob, name);
    await api('assets', form);
    await api('materials', {
      operation: 'create',
      input: {
        id: versionId,
        materialId,
        version: 1,
        createdAt,
        name: '리브 검증 타일',
        brand: '검증용 자재',
        code: 'TEST-RIB-01',
        category: 'tile',
        scope: 'shared',
        description: '밉맵 확인용 줄무늬 타일',
        color: '',
        catalog: { brandId: brand.id, colorIds: [], compositionIds: [], finishIds: [] },
        finish: '무광',
        widthMm: 600,
        heightMm: 300,
        depthMm: 9,
        usage: 'both',
        installation: 'wall',
        coverAssetId: assetId,
        imageAssetIds: [],
        textureAssetIds: [assetId],
        views: [],
        defaultGroutWidth: 2,
        defaultGroutColor: '#d5d1c9',
        defaultPattern: 'grid',
      },
    });
  }, real);
}

test('줄무늬 벽 타일이 2D와 3D 편집 화면에 오류 없이 그려진다', async ({ page }) => {
  app = await authenticatedApp(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await seedRibbedTile(page);
  await page.getByRole('button', { name: '기본 공간으로 시작', exact: true }).click();
  await page.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 60000 });
  await settled(page);
  const start = await savedProject(page);
  await page.getByRole('button', { name: '벽 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: '리브 검증 타일' }).click();
  const tiled = await savedProject(page, start.editRevision);
  expect(
    getActiveDesign(tiled)!
      .scene.surfaces.filter((surface) => surface.kind === 'wall')
      .every((surface) => !!surface.materialVersionId),
  ).toBe(true);
  await settled(page);
  await mkdir(SHOTS, { recursive: true });
  await page
    .getByTestId('editor-canvas')
    .screenshot({ path: `${SHOTS}/${LABEL}-2d.png`, animations: 'disabled' });
  await addWallNiche(page);
  await settled(page);
  await savedProject(page, tiled.editRevision);
  await page
    .getByTestId('room-editor-canvas')
    .screenshot({ path: `${SHOTS}/${LABEL}-3d.png`, animations: 'disabled' });
  expect(errors).toEqual([]);
});
