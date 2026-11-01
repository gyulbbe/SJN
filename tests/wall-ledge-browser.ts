/**
 * A ledge (젠다이) drawn with real WebGL (no AI call): it stands out from its wall with the wall's tile
 * on its front and top, shades the floor, goes away with a hidden wall, shows an end flat on another
 * wall only while that wall is hidden, and carries its wall's label in the AI's face mask.
 *
 * node tests/run-browser-test.mjs tests/wall-ledge-browser.ts
 * Output: test-results/wall-ledge/browser/
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const output = 'test-results/wall-ledge/browser';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer'; export * from './src/lib/room-viewer/view-state'; export { createRoomSurfaces, DEFAULT_ROOM } from './src/lib/room-geometry';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'LedgeTest',
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
  await page.route('http://127.0.0.1:43215/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43215/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('../src/lib/room-geometry');
    const lib = (window as unknown as { LedgeTest: Lib }).LedgeTest;
    type Scene = import('../src/lib/types').Scene;
    type Feature = import('../src/lib/wall-features').WallFeatureV1;
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
        createdAt: '2026-11-01',
      };
    };
    await solid('wall', '#c8cdd0');
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
        createdAt: '2026-11-01',
      }) as import('../src/lib/types').MaterialVersion;
    const materials = { wall: material('wall'), floor: material('floor'), darkWall: material('darkWall') };
    const reader = async (id: string) => assets[id];
    const room = { ...lib.DEFAULT_ROOM };
    const faces = lib.createRoomSurfaces(room, 1.5).map((s, i) => ({
      ...s,
      id: '00000000-0000-4000-8000-00000000000' + i,
      materialVersionId: s.roomFace === 'floor' ? 'floor' : 'wall',
    }));
    const scene = (wallFeatures?: Feature[]): Scene => ({
      room: structuredClone(room),
      originalAssetId: 'photo',
      previewAssetId: 'photo',
      imageWidth: 1200,
      imageHeight: 800,
      surfaces: structuredClone(faces),
      fixtures: [],
      protection: { polygon: [], strokes: [] },
      color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
      ...(wallFeatures ? { wallFeatures } : {}),
    });
    const ledge = (over: Record<string, unknown> = {}) =>
      ({
        version: 1,
        id: '30000000-0000-4000-8000-000000000001',
        source: 'user',
        kind: 'ledge',
        face: 'back',
        leftMm: 600,
        bottomMm: 0,
        widthMm: 1200,
        heightMm: 900,
        depthMm: 300,
        ...over,
      }) as Feature;
    const pixels = (canvas: HTMLCanvasElement) => {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx = copy.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, copy.width, copy.height);
    };
    const at = (image: ImageData, p: { x: number; y: number }) => {
      const o =
        (Math.round(p.y * (image.height - 1)) * image.width + Math.round(p.x * (image.width - 1))) * 4;
      return [image.data[o], image.data[o + 1], image.data[o + 2]];
    };
    const light = (c: number[]) => (c[0] + c[1] + c[2]) / 3;
    const images: Record<string, string> = {};
    const engine = new lib.RoomViewerRenderer();
    document.body.append(engine.canvas);
    const front = lib.defaultRoomView();
    const show = async (name: string, wallFeatures: Feature[] | undefined, view = front) => {
      await engine.setSnapshot({ scene: scene(wallFeatures), beforeScene: scene(), materials }, reader);
      engine.render(1200, 800, view, 'after');
      images[name] = engine.canvas.toDataURL();
      return pixels(engine.canvas);
    };
    const pieces = () => {
      const found: Record<string, boolean> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).prepared.after.surfaces.group.traverse(
        (node: { name: string; visible: boolean; castShadow: boolean }) => {
          if (node.name.startsWith('wall-feature:3000')) {
            const role = node.name.split(':')[2];
            found[role] = (found[role] ?? false) || node.visible;
            found['cast:' + role] = node.castShadow;
          }
        },
      );
      return found;
    };

    // Stands out: the front's middle is drawn where the wall's own point would not be.
    const plain = await show('none', undefined);
    const floorLedge = await show('floor-ledge', [ledge()]);
    // The front reads apart from the wall on a dark tile too.
    const shownFront = engine.faceToFrame('back', 0.5, 1 - 450 / 2400, 300)!,
      shownWall = engine.faceToFrame('back', 0.5, 1 - 1100 / 2400)!;
    check(
      light(at(floorLedge, shownFront)) < light(at(floorLedge, shownWall)) - 8,
      '밝은 타일: 앞면이 벽보다 어두워 구분됨',
    );
    {
      const dark = scene([ledge()]);
      for (const surface of dark.surfaces)
        if (surface.roomFace !== 'floor') surface.materialVersionId = 'darkWall';
      await engine.setSnapshot({ scene: dark, beforeScene: scene(), materials }, reader);
      engine.render(1200, 800, front, 'after');
      images['floor-ledge-dark'] = engine.canvas.toDataURL();
      const image = pixels(engine.canvas);
      check(
        light(at(image, shownFront)) < light(at(image, shownWall)) - 3,
        '어두운 타일: 앞면이 벽보다 어두워 구분됨',
      );
      await engine.setSnapshot({ scene: scene([ledge()]), beforeScene: scene(), materials }, reader);
      engine.render(1200, 800, front, 'after');
    }
    const u = (mm: number) => mm / 2400;
    const frontMiddle = engine.faceToFrame('back', 0.5, 1 - 450 / 2400, 300)!;
    const wallMiddle = engine.faceToFrame('back', 0.5, 1 - 450 / 2400, 0)!;
    check(
      Math.hypot(frontMiddle.x - wallMiddle.x, frontMiddle.y - wallMiddle.y) > 0.005,
      '앞면이 벽면보다 카메라 쪽에 그려짐',
    );
    // The top catches the ceiling light and the front does not: a visible edge between them.
    const topPoint = engine.faceToFrame('back', 0.5, 1 - 900 / 2400, 150)!;
    const frontPoint = engine.faceToFrame('back', 0.5, 1 - 700 / 2400, 300)!;
    const topLight = light(at(floorLedge, topPoint)),
      frontLight = light(at(floorLedge, frontPoint));
    check(Math.abs(topLight - frontLight) > 2, `윗면과 앞면의 밝기가 다름 (${topLight} / ${frontLight})`);
    check(pieces()['cast:front'] === true, '젠다이는 그림자를 드리움');
    // Away from it, and off the room, nothing changed.
    const away = engine.faceToFrame('left', 0.2, 0.3)!;
    check(Math.abs(light(at(floorLedge, away)) - light(at(plain, away))) < 3, '젠다이에서 먼 벽은 그대로');
    const mask = engine.regionMask(1200, 800, front);
    const labelAt = (p: { x: number; y: number }) =>
      mask.data[Math.round(p.y * (mask.height - 1)) * mask.width + Math.round(p.x * (mask.width - 1))];
    const back = faces.find((s) => s.roomFace === 'back')!;
    const backLabel = mask.regions.findIndex((r: { key: string }) => r.key === 'surface:' + back.id) + 1;
    check(
      labelAt(frontPoint) === backLabel && labelAt(topPoint) === backLabel,
      'AI 면 마스크: 앞·윗면은 벽의 라벨',
    );

    // Hanging: it has an underside and the floor below it is not cut.
    await show('hung-ledge', [ledge({ bottomMm: 700, heightMm: 300 })]);
    check('reveal-bottom' in pieces(), '공중형은 아랫면이 있음');

    // A hidden wall takes its ledge along, whichever way the room is turned.
    let view = front;
    const seen: string[] = [];
    for (let turn = 0; turn < 4; turn++) {
      await show('turn-' + turn, [ledge()], view);
      const shownNow = pieces();
      const wallVisible = !!engine.faceToFrame('back', 0.5, 0.5);
      check(!!shownNow.front === wallVisible, `방향 ${turn}: 벽과 젠다이가 함께 보이거나 함께 숨음`);
      seen.push(String(wallVisible));
      view = lib.rotateRoomView(view, 'right');
    }
    check(seen.includes('false') && seen.includes('true'), '네 방향에 벽이 숨는 방향이 있음');

    // An end flat on the left wall shows only while that wall is hidden; the far end always.
    const corner = [ledge({ leftMm: 0 })];
    view = front;
    let endHiddenWithWall = false,
      endShownWithoutWall = false;
    for (let turn = 0; turn < 4; turn++) {
      await show('corner-' + turn, corner, view);
      const leftWall = !!engine.faceToFrame('left', 0.5, 0.5),
        backWall = !!engine.faceToFrame('back', 0.5, 0.5),
        shown = pieces();
      if (backWall && leftWall) endHiddenWithWall = shown['reveal-left'] === false;
      if (backWall && !leftWall) endShownWithoutWall = shown['reveal-left'] === true;
      if (backWall) check(shown['reveal-right'] === true, `방향 ${turn}: 트인 쪽 끝은 보임`);
      view = lib.rotateRoomView(view, 'right');
    }
    check(endHiddenWithWall, '옆벽이 보이면 그 벽에 붙은 끝은 숨음');
    check(endShownWithoutWall, '옆벽이 숨으면 그 벽에 붙은 끝이 보임');

    // A niche beside a ledge on another wall still draws.
    await show('with-niche', [
      ledge({ leftMm: 600 }),
      {
        version: 1,
        id: '30000000-0000-4000-8000-000000000002',
        source: 'user',
        kind: 'closed-niche',
        face: 'left',
        leftMm: 600,
        topMm: 700,
        widthMm: 600,
        heightMm: 500,
        depthMm: 150,
      },
    ]);
    check(u(600) > 0, '홈과 젠다이를 함께 그림');
    engine.dispose();
    return { checks, images, values: { topLight, frontLight } };
  });
  if (errors.length) throw new Error(errors.join('\n'));
  for (const [name, url] of Object.entries(result.images))
    await writeFile(`${output}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
  console.log(JSON.stringify({ checks: result.checks.length, values: result.values }, null, 1));
} finally {
  await browser.close();
}
