import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import { handleD1Request } from '../src/lib/d1';
import { getActiveDesign } from '../src/lib/designs';
import type { ProjectDocument, MaterialInput, MaterialVersion } from '../src/lib/types';

test.use({ channel: 'chrome', hasTouch: true, actionTimeout: 15000, viewport: { width: 375, height: 812 } });
test.setTimeout(240000);
let app: AuthenticatedApp;
const draftKey = 'sjn:guest-draft:v1';
const SHOTS = 'test-results/tile-regions/screens';

/** Two shared tiles a guest can use: a light base and a deep blue accent. */
async function seed(): Promise<MaterialVersion[]> {
  const results: MaterialVersion[] = [];
  for (const [name, color] of [
    ['체험 밝은 타일', '#cfc8ba'],
    ['체험 남색 타일', '#1d3557'],
  ]) {
    const png = new Uint8Array(
      await sharp({ create: { width: 120, height: 120, channels: 4, background: color } })
        .png()
        .toBuffer(),
    );
    const id = crypto.randomUUID();
    const form = new FormData();
    form.set('metadata', JSON.stringify({ id, name: 'guest-tile.png', kind: 'texture' }));
    form.set('file', new Blob([png], { type: 'image/png' }), 'guest-tile.png');
    const uploaded = await handleD1Request(
      'assets',
      new Request('https://test/api/d1/assets', { method: 'POST', body: form }),
      app.env,
      app.actor,
    );
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const input: MaterialInput = {
      name,
      brand: '',
      code: '',
      category: 'tile',
      scope: 'shared',
      description: '부분 타일 검증 자재',
      color: '',
      finish: '',
      widthMm: 300,
      heightMm: 300,
      depthMm: 8,
      usage: 'both',
      installation: 'wall',
      coverAssetId: id,
      imageAssetIds: [id],
      textureAssetIds: [id],
      views: [],
      defaultGroutWidth: 2,
      defaultGroutColor: '#ffffff',
      defaultPattern: 'grid',
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
});
test.afterEach(async () => {
  await app?.dispose();
});
async function draft(page: Page): Promise<ProjectDocument> {
  return page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).document, draftKey);
}
const regions = async (page: Page) =>
  getActiveDesign(await draft(page))!.scene.surfaces.filter((s) => s.region);

test('게스트·375px: 바닥을 끌어 부분 타일을 만들고 타일을 넣으면 새로고침 뒤에도 남고 화면이 넘치지 않는다', async ({
  page,
}) => {
  const [base, accent] = await seed();
  await page.goto('/');
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '공간 크기 설정' });
  await dialog.getByRole('button', { name: '공간 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/try$/);
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.canvas-loading')).toHaveCount(0);
  // The base tile on the floor (the drawer opens from the toolbar on a phone).
  await page.getByRole('button', { name: '자재 목록', exact: true }).first().click();
  await page.getByRole('button', { name: '바닥 타일', exact: true }).click();
  await page.locator('button.material-tile').filter({ hasText: base.name }).click();
  await expect
    .poll(async () =>
      getActiveDesign(await draft(page))!.scene.surfaces.some((s) => s.materialVersionId === base.id),
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.catalog-panel.open')).toHaveCount(0);

  // One finger draws while the tool is on; the floor is the lower part of the picture.
  await page.getByTestId('region-tool').click();
  const floor = getActiveDesign(await draft(page))!.scene.surfaces.find((s) => s.roomFace === 'floor')!;
  const path = (await page
    .locator(`[data-testid="editor-canvas"] [data-entity="${floor.id}"]`)
    .boundingBox())!;
  await page.mouse.move(path.x + path.width * 0.3, path.y + path.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(path.x + path.width * 0.7, path.y + path.height * 0.85, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('region-pending')).toHaveCount(1);
  expect(await regions(page)).toHaveLength(0);
  await expect(page.locator('.catalog-panel.open')).toHaveCount(1);
  await page.locator('button.material-tile').filter({ hasText: accent.name }).click();
  await expect.poll(async () => (await regions(page))[0]?.materialVersionId).toBe(accent.id);
  const [made] = await regions(page);
  expect(made.roomFace).toBe('floor');
  expect(made.name).toBe('바닥 · 부분 타일 1');
  await page.keyboard.press('Escape');
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/guest-375.png` });
  // No horizontal overflow on the phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible({ timeout: 45000 });
  await expect.poll(async () => (await regions(page))[0]?.materialVersionId).toBe(accent.id);
});
