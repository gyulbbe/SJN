/**
 * Photo lighting match (stage 3-3a) capture: builds a comparison project from each of the five
 * test bathroom photos with the browser-only analysis (DeepLab, no cloud AI) and exports the
 * project, material versions and assets for tests/photo-lighting-match-browser.ts.
 *
 * Opt in: SJN_PHOTO_LIGHTING_CAPTURE=1 npx playwright test e2e/photo-lighting-capture.spec.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { authenticatedApp, type AuthenticatedApp } from './helpers/authenticated-app';
import sharp from 'sharp';
import { handleD1Request } from '../src/lib/d1';

const photos =
  '.codex-remote-attachments/01a071fe-92b3-77b3-a261-8698b3d3f8e9/04c0e236-9188-46ed-9a61-a8ff283287f8';
const output = 'test-results/photo-lighting-match/projects';
test.use({ channel: 'chrome', actionTimeout: 15000 });
test.setTimeout(400000);

let app: AuthenticatedApp;
test.beforeEach(async ({ page }) => {
  test.skip(
    process.env.SJN_PHOTO_LIGHTING_CAPTURE !== '1',
    'SJN_PHOTO_LIGHTING_CAPTURE=1로 사진 5장의 비교 공간을 실제 브라우저 분석으로 만들 때만 실행합니다.',
  );
  app = await authenticatedApp(page);
});
test.afterEach(async () => {
  await app?.dispose();
});

const dialog = (page: Page) => page.getByRole('dialog', { name: '사진으로 비교 공간 만들기', exact: true });
async function asset(id: string) {
  const request = (raw: boolean) =>
    handleD1Request(
      'assets',
      new Request(`http://127.0.0.1:3000/api/d1/assets?id=${encodeURIComponent(id)}${raw ? '&raw=1' : ''}`),
      app.env,
      app.actor,
    );
  const meta = await request(false);
  if (!meta.ok) throw new Error(`asset ${id}: ${await meta.text()}`);
  const bytes = await request(true);
  return { metadata: (await meta.json()).asset, bytes: Buffer.from(await bytes.arrayBuffer()) };
}

for (const n of [1, 2, 3, 4, 5])
  test(`사진 ${n}: 브라우저 기본 분석으로 비교 공간을 만들고 내보낸다`, async ({ page }) => {
    const remote: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (/^https?:$/.test(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname))
        remote.push(url.href);
    });
    await page.goto('/');
    await page.getByRole('button', { name: '사진으로 비교 공간 만들기', exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page)
      .getByRole('radio', { name: /브라우저 기본 분석/ })
      .check();
    // The photos are Android Ultra HDR JPEGs (MPF + gain map), which the upload check rejects as
    // multi-picture. The same primary pixels, converted from Display P3 to sRGB, go in as PNG.
    const png = await sharp(`${photos}/${n}-Photo-${n}.jpg`).toColourspace('srgb').png().toBuffer();
    await dialog(page)
      .getByTestId('reconstruction-upload')
      .setInputFiles({ name: `photo-${n}.png`, mimeType: 'image/png', buffer: png });
    await dialog(page).getByRole('button', { name: '자동 초안 만들기', exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/[\w-]+/, { timeout: 300000 });
    await expect(page.getByTestId('editor-canvas')).toBeVisible();
    await expect(page.locator('.canvas-loading')).toHaveCount(0, { timeout: 60000 });
    await expect(page.getByTestId('save-status')).toHaveText('클라우드에 저장됨', { timeout: 60000 });
    const project = await app.project();
    const comparison = project.shared.comparison!;
    expect(comparison.review?.analysisProfile).toBe('browser-basic');
    const versions = await app.versions();
    const used = new Set([
      ...comparison.before.surfaces.map((s) => s.materialVersionId),
      ...comparison.before.fixtures.map((f) => f.materialVersionId),
    ]);
    const materials = versions.filter((v) => used.has(v.id));
    const ids = new Set<string>([
      comparison.before.originalAssetId,
      comparison.before.previewAssetId,
      comparison.referenceOriginalAssetId,
      comparison.referencePreviewAssetId,
      ...materials.flatMap((m) => [
        ...m.textureAssetIds,
        ...(m.imageAssetIds ?? []),
        ...m.views.map((v) => v.assetId),
        ...(m.coverAssetId ? [m.coverAssetId] : []),
      ]),
    ]);
    const dir = `${output}/${n}`;
    await mkdir(`${dir}/assets`, { recursive: true });
    const metadata: Record<string, unknown> = {};
    for (const id of ids) {
      const { metadata: meta, bytes } = await asset(id);
      metadata[id] = meta;
      await writeFile(`${dir}/assets/${id}`, bytes);
    }
    await writeFile(`${dir}/project.json`, JSON.stringify(project, null, 2));
    await writeFile(`${dir}/materials.json`, JSON.stringify(materials, null, 2));
    await writeFile(`${dir}/assets.json`, JSON.stringify(metadata, null, 2));
    // Browser-only analysis: nothing leaves the machine.
    expect(remote).toEqual([]);
  });
