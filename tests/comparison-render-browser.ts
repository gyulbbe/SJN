/** Real single-context WebGL checks: node --experimental-strip-types tests/comparison-render-browser.ts */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';

const bundle = await build({
  stdin: {
    contents: `export {PhotoCompositor} from './src/lib/render/compositor'; export {homography,transformPoint} from './src/lib/render/math';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'ComparisonRenderTest',
  platform: 'browser',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    type Types = typeof import('../src/lib/render/compositor') & typeof import('../src/lib/render/math');
    const { PhotoCompositor, homography, transformPoint } = (
      window as unknown as { ComparisonRenderTest: Types }
    ).ComparisonRenderTest;
    type Scene = import('../src/lib/types').Scene;
    type Fixture = import('../src/lib/types').FixtureInstance;
    type Quad = import('../src/lib/types').Quad;
    type Asset = import('../src/lib/types').AssetRecord;
    type Snapshot = import('../src/lib/types').RenderSnapshot;
    type Material = import('../src/lib/types').MaterialVersion;
    const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    const empty = () => ({ polygon: [], strokes: [] });
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const makeAsset = async (id: string, fill: string, sprite = false): Promise<Asset> => {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const context = canvas.getContext('2d')!;
      context.fillStyle = fill;
      if (sprite) {
        context.fillRect(40, 30, 160, 120);
        context.fillStyle = '#22cc44';
        context.fillRect(200, 30, 160, 120);
        context.fillStyle = '#2255ff';
        context.fillRect(40, 150, 160, 120);
        context.fillStyle = '#ffff22';
        context.fillRect(200, 150, 160, 120);
      } else context.fillRect(0, 0, 400, 300);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'));
      return {
        id,
        ownerId: 'test',
        name: id,
        mime: 'image/png',
        size: blob.size,
        width: 400,
        height: 300,
        kind: sprite ? 'product' : 'original',
        createdAt: new Date().toISOString(),
        blob,
      };
    };
    const records = await Promise.all([
      makeAsset('source', '#808080'),
      makeAsset('old', '#996633'),
      makeAsset('new', '#336699'),
      makeAsset('old-product', '#ff2222', true),
    ]);
    const assets = Object.fromEntries(records.map((asset) => [asset.id, asset]));
    const reader = async (id: string) => {
      if (!assets[id]) throw new Error('Missing asset ' + id);
      return assets[id];
    };
    const material = (id: string, category: Material['category'] = 'tile'): Material => ({
      id,
      materialId: id,
      version: 1,
      name: id,
      brand: '',
      code: '',
      category,
      scope: 'personal',
      description: '',
      color: '#ffffff',
      finish: '',
      widthMm: 600,
      heightMm: 600,
      depthMm: 0,
      usage: 'both',
      installation: 'floor',
      coverAssetId: id,
      imageAssetIds: [id],
      textureAssetIds: category === 'tile' ? [id] : [],
      views: [],
      defaultGroutWidth: 0,
      defaultGroutColor: '#ffffff',
      defaultPattern: 'grid',
      createdAt: new Date().toISOString(),
    });
    const materials = Object.fromEntries(
      ['old', 'new', 'old-product'].map((id) => [id, material(id, id === 'old-product' ? 'basin' : 'tile')]),
    );
    const makeScene = (version: string): Scene => ({
      originalAssetId: 'source',
      previewAssetId: 'source',
      imageWidth: 400,
      imageHeight: 300,
      surfaces: [
        {
          id: 'same-layer-id',
          name: '바닥',
          kind: 'floor',
          quad,
          mask: { polygon: quad, strokes: [] },
          widthMm: 2400,
          heightMm: 2400,
          calibrated: false,
          materialVersionId: version,
          tile: {
            rotation: 0,
            offsetX: 0,
            offsetY: 0,
            groutWidth: 0,
            groutColor: '#ffffff',
            pattern: 'grid',
            seed: 1,
            shading: 0,
          },
          color: { ...color },
        },
      ],
      fixtures: [],
      protection: empty(),
      color: { ...color },
    });
    const old = makeScene('old');
    old.protection = {
      polygon: [
        { x: 0, y: 0 },
        { x: 0.15, y: 0 },
        { x: 0.15, y: 1 },
        { x: 0, y: 1 },
      ],
      strokes: [],
    };
    const fixture: Fixture = {
      id: 'old-fixture',
      name: '기존 물체',
      materialVersionId: 'old-product',
      viewIndex: 0,
      position: { x: 0.5, y: 0.5 },
      width: 0.4,
      height: 0.4,
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      locked: false,
      shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
      occlusion: empty(),
      color: { ...color },
    };
    old.fixtures = [fixture];
    let snapshot: Snapshot = { scene: makeScene('new'), beforeScene: old, materials };
    const engine = new PhotoCompositor();
    document.body.append(engine.canvas);
    const pixel = (canvas: HTMLCanvasElement, x: number, y: number) => {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d')!;
      context.drawImage(canvas, 0, 0);
      return [
        ...context.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data,
      ];
    };
    let checks = 0;
    const close = (actual: number[], expected: number[], label: string, tolerance = 3) => {
      if (actual.slice(0, 3).some((value, i) => Math.abs(value - expected[i]) > tolerance))
        throw new Error(label + ': ' + actual + ' expected ' + expected);
      checks++;
    };
    const inspected = engine as unknown as {
      composeScene: (scene: Scene, ...rest: unknown[]) => unknown;
      beforePrepared: { scene: Scene };
      beforePreparedKey: string;
      quality: { quality: string };
      snapshot: Snapshot;
    };
    const compose = inspected.composeScene.bind(engine);
    let beforeCompositions = 0;
    inspected.composeScene = (scene, ...rest) => {
      if (scene === inspected.beforePrepared?.scene) beforeCompositions++;
      return compose(scene, ...rest);
    };
    await engine.setSnapshot(snapshot, reader);
    close(pixel(engine.render(400, 300, 'before'), 0.2, 0.5), [153, 102, 51], 'Before includes old tiles');
    close(pixel(engine.canvas, 0.4, 0.4), [255, 34, 34], 'Before includes old fixture');
    close(pixel(engine.canvas, 0.05, 0.5), [128, 128, 128], 'Before own protection');
    close(
      pixel(engine.render(400, 300, 'after'), 0.05, 0.5),
      [51, 102, 153],
      'After mask isolated despite cloned ids',
    );
    close(pixel(engine.canvas, 0.4, 0.4), [51, 102, 153], 'After starts without old fixture');
    close(pixel(engine.render(400, 300, 'split', 0.5), 0.2, 0.5), [153, 102, 51], 'Split old scene');
    close(pixel(engine.canvas, 0.8, 0.5), [51, 102, 153], 'Split new scene');
    const cachedCompositions = beforeCompositions;
    for (let index = 0; index < 6; index++) {
      snapshot = structuredClone(snapshot);
      snapshot.scene.surfaces[0].tile.offsetX += 10;
      snapshot.scene.fixtures = [
        {
          ...structuredClone(fixture),
          id: 'new-fixture',
          position: { x: 0.1 + index * 0.12, y: 0.94 },
          width: 0.08,
          height: 0.08,
        },
      ];
      await engine.setSnapshot(snapshot, reader);
      engine.render(400, 300, 'split', 0.35 + index * 0.03);
    }
    const beforeDraftRecompositions = beforeCompositions - cachedCompositions;
    if (beforeCompositions !== cachedCompositions)
      throw new Error('Unchanged Before recomposited during After drafts');
    checks++;
    const linearExposure = (byte: number) => {
      const srgb = byte / 255;
      const linear = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      const exposed = linear * 2;
      return Math.round(
        255 * (exposed <= 0.0031308 ? exposed * 12.92 : 1.055 * exposed ** (1 / 2.4) - 0.055),
      );
    };
    snapshot = structuredClone(snapshot);
    snapshot.beforeScene!.color.exposure = 1;
    await engine.setSnapshot(snapshot, reader);
    close(
      pixel(engine.render(400, 300, 'split', 0.5), 0.2, 0.5),
      [153, 102, 51].map(linearExposure),
      'Before independent linear exposure with one sRGB encode',
    );
    close(pixel(engine.canvas, 0.8, 0.5), [51, 102, 153], 'Before correction does not change After');
    if (beforeCompositions !== cachedCompositions + 1)
      throw new Error('Changed Before did not invalidate cached render');
    snapshot = structuredClone(snapshot);
    snapshot.beforeScene!.color.exposure = 0;
    const projectedQuad: Quad = [
      { x: 0.15, y: 0.15 },
      { x: 0.75, y: 0.35 },
      { x: 0.75, y: 0.85 },
      { x: 0.15, y: 0.85 },
    ];
    snapshot.beforeScene!.fixtures[0].projectedQuad = projectedQuad;
    await engine.setSnapshot(snapshot, reader);
    engine.render(400, 300, 'before');
    const project = homography(quad, projectedQuad);
    const sampleProjected = (u: number, v: number) => {
      const p = transformPoint(project, { x: u, y: v });
      return pixel(engine.canvas, p.x, p.y);
    };
    close(sampleProjected(0.25, 0.25), [255, 34, 34], 'Planar sprite upper left UV');
    close(sampleProjected(0.75, 0.25), [34, 204, 68], 'Planar sprite upper right UV');
    close(sampleProjected(0.25, 0.75), [34, 85, 255], 'Planar sprite lower left UV');
    close(sampleProjected(0.75, 0.75), [255, 255, 34], 'Planar sprite lower right UV');
    close(sampleProjected(0.05, 0.5), [153, 102, 51], 'Planar sprite transparent border');
    close(pixel(engine.canvas, 0.05, 0.95), [128, 128, 128], 'Planar sprite outside quad');
    snapshot = structuredClone(snapshot);
    snapshot.beforeScene!.fixtures[0].occlusion = {
      polygon: [
        { x: 0.45, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0.45, y: 1 },
      ],
      strokes: [],
    };
    await engine.setSnapshot(snapshot, reader);
    engine.render(400, 300, 'before');
    close(sampleProjected(0.75, 0.75), [153, 102, 51], 'Planar sprite occlusion');
    engine.render(400, 300, 'split', 0.37);
    const beforeExport = {
      scene: inspected.snapshot,
      width: engine.canvas.width,
      height: engine.canvas.height,
    };
    const exported = await engine.exportImage(snapshot, 400, 300, 'image/png', true);
    const bitmap = await createImageBitmap(exported);
    if (bitmap.width !== 400 || bitmap.height !== 150) throw new Error('Comparison export aspect/size wrong');
    const output = document.createElement('canvas');
    output.width = bitmap.width;
    output.height = bitmap.height;
    output.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    close(pixel(output, 0.1, 0.5), [153, 102, 51], 'Comparison export Before');
    close(pixel(output, 0.9, 0.5), [51, 102, 153], 'Comparison export After');
    if (
      inspected.snapshot !== beforeExport.scene ||
      inspected.quality.quality !== 'preview' ||
      engine.canvas.width !== 400 ||
      engine.canvas.height !== 300
    )
      throw new Error('Comparison export failed to restore view');
    close(pixel(engine.canvas, 0.8, 0.5), [51, 102, 153], 'Comparison export restored split');
    let failed = false;
    try {
      await engine.exportImage(
        { ...snapshot, beforeScene: { ...snapshot.beforeScene!, originalAssetId: 'missing' } },
        400,
        300,
        'image/png',
        true,
      );
    } catch {
      failed = true;
    }
    if (!failed || inspected.snapshot !== snapshot || inspected.quality.quality !== 'preview')
      throw new Error('Failed Before export did not restore snapshot');
    close(pixel(engine.canvas, 0.8, 0.5), [51, 102, 153], 'Failed export restores After');
    await engine.setSnapshot({ scene: snapshot.scene, materials }, reader);
    close(
      pixel(engine.render(400, 300, 'before'), 0.2, 0.5),
      [128, 128, 128],
      'Legacy Before remains original photo',
    );
    close(
      pixel(engine.render(400, 300, 'split', 0.5), 0.8, 0.5),
      [51, 102, 153],
      'Legacy After remains edited',
    );
    const context = engine.canvas.getContext('webgl2')!;
    const info = context.getExtension('WEBGL_debug_renderer_info');
    const gpu = info
      ? context.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : context.getParameter(context.RENDERER);
    engine.dispose();
    return {
      checks,
      beforeCompositionsDuringSixAfterDrafts: beforeDraftRecompositions,
      cachedBeforeVerified: true,
      projectedQuadUVVerified: true,
      exportAndFailureRestoreVerified: true,
      gpu,
    };
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
