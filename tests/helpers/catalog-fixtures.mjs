import { expect } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * Explicit test data for isolated Playwright contexts only. The application does not import this
 * helper or generate a default catalog. Keep the historic texture pixels stable for image QA.
 * @param {import('@playwright/test').Page} page
 */
export async function seedTestTiles(page) {
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    async function api(path, body) {
      const response = await fetch(
        '/api/d1/' + path,
        body instanceof FormData
          ? { method: 'POST', body }
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }
    const existing = (await api('materials', { operation: 'list' })).map((row) => row.version);
    const catalog = await api('catalog', { operation: 'list' });
    let brand = catalog.options.find((row) => row.kind === 'brand' && row.name === '검증용 자재');
    if (!brand)
      brand = await api('catalog', {
        operation: 'create',
        input: { kind: 'brand', name: '검증용 자재', active: true, sortOrder: 100 },
      });
    const selection = {
      brandId: brand.id,
      colorIds: [],
      compositionIds: [],
      finishIds: [catalog.options.find((row) => row.kind === 'finish' && row.name === '무광').id],
    };
    const palettes = [
      { name: '라이트 스톤', rgb: [201, 199, 188], size: [600, 600] },
      { name: '웜 샌드', rgb: [185, 169, 146], size: [300, 600] },
      { name: '차콜 스톤', rgb: [82, 89, 87], size: [600, 600] },
      { name: '클라우드 화이트', rgb: [232, 233, 224], size: [300, 600] },
    ];
    const entries = [];
    for (const [index, palette] of palettes.entries()) {
      const code = `TEST-STONE-0${index + 1}`;
      if (existing.some((version) => version.code === code && version.brand === '검증용 자재')) continue;
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = (256 * palette.size[1]) / palette.size[0];
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Test texture generation requires Canvas 2D.');
      const pixels = context.createImageData(canvas.width, canvas.height);
      let seed = 1871 + index;
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const noise = (seed / 4294967296 - 0.5) * 11;
        const x = (i / 4) % canvas.width;
        const y = Math.floor(i / 4 / canvas.width);
        const wave = Math.sin(x * 0.055 + y * 0.029) * 1.8;
        pixels.data[i] = palette.rgb[0] + noise + wave;
        pixels.data[i + 1] = palette.rgb[1] + noise + wave;
        pixels.data[i + 2] = palette.rgb[2] + noise + wave;
        pixels.data[i + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error('PNG encoding failed.'))),
          'image/png',
        ),
      );
      const createdAt = new Date().toISOString();
      const assetId = crypto.randomUUID();
      const materialId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      entries.push({
        asset: {
          id: assetId,
          ownerId: 'local',
          name: `${palette.name} 검증.png`,
          mime: 'image/png',
          size: blob.size,
          width: canvas.width,
          height: canvas.height,
          kind: 'texture',
          createdAt,
          blob,
        },
        material: {
          id: materialId,
          ownerId: 'local',
          currentVersionId: versionId,
          active: true,
          scope: 'shared',
          updatedAt: createdAt,
        },
        version: {
          id: versionId,
          materialId,
          version: 1,
          createdAt,
          name: palette.name,
          brand: '검증용 자재',
          code,
          category: 'tile',
          scope: 'shared',
          description: '자동 테스트에서 명시적으로 준비한 직접 제작 질감입니다.',
          color: '',
          catalog: selection,
          finish: '무광',
          widthMm: palette.size[0],
          heightMm: palette.size[1],
          depthMm: 9,
          usage: 'both',
          installation: 'floor',
          coverAssetId: assetId,
          imageAssetIds: [],
          textureAssetIds: [assetId],
          views: [],
          defaultGroutWidth: 2,
          defaultGroutColor: '#d5d1c9',
          defaultPattern: 'grid',
        },
      });
    }
    for (const entry of entries) {
      const form = new FormData();
      const { blob, ...metadata } = entry.asset;
      form.set('metadata', JSON.stringify(metadata));
      form.set('file', blob, metadata.name);
      await api('assets', form);
      await api('materials', { operation: 'create', input: entry.version });
    }
  });
}

/** Upload a checked-in QA photograph through the same input used for user photos.
 * @param {import('@playwright/test').Page} page
 */
export async function uploadBathroomPhoto(page) {
  await expect(page.getByRole('button', { name: '새 프로젝트', exact: true })).toBeEnabled();
  await page.getByTestId('project-upload').setInputFiles(resolve('public/examples/bathroom.png'));
}
