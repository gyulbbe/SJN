/**
 * The SMC ceiling drawn with real WebGL (no AI call): in the 3D room renderer it shows in the four
 * views and the AI's front view, hides for a camera above it, keeps every other pixel, and its light
 * off takes the panel and the downlight; in the 2D compositor it covers only its own quad. It also
 * measures the 3D room's brightness without the downlight, which CEILING_LIGHT_OFF_LEVEL holds.
 *
 * node tests/run-browser-test.mjs tests/smc-ceiling-browser.ts
 * Output: test-results/smc-ceiling/browser/
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const output = 'test-results/smc-ceiling/browser';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer'; export * from './src/lib/room-viewer/view-state'; export * from './src/lib/ai-export/view'; export { visibleCeiling } from './src/lib/ai-export/scene'; export { createRoomSurfaces, DEFAULT_ROOM } from './src/lib/room-geometry'; export * from './src/lib/smc-ceiling'; export * from './src/lib/render/compositor';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'CeilingTest',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await page.route('http://127.0.0.1:43213/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"></body></html>' }),
  );
  let pictureReads = 0;
  const picture = await readFile('public/ceiling/smc-ceiling.webp');
  await page.route('**/ceiling/smc-ceiling.webp', (route) => {
    pictureReads++;
    return route.fulfill({ contentType: 'image/webp', body: picture });
  });
  await page.goto('http://127.0.0.1:43213/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('../src/lib/ai-export/view') &
      typeof import('../src/lib/room-geometry') &
      typeof import('../src/lib/smc-ceiling') &
      typeof import('../src/lib/render/compositor') & {
        visibleCeiling: typeof import('../src/lib/ai-export/scene').visibleCeiling;
      };
    const lib = (window as unknown as { CeilingTest: Lib }).CeilingTest;
    type Scene = import('../src/lib/types').Scene;
    const checks: string[] = [];
    const check = (condition: unknown, message: string) => {
      if (!condition) throw new Error(message);
      checks.push(message);
    };
    const assets: Record<string, import('../src/lib/types').AssetRecord> = {};
    const solid = async (id: string, color: string, width = 64, height = 64) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
      assets[id] = {
        id,
        ownerId: 'test',
        name: id,
        mime: 'image/png',
        size: blob.size,
        width,
        height,
        kind: id === 'photo' ? 'original' : 'texture',
        blob,
        createdAt: '2026-10-31',
      };
    };
    await solid('tile', '#5f7f8f');
    await solid('photo', '#f6f4ef', 1200, 800);
    const materials = {
      tile: {
        id: 'tile',
        materialId: 'tile',
        version: 1,
        name: 'tile',
        brand: '',
        code: '',
        category: 'tile',
        scope: 'personal',
        description: '',
        color: '#ffffff',
        finish: '',
        widthMm: 300,
        heightMm: 300,
        depthMm: 8,
        usage: 'both',
        installation: 'wall',
        textureAssetIds: ['tile'],
        views: [],
        defaultGroutWidth: 2,
        defaultGroutColor: '#ffffff',
        defaultPattern: 'grid',
        createdAt: '2026-10-31',
      } as import('../src/lib/types').MaterialVersion,
    };
    const reader = async (id: string) => assets[id];
    const room = { ...lib.DEFAULT_ROOM, widthMm: 2400, depthMm: 2400, heightMm: 2400 };
    const faces = lib.createRoomSurfaces(room, 1.5).map((s, i) => ({
      ...s,
      id: '00000000-0000-4000-8000-00000000000' + i,
      materialVersionId: 'tile',
    }));
    const scene = (ceiling?: Scene['ceiling']): Scene => ({
      room: structuredClone(room),
      originalAssetId: 'photo',
      previewAssetId: 'photo',
      imageWidth: 1200,
      imageHeight: 800,
      surfaces: structuredClone(faces),
      fixtures: [],
      protection: { polygon: [], strokes: [] },
      color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
      ...(ceiling ? { ceiling } : {}),
    });
    const pixels = (canvas: HTMLCanvasElement) => {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx = copy.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, copy.width, copy.height);
    };
    const images: Record<string, string> = {};
    const on = { kind: 'smc', light: true } as const,
      off = { kind: 'smc', light: false } as const;

    // 3D: each scene through one engine, the same views.
    const engine = new lib.RoomViewerRenderer();
    document.body.append(engine.canvas);
    const shots = async (name: string, ceiling: Scene['ceiling'] | undefined) => {
      await engine.setSnapshot({ scene: scene(ceiling), beforeScene: scene(), materials }, reader);
      const out: { image: ImageData; mask: ReturnType<typeof engine.regionMask> }[] = [];
      let view = lib.defaultRoomView();
      for (let turn = 0; turn < 4; turn++) {
        engine.render(1200, 800, view, 'after');
        images[`3d-${name}-${turn}`] = engine.canvas.toDataURL();
        out.push({ image: pixels(engine.canvas), mask: engine.regionMask(1200, 800, view) });
        view = lib.rotateRoomView(view, 'right');
      }
      return out;
    };
    const none = await shots('none', undefined);
    const lit = await shots('on', on);
    const dark = await shots('off', off);
    const report: Record<string, number> = {};
    const ratios: number[] = [];
    for (let turn = 0; turn < 4; turn++) {
      const mask = lit[turn].mask;
      const size = mask.width * mask.height;
      // The ceiling is what is unlabelled inside the room.
      let ceilingPixels = 0,
        whites = 0,
        differ = 0,
        faceCount = 0,
        withLight = 0,
        withoutLight = 0,
        darkWhites = 0,
        ceilingKept = 0,
        ceilingR = 0,
        ceilingB = 0;
      for (let y = 0; y < mask.height; y++)
        for (let x = 0; x < mask.width; x++) {
          const m = y * mask.width + x;
          // The mask's rows run from the image's top, as the frame's.
          const o = m * 4;
          const a = lit[turn].image.data,
            b = none[turn].image.data,
            c = dark[turn].image.data;
          if (mask.data[m] === 0 && !mask.outside?.[m]) {
            ceilingPixels++;
            if (a[o] > 250 && a[o + 1] > 250 && a[o + 2] > 250) whites++;
            else {
              ceilingKept++;
              ceilingR += a[o];
              ceilingB += a[o + 2];
            }
            if (c[o] > 250 && c[o + 1] > 250 && c[o + 2] > 250) darkWhites++;
          } else if (mask.data[m] > 0 && mask.data[m] < 255) {
            faceCount++;
            if (Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]) > 3)
              differ++;
            withLight += (a[o] + a[o + 1] + a[o + 2]) / 3;
            withoutLight += (c[o] + c[o + 1] + c[o + 2]) / 3;
          }
        }
      check(ceilingPixels >= size * 0.01, `3D 방향 ${turn}: 천장이 프레임의 1% 넘게 보임 (${ceilingPixels})`);
      check(lib.visibleCeiling(mask), `3D 방향 ${turn}: AI 문장 조건도 천장을 본다`);
      check(whites > 100, `3D 방향 ${turn}: 조명 켬이면 패널이 보임 (${whites})`);
      check(darkWhites === 0, `3D 방향 ${turn}: 조명 끔이면 패널이 없음`);
      check(ceilingR / ceilingKept > ceilingB / ceilingKept, `3D 방향 ${turn}: 천장은 그림의 회백색`);
      // The picture's fill keeps the near edge visible against the viewer's #e8e8e4 backdrop.
      check(
        ceilingR / ceilingKept < 222,
        `3D 방향 ${turn}: 천장이 배경보다 어두워 경계가 보임 (${ceilingR / ceilingKept})`,
      );
      check(
        differ < faceCount * 0.005,
        `3D 방향 ${turn}: 천장 밖 벽·바닥 픽셀은 천장 없을 때와 같음 (${differ})`,
      );
      check(withoutLight < withLight * 0.9, `3D 방향 ${turn}: 조명 끔이면 방이 어두워짐`);
      ratios.push(withoutLight / withLight);
    }
    // Encoded values to linear for the level the 2D composite multiplies by.
    const linear = (value: number) => ((value + 0.055) / 1.055) ** 2.4;
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    report.encodedRatio = mean;
    report.linearRatio = linear(mean * 0.6) / linear(0.6);

    // A camera above the ceiling (the AI's top view) still sees the room.
    await engine.setSnapshot({ scene: scene(on), beforeScene: scene(), materials }, reader);
    const above = lib.fluxOrbitView({ azimuth: 0, elevation: 90 });
    engine.render(1200, 800, above, 'after');
    images['3d-on-above'] = engine.canvas.toDataURL();
    const aboveMask = engine.regionMask(1200, 800, above);
    check(!lib.visibleCeiling(aboveMask), '위에서 보는 AI 시점: 천장이 방을 가리지 않음');
    const frontFlux = lib.fluxOrbitView(lib.FLUX_FRONT);
    engine.render(1200, 800, frontFlux, 'after');
    images['3d-on-ai-front'] = engine.canvas.toDataURL();
    engine.dispose();

    // 2D: only its own quad changes; the panel is white; off multiplies the whole room.
    const compositor = new lib.PhotoCompositor();
    document.body.append(compositor.canvas);
    const flat = async (name: string, ceiling: Scene['ceiling'] | undefined) => {
      await compositor.setSnapshot({ scene: scene(ceiling), materials }, reader);
      compositor.render(1200, 800, 'after');
      images[`2d-${name}`] = compositor.canvas.toDataURL();
      return pixels(compositor.canvas);
    };
    const flatNone = await flat('none', undefined);
    const flatOn = await flat('on', on);
    const flatOff = await flat('off', off);
    compositor.dispose();
    const quad = lib.ceilingQuad(room, 1.5);
    check(
      quad.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1),
      '2D: 천장 네 모서리가 프레임 안',
    );
    const read = (image: ImageData, x: number, y: number) => {
      const o = (Math.round(y * (image.height - 1)) * image.width + Math.round(x * (image.width - 1))) * 4;
      return [image.data[o], image.data[o + 1], image.data[o + 2]];
    };
    // A point of the ceiling by its u, v: the far corners and the near corners mixed in perspective.
    const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    });
    const lampCentre = lerp(lerp(quad[0], quad[1], 0.5), lerp(quad[3], quad[2], 0.5), 0.5);
    // Beside the panel, in the ceiling: a quarter of the way across the mid line.
    const beside = lerp(lerp(quad[0], quad[3], 0.5), lerp(quad[1], quad[2], 0.5), 0.15);
    const noneAt = read(flatNone, beside.x, beside.y),
      onAt = read(flatOn, beside.x, beside.y);
    check(onAt[2] < noneAt[2] - 3, `2D: 천장 자리의 색이 바뀜 (${noneAt} → ${onAt})`);
    const lampAt = read(flatOn, lampCentre.x, lampCentre.y);
    check(
      lampAt.every((v) => v > 250),
      `2D: 조명 켬이면 패널이 흼 (${lampAt})`,
    );
    const offLamp = read(flatOff, lampCentre.x, lampCentre.y);
    check(
      offLamp.some((v) => v < 240),
      `2D: 조명 끔이면 패널이 없음 (${offLamp})`,
    );
    // Everything well outside the quad's box is untouched while the light is on.
    const top = Math.max(...quad.map((p) => p.y));
    let changed = 0,
      counted = 0;
    for (let y = Math.ceil((top + 0.01) * 800); y < 800; y += 3)
      for (let x = 0; x < 1200; x += 3) {
        const o = (y * 1200 + x) * 4;
        counted++;
        if (flatOn.data[o] !== flatNone.data[o] || flatOn.data[o + 2] !== flatNone.data[o + 2]) changed++;
      }
    check(counted > 1000 && changed === 0, `2D: 조명 켬이면 천장 아래 픽셀은 그대로 (${changed}/${counted})`);
    const wall = [0.5, (top + 1) / 2] as const;
    const wallOn = read(flatOn, ...wall),
      wallOff = read(flatOff, ...wall);
    check(wallOff[0] < wallOn[0], `2D: 조명 끔이면 벽이 어두워짐 (${wallOn} → ${wallOff})`);
    report.level2d = linear(wallOff[0] / 255) / linear(wallOn[0] / 255);
    return { checks, images, report };
  });
  if (errors.length) throw new Error(errors.join('\n'));
  // Read once per page, by the 3D room and the 2D composite together.
  if (pictureReads !== 1) throw new Error('천장 그림 요청 ' + pictureReads + '번');
  for (const [name, url] of Object.entries(result.images))
    await writeFile(`${output}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
  await writeFile(`${output}/report.json`, JSON.stringify({ ...result, images: undefined }, null, 2));
  console.log(JSON.stringify({ checks: result.checks.length, report: result.report }, null, 2));
} finally {
  await browser.close();
}
