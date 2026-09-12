/** Real photo + controlled contact-shadow/grout regression. Outputs test-results/shading-quality. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const directory = 'test-results/shading-quality';
await mkdir(directory, { recursive: true });
const current = await build({
  entryPoints: ['src/lib/render/compositor.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'UpdatedRenderer',
});
let baseline = '';
try {
  baseline = await readFile(`${directory}/baseline-renderer.js`, 'utf8');
} catch {
  /* Optional captured pre-fix bundle; current assertions remain reproducible. */
}
const photo = await readFile('public/examples/bathroom.png');
const server = createServer((request, response) => {
  if (request.url === '/photo.png') {
    response.setHeader('Content-Type', 'image/png');
    response.end(photo);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<body style="margin:0;background:#ecece9;font:16px sans-serif"></body>');
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1560, height: 1120 } });
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  if (baseline) await page.addScriptTag({ content: baseline });
  await page.addScriptTag({ content: current.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    type Library = typeof import('../src/lib/render/compositor');
    const libraries = window as unknown as { UpdatedRenderer: Library; BaselineRenderer?: Library };
    const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    const empty = () => ({ polygon: [], strokes: [] });
    const unit: import('../src/lib/types').Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const assets: Record<string, import('../src/lib/types').ImageAssetRecord> = {};
    const makeAsset = async (id: string, canvas: HTMLCanvasElement) => {
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)));
      assets[id] = {
        id,
        blob,
        ownerId: 'test',
        mime: 'image/png',
        name: id,
        size: blob.size,
        width: canvas.width,
        height: canvas.height,
        kind: 'original',
        createdAt: new Date().toISOString(),
      };
      return id;
    };
    const canvas = (w: number, h: number) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    const tile = canvas(256, 256);
    tile.getContext('2d')!.fillStyle = '#c9c7bc';
    tile.getContext('2d')!.fillRect(0, 0, 256, 256);
    await makeAsset('tile', tile);
    const raw = await createImageBitmap(await (await fetch('/photo.png')).blob());
    const real = canvas(raw.width, raw.height);
    real.getContext('2d')!.drawImage(raw, 0, 0);
    raw.close();
    await makeAsset('real', real);
    const synthetic = canvas(512, 384),
      ctx = synthetic.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 512, 384);
    const shadow = ctx.createRadialGradient(335, 298, 0, 335, 298, 72);
    shadow.addColorStop(0, 'rgba(0,0,0,.8)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    ctx.fillRect(240, 224, 184, 148);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(300, 60, 70, 238);
    await makeAsset('synthetic', synthetic);
    const material: import('../src/lib/types').MaterialVersion = {
      id: 'tile-v1',
      materialId: 'tile',
      version: 1,
      name: '검증용 단색 스톤',
      brand: '',
      code: '',
      category: 'tile',
      scope: 'personal',
      description: '',
      color: '#c9c7bc',
      finish: '',
      widthMm: 600,
      heightMm: 600,
      depthMm: 9,
      usage: 'both',
      installation: 'floor',
      coverAssetId: 'tile',
      textureAssetIds: ['tile'],
      imageAssetIds: [],
      views: [],
      defaultGroutWidth: 2,
      defaultGroutColor: '#d5d1c9',
      defaultPattern: 'grid',
      createdAt: new Date().toISOString(),
    };
    const surface = (
      mask: import('../src/lib/types').Mask,
      quad: import('../src/lib/types').Quad,
    ): import('../src/lib/types').Surface => ({
      id: 'floor',
      name: '바닥',
      kind: 'floor',
      mask,
      quad,
      widthMm: 2200,
      heightMm: 2400,
      calibrated: false,
      materialVersionId: material.id,
      tile: {
        rotation: 0,
        offsetX: 0,
        offsetY: 0,
        groutWidth: 0,
        groutColor: '#d5d1c9',
        pattern: 'grid',
        seed: 12,
        shading: 0.25,
      },
      color,
    });
    // A fixed hand-annotated test stencil isolates lighting changes from semantic segmentation or plane updates.
    const realQuad: import('../src/lib/types').Quad = [
      { x: 0.262, y: 0.716 },
      { x: 0.717, y: 0.716 },
      { x: 0.921, y: 1 },
      { x: 0.114, y: 1 },
    ];
    const realFloor = surface(
      {
        polygon: realQuad,
        holes: [
          [
            { x: 0.606, y: 0.69 },
            { x: 0.706, y: 0.69 },
            { x: 0.706, y: 0.821 },
            { x: 0.606, y: 0.821 },
          ],
          [
            { x: 0.34, y: 0.69 },
            { x: 0.394, y: 0.69 },
            { x: 0.394, y: 0.756 },
            { x: 0.34, y: 0.756 },
          ],
        ],
        strokes: [],
      },
      realQuad,
    );
    const syntheticFloor = surface(
      {
        polygon: [
          { x: 0, y: 1 / 3 },
          { x: 1, y: 1 / 3 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        holes: [
          [
            { x: 300 / 512, y: 60 / 384 },
            { x: 370 / 512, y: 60 / 384 },
            { x: 370 / 512, y: 298 / 384 },
            { x: 300 / 512, y: 298 / 384 },
          ],
        ],
        strokes: [],
      },
      unit,
    );
    const snapshot = (
      id: string,
      floor: import('../src/lib/types').Surface,
    ): import('../src/lib/types').RenderSnapshot => ({
      materials: { [material.id]: material },
      scene: {
        originalAssetId: id,
        previewAssetId: id,
        imageWidth: assets[id].width,
        imageHeight: assets[id].height,
        surfaces: [floor],
        fixtures: [],
        protection: empty(),
        color,
      },
    });
    const copy = (source: HTMLCanvasElement) => {
      const c = canvas(source.width, source.height);
      c.getContext('2d')!.drawImage(source, 0, 0);
      return c;
    };
    const pixel = (source: HTMLCanvasElement, x: number, y: number) => [
      ...source
        .getContext('2d', { willReadFrequently: true })!
        .getImageData(Math.round(source.width * x), Math.round(source.height * y), 1, 1).data,
    ];
    const names: { name: string; x: number; y: number }[] = [
      { name: 'frontFloor', x: 0.49, y: 0.925 },
      { name: 'rightCorner', x: 0.735, y: 0.771 },
      { name: 'leftWallContact', x: 0.233, y: 0.822 },
      { name: 'basinSide', x: 0.405, y: 0.751 },
    ];
    const outputs: Record<string, string> = {},
      metrics: Record<string, unknown> = {};
    for (const [name, library] of [
      ['before', libraries.BaselineRenderer],
      ['after', libraries.UpdatedRenderer],
    ] as const) {
      if (!library) continue;
      const renderer = new library.PhotoCompositor();
      for (const strength of [0.25, 0.65]) {
        const floor = { ...realFloor, tile: { ...realFloor.tile, shading: strength, groutWidth: 2 } };
        const start = performance.now();
        await renderer.setSnapshot(snapshot('real', floor), async (id) => assets[id]);
        renderer.render(real.width, real.height);
        const output = copy(renderer.canvas);
        outputs[`real-${name}-${strength}`] = output.toDataURL();
        metrics[`real-${name}-${strength}`] = {
          prepareRenderAndPngMs: performance.now() - start,
          pixels: Object.fromEntries(names.map((p) => [p.name, pixel(output, p.x, p.y)])),
        };
      }
      await renderer.setSnapshot(
        snapshot('synthetic', { ...syntheticFloor, tile: { ...syntheticFloor.tile, shading: 0.65 } }),
        async (id) => assets[id],
      );
      renderer.render(512, 384);
      const output = copy(renderer.canvas);
      outputs[`synthetic-${name}`] = output.toDataURL();
      metrics[`synthetic-${name}`] = {
        neutral: pixel(output, 180 / 512, 185 / 384),
        besideWhiteFixture: pixel(output, 292 / 512, 185 / 384),
        contact: pixel(output, 290 / 512, 294 / 384),
        originalHole: pixel(output, 335 / 512, 180 / 384),
      };
      const linear = (value: number) =>
        value / 255 <= 0.04045 ? value / 255 / 12.92 : Math.pow((value / 255 + 0.055) / 1.055, 2.4);
      const amounts: number[] = [];
      for (let phase = 0; phase < 12; phase++) {
        const groutFloor = {
          ...surface({ polygon: unit, strokes: [] }, unit),
          widthMm: 2408,
          heightMm: 1700,
          tile: {
            ...syntheticFloor.tile,
            shading: 0,
            groutWidth: 2,
            groutColor: '#666666',
            offsetX: ((phase / 12) * 2408) / 400,
          },
        };
        await renderer.setSnapshot(snapshot('synthetic', groutFloor), async (id) => assets[id]);
        renderer.render(400, 300);
        const line = copy(renderer.canvas).getContext('2d')!.getImageData(0, 129, 400, 1).data;
        let amount = 0;
        for (let x = 0; x < 400; x++)
          amount += (linear(201) - linear(line[x * 4])) / (linear(201) - linear(102));
        amounts.push(amount / 400);
      }
      metrics[`grout-${name}`] = {
        expected: 2 / 602,
        minimum: Math.min(...amounts),
        maximum: Math.max(...amounts),
        mean: amounts.reduce((a, b) => a + b) / amounts.length,
      };
      if (name === 'after') {
        const readMask = () =>
          (renderer as unknown as { tilePasses: { mask: { image: HTMLCanvasElement } }[] }).tilePasses[0].mask
            .image;
        const imageEdgeAlpha = pixel(readMask(), 0, 0)[3];
        const points = [
          [64, 64],
          [400, 64],
          [400, 128],
          [384, 128],
          [384, 144],
          [368, 144],
          [368, 160],
          [352, 160],
          [352, 176],
          [64, 176],
        ];
        const rect = (x: number, y: number, width: number, height: number) => [
          { x: x / 512, y: y / 384 },
          { x: (x + width) / 512, y: y / 384 },
          { x: (x + width) / 512, y: (y + height) / 384 },
          { x: x / 512, y: (y + height) / 384 },
        ];
        const mask = {
          polygon: points.map(([x, y]) => ({ x: x / 512, y: y / 384 })),
          holes: [rect(200, 96, 24, 24)],
          strokes: [],
        };
        const scene = snapshot('synthetic', surface(mask, unit));
        scene.scene.protection = { polygon: rect(96, 100, 24, 24), strokes: [] };
        await renderer.setSnapshot(scene, async (id) => assets[id]);
        const softened = readMask();
        const expected = canvas(512, 384);
        const expectedContext = expected.getContext('2d')!;
        expectedContext.beginPath();
        points.forEach(([x, y], i) => (i ? expectedContext.lineTo(x, y) : expectedContext.moveTo(x, y)));
        expectedContext.closePath();
        expectedContext.fill();
        expectedContext.clearRect(200, 96, 24, 24);
        expectedContext.clearRect(96, 100, 24, 24);
        const initial = expectedContext.getImageData(0, 0, 512, 384).data;
        const actual = softened.getContext('2d')!.getImageData(0, 0, 512, 384).data;
        let extraCoveragePixels = 0;
        let featheredPixels = 0;
        for (let i = 3; i < actual.length; i += 4) {
          if (actual[i] > initial[i]) extraCoveragePixels++;
          if (actual[i] > 0 && actual[i] < initial[i]) featheredPixels++;
        }
        metrics['mask-coverage'] = {
          extraCoveragePixels,
          featheredPixels,
          imageEdgeAlpha,
          interiorAlpha: pixel(softened, 300 / 512, 100 / 384)[3],
          stepEdgeAlpha: pixel(softened, 399 / 512, 100 / 384)[3],
          protectedAlpha: pixel(softened, 110 / 512, 110 / 384)[3],
          holeAlpha: pixel(softened, 210 / 512, 110 / 384)[3],
        };
        outputs['mask-feathered'] = softened.toDataURL();
      }
      renderer.dispose();
    }
    const roomLight = canvas(600, 300);
    const lightCtx = roomLight.getContext('2d')!;
    ['#c0c0c0', '#808080', '#404040'].forEach((value, i) => {
      lightCtx.fillStyle = value;
      lightCtx.fillRect(i * 200, 0, 200, 300);
    });
    await makeAsset('wall-light', roomLight);
    const wallPlanes = [0, 1, 2].map((i) => {
      const quad: import('../src/lib/types').Quad = [
        { x: i / 3, y: 0 },
        { x: (i + 1) / 3, y: 0 },
        { x: (i + 1) / 3, y: 1 },
        { x: i / 3, y: 1 },
      ];
      const base = surface({ polygon: quad, strokes: [] }, quad);
      return { ...base, id: `wall-${i}`, kind: 'wall' as const, tile: { ...base.tile, shading: 0.65 } };
    });
    const wallRenderer = new libraries.UpdatedRenderer.PhotoCompositor();
    const wallSnapshot = snapshot('wall-light', wallPlanes[0]);
    wallSnapshot.scene.surfaces = wallPlanes;
    await wallRenderer.setSnapshot(wallSnapshot, async (id) => assets[id]);
    wallRenderer.render(600, 300);
    const allWalls = copy(wallRenderer.canvas);
    outputs['wall-common-reference'] = allWalls.toDataURL();
    const allPixels = [1 / 6, 0.5, 5 / 6].map((x) => pixel(allWalls, x, 0.5));
    const oneUnpainted = structuredClone(wallSnapshot);
    delete oneUnpainted.scene.surfaces[1].materialVersionId;
    await wallRenderer.setSnapshot(oneUnpainted, async (id) => assets[id]);
    wallRenderer.render(600, 300);
    const partialWalls = copy(wallRenderer.canvas);
    const merged = snapshot('wall-light', {
      ...surface({ polygon: unit, strokes: [] }, unit),
      kind: 'wall',
      tile: { ...wallPlanes[0].tile },
    });
    await wallRenderer.setSnapshot(merged, async (id) => assets[id]);
    wallRenderer.render(600, 300);
    const mergedWall = copy(wallRenderer.canvas);
    metrics.wallLighting = {
      allPixels,
      unpaintedNeighborPixels: [pixel(partialWalls, 1 / 6, 0.5), pixel(partialWalls, 5 / 6, 0.5)],
      mergedPixels: [1 / 6, 0.5, 5 / 6].map((x) => pixel(mergedWall, x, 0.5)),
    };
    wallRenderer.dispose();
    outputs.original = real.toDataURL();
    return { metrics, outputs, userAgent: navigator.userAgent };
  });
  for (const [name, data] of Object.entries(result.outputs))
    await writeFile(`${directory}/${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
  const wallLighting = result.metrics.wallLighting as {
    allPixels: number[][];
    unpaintedNeighborPixels: number[][];
    mergedPixels: number[][];
  };
  assert.ok(
    wallLighting.allPixels[0][0] - wallLighting.allPixels[1][0] > 20 &&
      wallLighting.allPixels[1][0] - wallLighting.allPixels[2][0] > 20,
    'Different wall light levels must not be normalized to the same brightness',
  );
  assert.deepEqual(
    wallLighting.unpaintedNeighborPixels,
    [wallLighting.allPixels[0], wallLighting.allPixels[2]],
    'Changing a neighboring wall material must not alter the lighting reference',
  );
  for (let i = 0; i < 3; i++)
    assert.ok(
      Math.abs(wallLighting.allPixels[i][0] - wallLighting.mergedPixels[i][0]) <= 2,
      'Splitting the same source wall must preserve its lighting',
    );
  const synthetic = result.metrics['synthetic-after'] as {
    neutral: number[];
    besideWhiteFixture: number[];
    contact: number[];
    originalHole: number[];
  };
  assert.ok(
    Math.abs(synthetic.neutral[0] - synthetic.besideWhiteFixture[0]) <= 3,
    'Excluded white product must not cast a brightness halo',
  );
  assert.ok(
    synthetic.neutral[0] - synthetic.contact[0] >= 10,
    'Low-frequency contact shadow should remain visible',
  );
  assert.equal(synthetic.originalHole[0], 255, 'Original product pixels remain untouched');
  const grout = result.metrics['grout-after'] as {
    expected: number;
    minimum: number;
    maximum: number;
    mean: number;
  };
  assert.ok(Math.abs(grout.mean - grout.expected) < 0.00035, 'Subpixel grout should preserve physical width');
  assert.ok(
    (grout.maximum - grout.minimum) / grout.expected < 0.16,
    'Grout coverage must stay stable across pixel phase',
  );
  const coverage = result.metrics['mask-coverage'] as Record<string, number>;
  assert.equal(coverage.extraCoveragePixels, 0, 'Feather must never grow outside the original coverage');
  assert.ok(coverage.featheredPixels > 500, 'The staircase and hole boundaries should receive inner feather');
  assert.equal(coverage.imageEdgeAlpha, 255, 'A fully covered photo edge must stay fully covered');
  assert.equal(coverage.interiorAlpha, 255, 'Interior coverage must stay opaque');
  assert.ok(
    coverage.stepEdgeAlpha > 0 && coverage.stepEdgeAlpha < 255,
    'A hard step receives partial coverage',
  );
  assert.equal(coverage.protectedAlpha, 0, 'Protected pixels must remain excluded');
  assert.equal(coverage.holeAlpha, 0, 'Mask holes must remain excluded');
  await writeFile(
    `${directory}/report.json`,
    JSON.stringify(
      { browser: result.userAgent, hasCapturedBaseline: !!baseline, ...result.metrics },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      { browser: result.userAgent, hasCapturedBaseline: !!baseline, ...result.metrics },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
