/**
 * Regions drawn with real WebGL (no AI call): the 3D room renderer and the 2D compositor show the
 * region's tile inside it and the base outside, the face mask labels it on its own, its boundaries
 * show the base's one grout joint, every wall's u runs left to right on screen in the four views,
 * its image box matches its outline, and the AI colour check corrects it apart from its wall.
 *
 * node tests/run-browser-test.mjs tests/tile-regions-browser.ts
 * Output: test-results/tile-regions/browser/
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const output = 'test-results/tile-regions/browser';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer'; export * from './src/lib/room-viewer/view-state'; export { createRoomSurfaces, DEFAULT_ROOM, roomFaceSizeMm } from './src/lib/room-geometry'; export { applyRoomSurfaceRegion, snapRegion, regionUv } from './src/lib/room-surface-regions'; export { PhotoCompositor } from './src/lib/render/compositor'; export { reviewResultColors, projectCapture, projectMask } from './src/lib/ai-export/color'; export { fluxInputLayout } from './src/lib/ai-export/contract';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'RegionTest',
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
  await page.route('http://127.0.0.1:43212/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43212/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('../src/lib/room-geometry') &
      typeof import('../src/lib/room-surface-regions') &
      typeof import('../src/lib/render/compositor') &
      typeof import('../src/lib/ai-export/color') &
      typeof import('../src/lib/ai-export/contract');
    const lib = (window as unknown as { RegionTest: Lib }).RegionTest;
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
        createdAt: '2026-10-22',
      };
    };
    await solid('base', '#d8cfbf');
    await solid('accent', '#1d3557');
    await solid('shower', '#2f8f4f');
    await solid('photo', '#8a8a8a', 1200, 800);
    const material = (id: string): import('../src/lib/types').MaterialVersion => ({
      id,
      materialId: id,
      version: 1,
      name: id,
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
      textureAssetIds: [id],
      views: [],
      defaultGroutWidth: 10,
      defaultGroutColor: '#ffffff',
      defaultPattern: 'grid',
      createdAt: '2026-10-22',
    });
    const materials = { base: material('base'), accent: material('accent'), shower: material('shower') };
    const reader = async (id: string) => assets[id];
    const room = { ...lib.DEFAULT_ROOM, widthMm: 3000, depthMm: 2400, heightMm: 2400 };
    const faces = lib.createRoomSurfaces(room, 1.5).map((s, i) => ({
      ...s,
      id: '00000000-0000-4000-8000-00000000000' + i,
      materialVersionId: 'base',
      tile: { ...s.tile, shading: 0, groutWidth: 20, groutColor: '#e01010', offsetX: 0, offsetY: 0 },
    }));
    const back = faces.find((s) => s.roomFace === 'back')!;
    const floor = faces.find((s) => s.roomFace === 'floor')!;
    // Q3: the region's edges on the base's joints (300 mm tiles, 20 mm grout: period 320 mm).
    const accentRegion = lib.snapRegion(
      { leftMm: 760, topMm: 640, widthMm: 1480, heightMm: 1250 },
      lib.roomFaceSizeMm(room, 'back'),
      { tile: back.tile, tileMm: { width: 300, height: 300 } },
    );
    const accent = lib.applyRoomSurfaceRegion(
      {
        ...structuredClone(back),
        id: '20000000-0000-4000-8000-000000000001',
        name: '정면 벽 · 부분 타일 1',
        materialVersionId: 'accent',
        tile: { ...back.tile, groutColor: '#10d0e0' },
      },
      accentRegion,
    );
    const shower = lib.applyRoomSurfaceRegion(
      {
        ...structuredClone(floor),
        id: '20000000-0000-4000-8000-000000000002',
        name: '바닥 · 부분 타일 1',
        materialVersionId: 'shower',
        tile: { ...floor.tile, groutColor: '#10d0e0' },
      },
      { leftMm: 0, topMm: 0, widthMm: 1200, heightMm: 900 },
    );
    const scene = (): Scene => ({
      room: structuredClone(room),
      originalAssetId: 'photo',
      previewAssetId: 'photo',
      imageWidth: 1200,
      imageHeight: 800,
      surfaces: [structuredClone(accent), ...structuredClone(faces), structuredClone(shower)],
      fixtures: [],
      protection: { polygon: [], strokes: [] },
      color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
    });
    const pixels = (canvas: HTMLCanvasElement) => {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx = copy.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, copy.width, copy.height);
    };
    const at = (image: ImageData, x: number, y: number) => {
      const o = (Math.round(y * (image.height - 1)) * image.width + Math.round(x * (image.width - 1))) * 4;
      return [image.data[o], image.data[o + 1], image.data[o + 2]];
    };
    const kind = ([r, g, b]: number[]) =>
      r > 150 && g < 90 && b < 90
        ? 'base-grout'
        : g > 140 && b > 150 && r < 120
          ? 'region-grout'
          : b > r + 30 && b > g && r < 90
            ? 'accent'
            : g > r + 30 && g > b
              ? 'shower'
              : r > 150 && g > 140 && b > 120
                ? 'base'
                : 'other';
    /** The most common kind in a 7×7 pixel patch, so a grout line under the point does not decide it. */
    const around = (image: ImageData, x: number, y: number) => {
      const counts = new Map<string, number>();
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const k = kind(at(image, x + dx / (image.width - 1), y + dy / (image.height - 1)));
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      return [...counts].sort((a, b) => b[1] - a[1])[0][0];
    };
    const expectKind = (image: ImageData, p: { x: number; y: number }, expected: string, message: string) =>
      check(
        around(image, p.x, p.y) === expected,
        `${message} (${around(image, p.x, p.y)} ${at(image, p.x, p.y)})`,
      );
    const images: Record<string, string> = {};

    // 3D renderer: front view.
    const engine = new lib.RoomViewerRenderer();
    document.body.append(engine.canvas);
    await engine.setSnapshot({ scene: scene(), beforeScene: scene(), materials }, reader);
    const front = lib.defaultRoomView();
    engine.render(1200, 800, front, 'after');
    images['3d-front'] = engine.canvas.toDataURL();
    let image = pixels(engine.canvas);
    const size = lib.roomFaceSizeMm(room, 'back');
    const uv = lib.regionUv(accentRegion, size);
    // Points in the middle of a tile (150 mm past a joint), never on a grout line.
    const tileV = (accentRegion.topMm + 150) / size.height;
    const centre = engine.faceToFrame('back', (accentRegion.leftMm + 150) / size.width, tileV)!;
    const beside = engine.faceToFrame('back', 150 / size.width, tileV)!;
    expectKind(image, { x: centre.x, y: centre.y }, 'accent', '3D: 영역 안은 영역 타일');
    expectKind(image, { x: beside.x, y: beside.y }, 'base', '3D: 영역 밖 같은 벽은 바탕 타일');
    const showerUv = lib.regionUv(shower.region!, lib.roomFaceSizeMm(room, 'floor'));
    const showerAt = engine.faceToFrame('floor', 150 / 3000, (showerUv.bottom * 2400 - 150) / 2400)!;
    expectKind(image, { x: showerAt.x, y: showerAt.y }, 'shower', '3D: 바닥 영역은 바닥 영역 타일');

    // The face mask labels the region on its own; its box matches its outline.
    const mask = engine.regionMask(1200, 800, front);
    const label = (p: { x: number; y: number }) => {
      const index =
        mask.data[Math.round(p.y * (mask.height - 1)) * mask.width + Math.round(p.x * (mask.width - 1))];
      return index > 0 && index < 255 ? mask.regions[index - 1].key : String(index);
    };
    check(label(centre) === 'surface:' + accent.id, '3D 면 마스크: 영역은 자기 라벨');
    check(label(beside) === 'surface:' + back.id, '3D 면 마스크: 영역 밖은 벽 라벨');
    const bounds = engine.surfaceBounds(1200, 800, front, [accent.id])[accent.id];
    const corners = [
      [uv.left, uv.top],
      [uv.right, uv.top],
      [uv.right, uv.bottom],
      [uv.left, uv.bottom],
    ].map(([u, v]) => engine.faceToFrame('back', u, v)!);
    const outline = [
      Math.min(...corners.map((p) => p.x)),
      Math.min(...corners.map((p) => p.y)),
      Math.max(...corners.map((p) => p.x)),
      Math.max(...corners.map((p) => p.y)),
    ];
    check(
      bounds && bounds.every((value, i) => Math.abs(value - outline[i]) < 0.004),
      'AI 상자: 영역 상자가 윤곽과 같음',
    );

    // Boundaries: zoomed in, a scan across each vertical edge shows one base joint outside, the
    // region's tile face (never its grout) just inside.
    const zoomed = lib.normalizeRoomView({ ...front, zoom: 2 });
    engine.render(1600, 1200, zoomed, 'after');
    images['3d-boundary'] = engine.canvas.toDataURL();
    image = pixels(engine.canvas);
    const scan = (u: number) => {
      const p = engine.faceToFrame('back', u, (uv.top + uv.bottom) / 2 + 0.013)!;
      const row: string[] = [];
      for (let dx = -40; dx <= 40; dx++) row.push(kind(at(image, p.x + dx / (image.width - 1), p.y)));
      return row;
    };
    const run = (row: string[], from: number, step: number, value: string) => {
      let n = 0;
      for (let i = from; i >= 0 && i < row.length && row[i] === value; i += step) n++;
      return n;
    };
    const left = scan(uv.left),
      right = scan(uv.right);
    const pxPerMm =
      ((engine.faceToFrame('back', 0.5 + 100 / size.width, 0.5)!.x -
        engine.faceToFrame('back', 0.5, 0.5)!.x) *
        (image.width - 1)) /
      100;
    const jointPx = 20 * pxPerMm;
    const leftJoint = run(left, 39, -1, 'base-grout'),
      rightJoint = run(right, 41, 1, 'base-grout');
    check(
      Math.abs(leftJoint - jointPx) <= 2.5,
      `경계: 왼쪽 경계 밖은 바탕 줄눈 한 줄(${leftJoint}px, 기대 ${jointPx.toFixed(1)}px)`,
    );
    check(Math.abs(rightJoint - jointPx) <= 2.5, `경계: 오른쪽 경계 밖은 바탕 줄눈 한 줄(${rightJoint}px)`);
    check(left[41] === 'accent' && left[43] === 'accent', '경계: 왼쪽 경계 안은 영역 타일 면');
    check(
      right[39] === 'accent' && right[37] === 'accent',
      '경계: 오른쪽 경계 안은 영역 타일 면(반쪽 줄눈 없음)',
    );

    // Four views: on every wall shown, its u runs from the screen's left to its right.
    let view = front;
    const turns: Record<string, string[]> = {};
    for (const name of ['front', 'right', 'back', 'left']) {
      engine.render(1200, 800, view, 'after');
      turns[name] = [];
      for (const face of ['left', 'back', 'right'] as const) {
        const a = engine.faceToFrame(face, 0.2, 0.5),
          b = engine.faceToFrame(face, 0.8, 0.5);
        if (!a || !b) continue;
        check(a.x < b.x, `${name} 보기 ${face} 벽: 왼쪽 끝(u=0)이 화면 왼쪽`);
        turns[name].push(face);
      }
      view = lib.rotateRoomView(view, 'right');
    }
    check(
      Object.values(turns).every((walls) => walls.length >= 2),
      '네 보기 모두 벽 둘 이상을 확인',
    );

    // AI colour check: a mock result that turns only the region purple is corrected for the region.
    engine.render(1200, 800, front, 'after');
    const capture = pixels(engine.canvas);
    const layout = lib.fluxInputLayout(capture.width, capture.height);
    const resultSize = { width: layout.width * 2, height: layout.height * 2 };
    const reference = lib.projectCapture(capture, layout, resultSize);
    const resultMask = lib.projectMask(mask, layout, resultSize);
    const accentIndex = mask.regions.findIndex((r) => r.key === 'surface:' + accent.id) + 1;
    const mock = new Uint8ClampedArray(reference.data);
    for (let i = 0; i < resultMask.data.length; i++)
      if (resultMask.data[i] === accentIndex) {
        mock[i * 4] = Math.min(255, mock[i * 4] + 90);
        mock[i * 4 + 2] = Math.min(255, mock[i * 4 + 2] + 40);
      }
    const review = lib.reviewResultColors({
      capture: { width: capture.width, height: capture.height, data: capture.data },
      mask,
      layout,
      result: { ...resultSize, data: mock },
    });
    const regionChange = review.changes.find((c) => c.region === accentIndex);
    const wallIndex = mask.regions.findIndex((r) => r.key === 'surface:' + back.id) + 1;
    const wallChange = review.changes.find((c) => c.region === wallIndex);
    check(!!regionChange && regionChange.deltaE > 10, 'AI 색 검사: 바뀐 영역을 따로 잡음');
    check(!!wallChange && wallChange.deltaE < 2, 'AI 색 검사: 같은 벽의 나머지는 그대로');
    const after = review.residual?.find((c) => c.region === accentIndex);
    // The hue goes back; lightness only partly, by design (lightnessReturn).
    check(
      !!after && after.colorDeltaE < regionChange!.colorDeltaE / 3,
      'AI 색 되돌리기: 영역 색을 원래 쪽으로',
    );
    engine.dispose();

    // 2D compositor (a room without wall features): the same region over its wall.
    const compositor = new lib.PhotoCompositor();
    document.body.append(compositor.canvas);
    const flat = scene();
    await compositor.setSnapshot({ scene: flat, materials }, reader);
    compositor.render(1200, 800, 'after');
    images['2d-after'] = compositor.canvas.toDataURL();
    const flatImage = pixels(compositor.canvas);
    /** A point of a surface's mask 150 mm in from its top-left corner (the middle of its first tile). */
    const firstTile = (surface: typeof accent) => {
      const [p0, p1, , p3] = surface.mask.polygon;
      const fx = 150 / surface.region!.widthMm,
        fy = 150 / surface.region!.heightMm;
      return {
        x: p0.x + (p1.x - p0.x) * fx + (p3.x - p0.x) * fy,
        y: p0.y + (p1.y - p0.y) * fx + (p3.y - p0.y) * fy,
      };
    };
    const photo = (polygon: { x: number; y: number }[]) =>
      polygon === accent.mask.polygon ? firstTile(accent) : firstTile(shower);
    check(
      around(flatImage, photo(accent.mask.polygon).x, photo(accent.mask.polygon).y) === 'accent',
      '2D: 영역 안은 영역 타일',
    );
    const wallPoint = {
      x: back.quad[0].x + ((back.quad[1].x - back.quad[0].x) * 150) / 3000,
      y: photo(accent.mask.polygon).y,
    };
    expectKind(flatImage, { x: wallPoint.x, y: wallPoint.y }, 'base', '2D: 영역 밖 같은 벽은 바탕 타일');
    check(
      around(flatImage, photo(shower.mask.polygon).x, photo(shower.mask.polygon).y) === 'shower',
      '2D: 바닥 영역',
    );
    let flatMask: import('../src/lib/ai-export/color').RegionMask | undefined;
    await compositor.exportImage(
      { scene: flat, materials },
      1200,
      800,
      'image/png',
      false,
      (m) => (flatMask = m),
    );
    const flatLabel = (p: { x: number; y: number }) => {
      const index =
        flatMask!.data[
          Math.round(p.y * (flatMask!.height - 1)) * flatMask!.width + Math.round(p.x * (flatMask!.width - 1))
        ];
      return index > 0 && index < 255 ? flatMask!.regions[index - 1].key : String(index);
    };
    check(flatLabel(photo(accent.mask.polygon)) === 'surface:' + accent.id, '2D 면 마스크: 영역은 자기 라벨');
    check(flatLabel(wallPoint) === 'surface:' + back.id, '2D 면 마스크: 영역 밖은 벽 라벨');
    // Whatever order the surfaces are stored in, the region is drawn over its wall.
    const reordered = { ...flat, surfaces: [...flat.surfaces].reverse() };
    await compositor.setSnapshot({ scene: reordered, materials }, reader);
    compositor.render(1200, 800, 'after');
    check(
      around(pixels(compositor.canvas), photo(accent.mask.polygon).x, photo(accent.mask.polygon).y) ===
        'accent',
      '2D: 저장 순서와 관계없이 영역이 위',
    );
    compositor.dispose();
    return { checks, images, joint: { leftJoint, rightJoint, jointPx }, accentRegion };
  });
  if (errors.length) throw new Error(errors.join('\n'));
  for (const [name, url] of Object.entries(result.images))
    await writeFile(`${output}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
  const { images, ...report } = result;
  await writeFile(
    `${output}/report.json`,
    JSON.stringify({ ...report, imageCount: Object.keys(images).length }, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
