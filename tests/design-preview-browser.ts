/** Real WebGL checks for the shared design preview queue. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
const bundle = await build({
  stdin: {
    contents: `export {DesignPreviewService} from './src/lib/render/design-preview'; export {PhotoCompositor} from './src/lib/render/compositor';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'PreviewTest',
  platform: 'browser',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  await page.route('http://localhost/design-preview-test', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://localhost/design-preview-test');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    type Types = typeof import('../src/lib/render/design-preview') &
      typeof import('../src/lib/render/compositor');
    const { DesignPreviewService, PhotoCompositor } = (window as unknown as { PreviewTest: Types })
      .PreviewTest;
    type Asset = import('../src/lib/types').AssetRecord;
    type Material = import('../src/lib/types').MaterialVersion;
    type Input = import('../src/lib/render/design-preview').DesignPreviewInput;
    const assets: Record<string, Asset> = {};
    async function asset(id: string, fill: string, width: number, height: number) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      context.fillStyle = fill;
      context.fillRect(0, 0, width, height);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'));
      assets[id] = {
        id,
        ownerId: 'test',
        name: id,
        mime: 'image/png',
        size: blob.size,
        width,
        height,
        kind: 'texture',
        createdAt: new Date().toISOString(),
        blob,
      };
      canvas.width = canvas.height = 1;
    }
    await asset('background', '#888888', 4096, 2730);
    await asset('tile', '#55775d', 2048, 2048);
    const material: Material = {
      id: 'material',
      materialId: 'm',
      version: 1,
      name: '직접 제작 타일',
      brand: '',
      code: '',
      category: 'tile',
      scope: 'personal',
      description: '',
      color: '#55775d',
      finish: '',
      widthMm: 600,
      heightMm: 600,
      depthMm: 10,
      usage: 'both',
      installation: 'floor',
      coverAssetId: 'tile',
      imageAssetIds: ['tile'],
      textureAssetIds: ['tile'],
      views: [],
      defaultGroutWidth: 0,
      defaultGroutColor: '#ddd',
      defaultPattern: 'grid',
      createdAt: new Date().toISOString(),
    };
    const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    const quad: import('../src/lib/types').Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const inputs: Input[] = Array.from({ length: 5 }, (_, index) => ({
      projectId: 'test',
      sharedRevision: 0,
      purpose: 'comparison',
      edge: 1024,
      materials: { material },
      design: {
        id: String(index),
        name: `시안 ${index}`,
        revision: 0,
        scene: {
          originalAssetId: 'background',
          previewAssetId: 'background',
          imageWidth: 4096,
          imageHeight: 2730,
          color: { ...color, exposure: index * 0.25 },
          surfaces: [
            {
              id: 'floor',
              name: '바닥',
              kind: 'floor',
              quad,
              mask: { polygon: quad, strokes: [] },
              widthMm: 3000,
              heightMm: 2000,
              calibrated: true,
              materialVersionId: 'material',
              tile: {
                rotation: 0,
                offsetX: 0,
                offsetY: 0,
                groutWidth: 0,
                groutColor: '#ddd',
                pattern: 'grid',
                seed: 1,
                shading: 0,
              },
              color: { ...color },
            },
          ],
          fixtures: [],
          protection: { polygon: [], strokes: [] },
        },
      },
    }));
    let contexts = 0;
    let renderer: InstanceType<typeof PhotoCompositor> | undefined;
    const reads: Record<string, number> = {};
    const service = new DesignPreviewService(
      async (id) => {
        reads[id] = (reads[id] ?? 0) + 1;
        return assets[id];
      },
      {
        createRenderer: () => {
          contexts++;
          return (renderer = new PhotoCompositor());
        },
        readCache: async () => undefined,
        writeCache: async () => {},
      },
    );
    const pixel = async (blob: Blob, x = 0.5, y = 0.5) => {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const value = [
        ...context.getImageData(
          Math.min(canvas.width - 1, Math.floor(x * canvas.width)),
          Math.min(canvas.height - 1, Math.floor(y * canvas.height)),
          1,
          1,
        ).data,
      ];
      const size = { width: canvas.width, height: canvas.height };
      canvas.width = canvas.height = 1;
      return { value, ...size };
    };
    const started = performance.now();
    const previews = await Promise.all(inputs.map((input, index) => service.request(String(index), input)));
    const previewMs = performance.now() - started;
    const pixels = await Promise.all(previews.map((result) => pixel(result.blob)));
    const internals = renderer as unknown as {
      images: Map<string, Promise<HTMLCanvasElement>>;
      textures: Map<string, unknown>;
    };
    const compactImages = await Promise.all(
      [...internals.images].map(async ([key, promise]) => {
        const image = await promise;
        return { key, width: image.width, height: image.height };
      }),
    );
    const readsBeforeExport = { ...reads };
    const exported = await service.exportDesign('export', inputs[2]);
    const exportPixel = await pixel(exported);
    const grid = await service.exportComparison('grid', inputs);
    const gridSize = await pixel(grid);
    const gridPixels = await Promise.all(
      inputs.map((_, index) => pixel(grid, ((index % 3) + 0.5) / 3, (Math.floor(index / 3) + 0.5) / 2)),
    );
    const blank = await pixel(grid, 5 / 6, 3 / 4);
    const gl = renderer!.canvas.getContext('webgl2')!;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable';
    service.dispose();
    return {
      contexts,
      readsBeforeExport,
      compactImages,
      pixels,
      previewMs,
      exportPixel,
      gridSize: { width: gridSize.width, height: gridSize.height },
      gridPixels,
      blank: blank.value,
      cacheAfterDispose: { images: internals.images.size, textures: internals.textures.size },
      browser: navigator.userAgent,
      gpu,
    };
  });
  assert.equal(result.contexts, 1);
  assert.deepEqual(result.readsBeforeExport, { background: 2, tile: 1 });
  assert.deepEqual(
    result.compactImages.map((entry) => Math.max(entry.width, entry.height)).sort((a, b) => a - b),
    [256, 512, 1024],
  );
  for (let i = 1; i < 5; i++)
    assert.ok(
      result.pixels[i].value[1] > result.pixels[i - 1].value[1],
      'Per-design exposure must remain distinct',
    );
  assert.equal(result.exportPixel.width, 4096);
  assert.equal(result.exportPixel.height, 2730);
  for (let i = 0; i < 3; i++)
    assert.ok(
      Math.abs(result.exportPixel.value[i] - result.pixels[2].value[i]) <= 2,
      'Full export matches preview color',
    );
  assert.equal(Math.max(result.gridSize.width, result.gridSize.height), 4096);
  result.gridPixels.forEach((pixel, index) =>
    pixel.value
      .slice(0, 3)
      .forEach((value, channel) =>
        assert.ok(
          Math.abs(value - result.pixels[index].value[channel]) <= 2,
          'Grid cell matches that design',
        ),
      ),
  );
  assert.deepEqual(result.blank, [243, 244, 242, 255]);
  assert.deepEqual(result.cacheAfterDispose, { images: 0, textures: 0 });
  assert.deepEqual(errors, []);
  await mkdir('test-results/design-preview', { recursive: true });
  await writeFile('test-results/design-preview/webgl.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: 'pass', ...result }, null, 2));
} finally {
  await browser.close();
}
