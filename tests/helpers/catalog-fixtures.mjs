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
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('gongganmiri-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const existing = await new Promise((resolve, reject) => {
        const request = database.transaction('versions').objectStore('versions').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
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
            scope: 'personal',
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
            scope: 'personal',
            description: '자동 테스트에서 명시적으로 준비한 직접 제작 질감입니다.',
            color: palette.name,
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
      if (!entries.length) return;
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(['assets', 'materials', 'versions'], 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('Test fixture transaction aborted.'));
        for (const entry of entries) {
          transaction.objectStore('assets').add(entry.asset);
          transaction.objectStore('materials').add(entry.material);
          transaction.objectStore('versions').add(entry.version);
        }
      });
    } finally {
      database.close();
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
