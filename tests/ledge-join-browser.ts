/**
 * Ledges that touch (or stand within LEDGE_JOIN_GAP_MM of each other) drawn as one with real WebGL, no AI
 * call (docs/wall-ledge-join-results-20261111.md): no line at the joint in the editor frame, the photo
 * download and the AI capture; a taller neighbour's side showing above a lower one; the corner of an
 * L-shaped pair; the faces that come back when one of the two walls is hidden; and scenes without
 * joined ledges drawn exactly as before.
 *
 * node tests/run-browser-test.mjs tests/ledge-join-browser.ts [--label before|after] [--render-only] [--gpu]
 * Output: <main checkout>/test-results/ledge-join/<label>/ (`before` also keeps the unchanged scenes'
 * pictures, which a later run compares byte for byte).
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './direction-photo-methods/paths.mjs';

const option = (name: string) => {
  const at = process.argv.indexOf('--' + name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const label = option('label') ?? 'after';
const renderOnly = process.argv.includes('--render-only');
const gpu = process.argv.includes('--gpu');
const base = join(ROOT as string, 'test-results', 'ledge-join');
const output = join(base, label);
mkdirSync(output, { recursive: true });
const baselineFile = join(base, 'before', 'unchanged.json');
const baseline: Record<string, string> | undefined =
  label !== 'before' && existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : undefined;

const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer'; export * from './src/lib/room-viewer/view-state'; export { PHOTO_EFFECTS } from './src/lib/room-viewer/photo-effects'; export { FLUX_FRONT, fluxOrbitView } from './src/lib/ai-export/view'; export { createRoomSurfaces, DEFAULT_ROOM } from './src/lib/room-geometry';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'LedgeJoin',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await page.route('http://127.0.0.1:43216/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43216/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(
    async ({ renderOnly, baseline }) => {
      type Lib = typeof import('../src/lib/room-viewer/renderer') &
        typeof import('../src/lib/room-viewer/view-state') &
        typeof import('../src/lib/room-viewer/photo-effects') &
        typeof import('../src/lib/ai-export/view') &
        typeof import('../src/lib/room-geometry');
      const lib = (window as unknown as { LedgeJoin: Lib }).LedgeJoin;
      type Scene = import('../src/lib/types').Scene;
      type Feature = import('../src/lib/wall-features').WallFeatureV1;
      type Point = { x: number; y: number };
      const checks: string[] = [];
      const failures: string[] = [];
      const values: Record<string, number | string> = {};
      const check = (condition: unknown, message: string) => {
        if (condition) checks.push(message);
        else failures.push(message);
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
          createdAt: '2026-11-11',
        };
      };
      await solid('wall', '#d9dcd8');
      await solid('floor', '#8b8f91');
      await solid('darkWall', '#3a4145');
      await solid('photo', '#888888', 1200, 800);
      const material = (id: string) =>
        ({
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
          defaultGroutWidth: 2,
          defaultGroutColor: '#ffffff',
          defaultPattern: 'grid',
          createdAt: '2026-11-11',
        }) as import('../src/lib/types').MaterialVersion;
      const materials = { wall: material('wall'), floor: material('floor'), darkWall: material('darkWall') };
      const reader = async (id: string) => assets[id];
      const room = { ...lib.DEFAULT_ROOM };
      const faces = lib.createRoomSurfaces(room, 1.5).map((s, i) => ({
        ...s,
        id: '00000000-0000-4000-8000-00000000000' + i,
        materialVersionId: s.roomFace === 'floor' ? 'floor' : 'wall',
      }));
      /** `grout` 0 leaves the faces plain, so a line at a joint is the joint's own. */
      const scene = (wallFeatures: Feature[] | undefined, grout: number, wall = 'wall'): Scene => ({
        room: structuredClone(room),
        originalAssetId: 'photo',
        previewAssetId: 'photo',
        imageWidth: 1200,
        imageHeight: 800,
        surfaces: structuredClone(faces).map((surface) => ({
          ...surface,
          materialVersionId: surface.roomFace === 'floor' ? 'floor' : wall,
          tile: { ...surface.tile, groutWidth: grout, groutColor: '#f4f4f2' },
        })),
        fixtures: [],
        protection: { polygon: [], strokes: [] },
        color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
        ...(wallFeatures ? { wallFeatures } : {}),
      });
      const A = '31000000-0000-4000-8000-000000000001',
        B = '31000000-0000-4000-8000-000000000002';
      const ledge = (id: string, over: Record<string, unknown>) =>
        ({
          version: 1,
          id,
          source: 'user',
          kind: 'ledge',
          face: 'back',
          leftMm: 300,
          bottomMm: 0,
          widthMm: 800,
          heightMm: 900,
          depthMm: 200,
          ...over,
        }) as Feature;
      /** The trial's shapes, the second ledge `gap` millimetres away from the first. */
      const shapes = (gap: number): Record<string, Feature[]> => ({
        side: [ledge(A, {}), ledge(B, { leftMm: 1100 + gap, widthMm: 700 })],
        stair: [ledge(A, { widthMm: 700 }), ledge(B, { leftMm: 1000 + gap, widthMm: 800, heightMm: 600 })],
        corner: [
          ledge(A, { leftMm: 0, widthMm: 1200, heightMm: 1000, depthMm: 100 }),
          // The left wall's u runs from the room's front to the back wall.
          ledge(B, {
            face: 'left',
            leftMm: room.depthMm - 100 - gap - 1000,
            widthMm: 1000,
            heightMm: 1000,
            depthMm: 100,
          }),
        ],
        stack: [
          ledge(A, { widthMm: 1000, heightMm: 600 }),
          ledge(B, { widthMm: 1000, bottomMm: 600 + gap, heightMm: 300, depthMm: 120 }),
        ],
      });
      const pixels = (canvas: HTMLCanvasElement) => {
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d')!;
        ctx.drawImage(canvas, 0, 0);
        return ctx.getImageData(0, 0, copy.width, copy.height);
      };
      const decode = async (blob: Blob) => {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
        bitmap.close();
        return { image: pixels(canvas), url: canvas.toDataURL() };
      };
      const lightAt = (image: ImageData, x: number, y: number) => {
        const o = (Math.round(y) * image.width + Math.round(x)) * 4;
        return (image.data[o] + image.data[o + 1] + image.data[o + 2]) / 3;
      };
      /**
       * The largest step between neighbouring pixels along the line from `a` to `b` (frame 0–1), leaving
       * `skip` of its length at each end: a line across a face that should be one shows as a step.
       */
      const step = (image: ImageData, a: Point, b: Point, skip = 0.1) => {
        const ax = a.x * (image.width - 1),
          ay = a.y * (image.height - 1),
          bx = b.x * (image.width - 1),
          by = b.y * (image.height - 1);
        const count = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay)));
        let worst = 0,
          previous: number | undefined;
        for (let i = Math.round(count * skip); i <= Math.round(count * (1 - skip)); i++) {
          const t = i / count;
          const value = lightAt(image, ax + (bx - ax) * t, ay + (by - ay) * t);
          if (previous !== undefined) worst = Math.max(worst, Math.abs(value - previous));
          previous = value;
        }
        return worst;
      };
      const images: Record<string, string> = {};
      const engine = new lib.RoomViewerRenderer();
      document.body.append(engine.canvas);
      const front = lib.defaultRoomView();
      const orbit = lib.fluxOrbitView(lib.FLUX_FRONT);
      const prepare = (value: Scene) =>
        engine.setSnapshot({ scene: value, beforeScene: scene(undefined, 0), materials }, reader);
      /** The three pictures of a scene: the editor frame, the photo download and the AI capture. */
      const shoot = async (name: string, value: Scene, only?: 'editor') => {
        await prepare(value);
        engine.render(1200, 800, front, 'after');
        images[name + '-editor'] = engine.canvas.toDataURL();
        const editor = pixels(engine.canvas);
        if (only) return { editor, download: editor, capture: editor };
        const download = await decode(
          await engine.export(front, {
            format: 'png',
            mode: 'after',
            longEdge: 1600,
            quality: { samples: 32, budgetMs: 60_000 },
            effects: lib.PHOTO_EFFECTS,
          }),
        );
        images[name + '-download'] = download.url;
        const capture = await decode(
          await engine.export(orbit, { format: 'png', mode: 'after', longEdge: 1024 }),
        );
        images[name + '-capture'] = capture.url;
        return { editor, download: download.image, capture: capture.image };
      };
      /** Where a wall point (millimetres along it, above the floor, out from it) is in a view's frame. */
      const spot = (view: typeof front, face: 'back' | 'left', uMm: number, yMm: number, outMm = 0) => {
        engine.render(1200, 800, view, 'after');
        const span = face === 'back' ? room.widthMm : room.depthMm;
        const point = engine.faceToFrame(face, uMm / span, 1 - yMm / room.heightMm, outMm);
        if (!point) throw new Error(`${face} ${uMm},${yMm} is not in the frame`);
        return point;
      };
      const meshes = () => {
        const found: { name: string; visible: boolean; min: number[]; max: number[] }[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (engine as any).prepared.after.surfaces.group.traverse((node: any) => {
          if (!node.name?.startsWith('wall-feature:31')) return;
          node.geometry.computeBoundingBox();
          const box = node.geometry.boundingBox;
          found.push({
            name: node.name,
            visible: node.visible,
            min: box.min.toArray(),
            max: box.max.toArray(),
          });
        });
        return found;
      };

      // Pictures with grout, as a person sees them: the gap of the old rule, and the faces touching.
      for (const [gap, tag] of [
        [1, 'gap1'],
        [0, 'touch'],
      ] as const)
        for (const [name, features] of Object.entries(shapes(gap))) {
          try {
            await shoot(`${name}-${tag}`, scene(features, 2));
          } catch (error) {
            // Touching ledges are refused before the change: the `before` run has no such picture.
            values[`${name}-${tag}`] = 'refused: ' + (error instanceof Error ? error.message : String(error));
          }
        }
      await shoot('corner-gap1-dark', scene(shapes(1).corner, 2, 'darkWall'));

      // Scenes the change must not touch: no ledge, one ledge, two ledges well apart.
      const unchanged: Record<string, string> = {};
      for (const [name, features] of Object.entries({
        none: undefined,
        one: [ledge(A, {})],
        apart: [ledge(A, {}), ledge(B, { leftMm: 1100 + 6, widthMm: 700 })],
      })) {
        await shoot('unchanged-' + name, scene(features, 2), 'editor');
        unchanged[name] = images[`unchanged-${name}-editor`];
        if (baseline)
          check(baseline[name] === unchanged[name], `그대로인 장면 ${name}: 고치기 전과 픽셀이 같음`);
      }
      if (renderOnly) return { checks, failures, images, values, unchanged };

      // No line at a joint: plain faces (no grout), measured across the joint in all three pictures.
      const LINE = 3;
      for (const [gap, tag] of [
        [0, '맞닿음'],
        [1, '1mm 틈'],
        [5, '5mm 틈'],
      ] as const) {
        const side = await shoot(`measure-side-${gap}`, scene(shapes(gap).side, 0));
        for (const [kind, image, view] of [
          ['편집 화면', side.editor, front],
          ['다운로드', side.download, front],
          ['AI 캡처', side.capture, orbit],
        ] as const) {
          const faceStep = step(image, spot(view, 'back', 900, 450, 200), spot(view, 'back', 1300, 450, 200));
          const topStep = step(image, spot(view, 'back', 900, 900, 100), spot(view, 'back', 1300, 900, 100));
          values[`side ${tag} ${kind} 앞면`] = +faceStep.toFixed(2);
          values[`side ${tag} ${kind} 윗면`] = +topStep.toFixed(2);
          check(
            faceStep <= LINE,
            `옆으로 이은 두 개(${tag}) ${kind}: 앞면 이음매에 선이 없음 (${faceStep.toFixed(1)})`,
          );
          check(
            topStep <= LINE,
            `옆으로 이은 두 개(${tag}) ${kind}: 윗면 이음매에 선이 없음 (${topStep.toFixed(1)})`,
          );
        }
      }
      {
        // The floor just before the joint: the two contact shades must not add up.
        await prepare(scene(shapes(0).side, 0));
        engine.render(1200, 800, front, 'after');
        const image = pixels(engine.canvas);
        const floor = (xMm: number) => {
          const p = engine.faceToFrame('floor', xMm / room.widthMm, 230 / room.depthMm)!;
          return lightAt(image, p.x * (image.width - 1), p.y * (image.height - 1));
        };
        const joint = floor(1100),
          beside = (floor(800) + floor(1400)) / 2;
        values['바닥 접촉 음영: 이음매 / 옆'] = `${joint.toFixed(1)} / ${beside.toFixed(1)}`;
        check(Math.abs(joint - beside) <= LINE, '옆으로 이은 두 개: 이음매 앞 바닥 음영이 옆과 같음');
      }
      {
        // A stair: the taller one's side shows only above the lower one.
        await prepare(scene(shapes(0).stair, 0));
        engine.render(1200, 800, front, 'after');
        const sides = meshes().filter((m) => m.name.endsWith(':reveal-right') && m.name.includes(A));
        const low = sides.filter((m) => m.min[1] < 599),
          high = sides.filter((m) => m.min[1] >= 599 && m.max[1] > 899);
        check(
          high.length > 0 && high.every((m) => m.visible),
          '계단: 높은 쪽 옆면 가운데 위로 나온 부분이 보임',
        );
        check(low.length === 0, '계단: 낮은 쪽에 가려진 옆면은 그리지 않음');
        const hidden = meshes().filter((m) => m.name.endsWith(':reveal-left') && m.name.includes(B));
        check(hidden.length === 0, '계단: 낮은 쪽의 맞닿은 끝면은 그리지 않음');
      }
      {
        // Stacked: the lower one's top shows only before the shallower upper one.
        await prepare(scene(shapes(0).stack, 0));
        engine.render(1200, 800, front, 'after');
        const tops = meshes().filter((m) => m.name.endsWith(':reveal-top') && m.name.includes(A));
        check(
          tops.length > 0 && tops.every((m) => m.min[2] >= 119),
          '위아래: 아래 젠다이 윗면은 위 젠다이 앞으로 나온 부분만 그림',
        );
        const under = meshes().filter((m) => m.name.endsWith(':reveal-bottom') && m.name.includes(B));
        check(under.length === 0, '위아래: 위 젠다이의 맞닿은 아랫면은 그리지 않음');
      }
      {
        // The corner: one joint line on top, and the covered faces come back with a hidden wall.
        const corner = await shoot('measure-corner', scene(shapes(0).corner, 0));
        const along = step(
          corner.editor,
          spot(front, 'back', 300, 1000, 50),
          spot(front, 'back', 1000, 1000, 50),
        );
        values['ㄱ자 뒷벽 쪽 윗면'] = +along.toFixed(2);
        check(along <= LINE, 'ㄱ자: 뒷벽 쪽 윗면이 벽 끝까지 한 면으로 이어짐');
        let view = front;
        const seen: string[] = [];
        for (let turn = 0; turn < 4; turn++) {
          await prepare(scene(shapes(0).corner, 0));
          engine.render(1200, 800, view, 'after');
          images['corner-turn-' + turn] = engine.canvas.toDataURL();
          const back = !!engine.faceToFrame('back', 0.5, 0.5),
            left = !!engine.faceToFrame('left', 0.5, 0.5);
          const all = meshes();
          // The back ledge's front under the side ledge's end, and that end itself.
          const covered = all.filter(
            (m) => m.name.includes(A) && m.name.endsWith(':front') && m.max[0] <= -room.widthMm / 2 + 101,
          );
          const end = all.filter((m) => m.name.includes(B) && m.name.endsWith(':reveal-right'));
          seen.push(`${back ? '뒤' : ''}${left ? '왼' : ''}`);
          check(covered.length > 0 && end.length > 0, `ㄱ자 방향 ${turn}: 맞닿은 면이 따로 조각으로 있음`);
          if (back && left)
            check(
              covered.every((m) => !m.visible) && end.every((m) => !m.visible),
              `ㄱ자 방향 ${turn}: 두 벽이 다 보이면 맞닿은 면은 숨음`,
            );
          if (back && !left)
            check(
              covered.every((m) => m.visible),
              `ㄱ자 방향 ${turn}: 왼벽이 숨으면 뒷벽 젠다이의 가려졌던 앞면이 보임`,
            );
          if (!back && left)
            check(
              end.every((m) => m.visible),
              `ㄱ자 방향 ${turn}: 뒷벽이 숨으면 왼벽 젠다이의 끝면이 보임`,
            );
          view = lib.rotateRoomView(view, 'right');
        }
        values['ㄱ자 네 방향에 보인 벽'] = seen.join(' / ');
        check(seen.includes('뒤') && seen.includes('왼'), 'ㄱ자: 한쪽 벽만 보이는 방향이 둘 다 있음');
      }
      engine.dispose();
      return { checks, failures, images, values, unchanged };
    },
    { renderOnly, baseline },
  );
  for (const [name, url] of Object.entries(result.images))
    writeFileSync(join(output, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
  if (label === 'before') writeFileSync(baselineFile, JSON.stringify(result.unchanged));
  console.log(
    JSON.stringify(
      { label, checks: result.checks.length, failures: result.failures, values: result.values, errors },
      null,
      1,
    ),
  );
  if (errors.length || result.failures.length) process.exitCode = 1;
} finally {
  await browser.close();
}
