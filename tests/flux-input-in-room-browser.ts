/**
 * Real-WebGL check of the AI input from inside the room (no AI call). A default room like the
 * 2026-09-27 user example (grey terrazzo walls, light grey floor, wall basin and shower on the left
 * wall, toilet at the back right) is captured as the old 2D front composite and from the in-room
 * eye presets. For each capture it checks that the fixture boxes, the face mask and the image share
 * one framing, times the 3D renderer from a cold start, and writes the model input, scene, prompts
 * and mask for the real comparison (the comparison's bare-walls variant added one sentence to the
 * prompt; it was not adopted) to test-results/flux-input-in-room/payload/. It also renders two
 * photo cameras (source-photo) to judge whether that view shows the open top or an empty margin.
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-input-in-room-browser.ts [--gpu]
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const gpu = process.argv.includes('--gpu');
const output = 'test-results/flux-input-in-room/payload';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {VIEWER_CEILING_COLOR} from './src/lib/room-viewer/ceiling';export {PhotoCompositor} from './src/lib/render/compositor';export {renderRoomBackground} from './src/lib/room-background';export {createRoomSurfaces,DEFAULT_ROOM} from './src/lib/room-geometry';export {projectReconstructionFixture} from './src/lib/reconstruction/projection';export {buildFluxGrounding,visibleCeiling,visibleWalls} from './src/lib/ai-export/scene';export {fluxInputLayout} from './src/lib/ai-export/contract';export {prepareFluxImage} from './src/lib/ai-export/client';export {buildFluxPrompt} from './src/lib/ai-export/prompt';export {fluxSceneSchema} from './src/lib/ai-export/scene-contract';export {presetFluxView} from './tests/helpers/flux-room-scene';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'InRoom',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await page.route('http://127.0.0.1:43219/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43219/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const run = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('../src/lib/room-viewer/ceiling') &
      typeof import('../src/lib/render/compositor') &
      typeof import('../src/lib/room-background') &
      typeof import('../src/lib/room-geometry') &
      typeof import('../src/lib/reconstruction/projection') &
      typeof import('../src/lib/ai-export/scene') &
      typeof import('../src/lib/ai-export/contract') &
      typeof import('../src/lib/ai-export/client') &
      typeof import('../src/lib/ai-export/prompt') &
      typeof import('../src/lib/ai-export/scene-contract') &
      typeof import('../src/lib/ai-export/view') &
      Pick<typeof import('./helpers/flux-room-scene'), 'presetFluxView'>;
    type AssetRecord = import('../src/lib/types').AssetRecord;
    type MaterialVersion = import('../src/lib/types').MaterialVersion;
    type FixtureInstance = import('../src/lib/types').FixtureInstance;
    type Scene = import('../src/lib/types').Scene;
    type RegionMask = import('../src/lib/ai-export/color').RegionMask;
    const lib = (window as unknown as { InRoom: Lib }).InRoom;
    const gl = document.createElement('canvas').getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const gpuName = gl && debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    const room = structuredClone(lib.DEFAULT_ROOM);
    const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    const empty = () => ({ polygon: [], strokes: [] });
    const assets: Record<string, AssetRecord> = {};
    const blobOf = (canvas: HTMLCanvasElement) =>
      new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    const addAsset = async (id: string, canvas: HTMLCanvasElement, kind: 'texture' | 'original') => {
      const blob = await blobOf(canvas);
      assets[id] = {
        id,
        ownerId: 'test',
        name: id,
        mime: 'image/png',
        size: blob.size,
        width: canvas.width,
        height: canvas.height,
        kind,
        blob,
        createdAt: '2026-09-27',
      };
    };
    // Seeded speckles: grey terrazzo like the user example's walls (render mean near #8a8981).
    let seed = 20260927;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const terrazzo = document.createElement('canvas');
    terrazzo.width = terrazzo.height = 256;
    const t = terrazzo.getContext('2d')!;
    t.fillStyle = '#76756d';
    t.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) {
      t.fillStyle = random() < 0.7 ? '#dcd9cf' : '#b9b6ab';
      t.beginPath();
      t.ellipse(random() * 256, random() * 256, 1 + random() * 3, 0.8 + random() * 2, random() * 3, 0, 7);
      t.fill();
    }
    await addAsset('terrazzo', terrazzo, 'texture');
    const floor = document.createElement('canvas');
    floor.width = floor.height = 64;
    const f = floor.getContext('2d')!;
    f.fillStyle = '#bdbdb9';
    f.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 300; i++) {
      f.fillStyle = random() < 0.5 ? '#c4c4c0' : '#b6b6b2';
      f.fillRect(random() * 64, random() * 64, 2, 2);
    }
    await addAsset('floor', floor, 'texture');
    const imageWidth = 4096,
      imageHeight = 2731,
      aspect = imageWidth / imageHeight;
    const background = await lib.renderRoomBackground(room, { width: imageWidth, height: imageHeight });
    const bgBitmap = await createImageBitmap(background.blob);
    const bg = document.createElement('canvas');
    bg.width = bgBitmap.width;
    bg.height = bgBitmap.height;
    bg.getContext('2d')!.drawImage(bgBitmap, 0, 0);
    await addAsset('bg', bg, 'original');
    const tile = (id: string, patch: Partial<MaterialVersion>): MaterialVersion => ({
      id,
      materialId: id,
      version: 1,
      name: id,
      brand: '',
      code: '',
      category: 'tile',
      scope: 'personal',
      description: '',
      color: '',
      finish: '무광',
      widthMm: 600,
      heightMm: 600,
      depthMm: 10,
      usage: 'both',
      installation: 'wall',
      textureAssetIds: [id],
      views: [],
      defaultGroutWidth: 2,
      defaultGroutColor: '#9a9890',
      defaultPattern: 'grid',
      createdAt: '2026-09-27',
      ...patch,
    });
    const materials: Record<string, MaterialVersion> = {
      terrazzo: tile('terrazzo', {}),
      floor: tile('floor', { installation: 'floor' }),
      standard: tile('standard', { category: 'toilet', textureAssetIds: [] }),
    };
    const fixture = (
      id: string,
      face: 'floor' | 'left',
      u: number,
      v: number,
      reconstruction: NonNullable<FixtureInstance['reconstruction']>,
    ): FixtureInstance => ({
      id,
      name: id,
      materialVersionId: 'standard',
      viewIndex: 0,
      position: { x: 0.5, y: 0.5 },
      width: 0.1,
      height: 0.1,
      rotation: 0,
      anchor: { x: 0.5, y: 1 },
      locked: false,
      shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
      occlusion: empty(),
      color: { ...color },
      roomPlacement: {
        face,
        u,
        v,
        scale: 1,
        widthMm: reconstruction.widthMm,
        heightMm: reconstruction.heightMm,
        imageAspect: reconstruction.widthMm / reconstruction.heightMm,
        contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
      },
      reconstruction,
    });
    const fixtures = [
      fixture('toilet', 'floor', 0.78, 0.28, {
        version: 2,
        kind: 'toilet',
        color: '#f2f1ec',
        widthMm: 400,
        heightMm: 750,
        depthMm: 680,
        baseHeightMm: 0,
        yawDegrees: 0,
      }),
      fixture('basin', 'left', 0.35, 0.62, {
        version: 2,
        kind: 'basin',
        color: '#f2f1ec',
        widthMm: 520,
        heightMm: 380,
        depthMm: 420,
        baseHeightMm: 780,
        yawDegrees: 0,
        basinVariant: 'wall',
      }),
      fixture('shower', 'left', 0.8, 0.3, {
        version: 2,
        kind: 'shower',
        color: '#c8ccd0',
        widthMm: 200,
        heightMm: 1100,
        depthMm: 120,
        baseHeightMm: 900,
        yawDegrees: 0,
        showerVariant: 'handheld-rail',
      }),
    ];
    for (const item of fixtures) lib.projectReconstructionFixture(room, item, aspect);
    const makeScene = (): Scene => ({
      room: structuredClone(room),
      originalAssetId: 'bg',
      previewAssetId: 'bg',
      imageWidth,
      imageHeight,
      surfaces: lib.createRoomSurfaces(room, aspect).map((s) => ({
        ...s,
        materialVersionId: s.roomFace === 'floor' ? 'floor' : 'terrazzo',
        tile: {
          ...s.tile,
          groutWidth: 1.5,
          groutColor: s.roomFace === 'floor' ? '#a9a9a4' : '#9a9890',
          pattern: 'grid',
          seed: 7,
        },
      })),
      fixtures: structuredClone(fixtures),
      protection: empty(),
      color: { ...color },
    });
    const snapshot = { scene: makeScene(), beforeScene: makeScene(), materials };
    const reader = async (id: string) => assets[id];
    const dataUrl = (blob: Blob) =>
      new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
    /** Mask labels as a picture: faces in greys, fixtures red, unchecked black. */
    const maskPicture = (mask: RegionMask) => {
      const canvas = document.createElement('canvas');
      canvas.width = mask.width;
      canvas.height = mask.height;
      const ctx = canvas.getContext('2d')!;
      const image = ctx.createImageData(mask.width, mask.height);
      mask.data.forEach((label, i) => {
        const o = i * 4;
        if (label === 255) image.data.set([220, 40, 60, 255], o);
        else if (label === 0) image.data.set([0, 0, 0, 255], o);
        else {
          const v = 60 + ((label * 47) % 180);
          image.data.set([v, v, v, 255], o);
        }
      });
      ctx.putImageData(image, 0, 0);
      return canvas.toDataURL('image/png');
    };
    /**
     * The boxes and the mask agree: each box holds fixture pixels, and nearly every fixture pixel
     * falls in some box (the mask is drawn at the capture's framing).
     */
    const agreement = (mask: RegionMask, boxes: Record<string, [number, number, number, number]>) => {
      let fixturePixels = 0,
        covered = 0;
      const inside: Record<string, number> = {};
      for (let y = 0; y < mask.height; y++)
        for (let x = 0; x < mask.width; x++) {
          if (mask.data[y * mask.width + x] !== 255) continue;
          fixturePixels++;
          const u = (x + 0.5) / mask.width,
            v = (y + 0.5) / mask.height;
          let hit = false;
          for (const [id, [l, tp, r, b]] of Object.entries(boxes))
            if (u >= l - 0.004 && u <= r + 0.004 && v >= tp - 0.004 && v <= b + 0.004) {
              inside[id] = (inside[id] ?? 0) + 1;
              hit = true;
            }
          if (hit) covered++;
        }
      const shares = Object.fromEntries(
        Object.entries(boxes).map(([id, [l, tp, r, b]]) => [
          id,
          +((inside[id] ?? 0) / Math.max(1, (r - l) * (b - tp) * mask.width * mask.height)).toFixed(3),
        ]),
      );
      return { coveredShare: fixturePixels ? covered / fixturePixels : 1, fillShares: shares };
    };
    const unchecked = (mask: RegionMask) =>
      mask.data.filter((label) => label === 0).length / mask.data.length;
    async function payload(
      label: string,
      blob: Blob,
      mask: RegionMask,
      boxes?: Record<string, [number, number, number, number]>,
      ceiling?: string,
    ) {
      const capture = await createImageBitmap(blob);
      const layout = lib.fluxInputLayout(capture.width, capture.height);
      const grounding = await lib.buildFluxGrounding({ snapshot, reader, capture, layout, boxes, ceiling });
      const size = [capture.width, capture.height];
      capture.close();
      const input = await lib.prepareFluxImage(blob);
      const inputBitmap = await createImageBitmap(input);
      const overlay = document.createElement('canvas');
      overlay.width = inputBitmap.width;
      overlay.height = inputBitmap.height;
      const ctx = overlay.getContext('2d')!;
      ctx.drawImage(inputBitmap, 0, 0);
      ctx.lineWidth = 2;
      ctx.font = '12px sans-serif';
      for (const item of grounding.scene.fixtures) {
        const [l, tp, r, b] = item.box;
        ctx.strokeStyle = '#e0245e';
        ctx.strokeRect(
          l * overlay.width,
          tp * overlay.height,
          (r - l) * overlay.width,
          (b - tp) * overlay.height,
        );
        ctx.fillStyle = '#e0245e';
        ctx.fillText(item.kind, l * overlay.width, tp * overlay.height - 3);
      }
      const inputSize = [inputBitmap.width, inputBitmap.height];
      inputBitmap.close();
      return {
        label,
        captureSize: size,
        inputSize,
        layout,
        scene: grounding.scene,
        valid: lib.fluxSceneSchema.safeParse(grounding.scene).success,
        placed: grounding.placed,
        walls: lib.visibleWalls(mask, snapshot.scene),
        prompt: lib.buildFluxPrompt(grounding.scene),
        uncheckedShare: +unchecked(mask).toFixed(3),
        ...(boxes ? { agreement: agreement(mask, boxes) } : {}),
        capture: await dataUrl(blob),
        input: await dataUrl(input),
        overlay: overlay.toDataURL('image/png'),
        mask: maskPicture(mask),
        maskData: {
          width: mask.width,
          height: mask.height,
          regions: mask.regions,
          data: Array.from(mask.data),
        },
      };
    }
    const out = [];
    const timings: Record<string, number>[] = [];
    // The old input: the 2D front composite over the default room background (grey margin).
    {
      const compositor = new lib.PhotoCompositor();
      try {
        await compositor.setSnapshot(snapshot, reader as never);
        let mask: RegionMask | undefined;
        const blob = await compositor.exportImage(
          snapshot,
          1024,
          1024,
          'image/png',
          false,
          (m) => (mask = m),
        );
        out.push(await payload('front-2d', blob, mask!));
      } finally {
        compositor.dispose();
      }
    }
    // The new input: a fresh renderer per capture, as the editor does, timed from a cold start.
    const edge = Math.min(1024, Math.max(imageWidth, imageHeight));
    for (const preset of ['center', 'left-corner', 'right-corner'] as const) {
      const view = lib.presetFluxView(room, preset);
      const started = performance.now();
      const viewer = new lib.RoomViewerRenderer();
      const created = performance.now();
      try {
        await viewer.setSnapshot(snapshot, reader);
        const prepared = performance.now();
        const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
        const exported = performance.now();
        const boxes = viewer.fixtureBounds(imageWidth, imageHeight, view);
        const mask = viewer.regionMask(
          Math.min(edge, (edge * imageWidth) / imageHeight),
          Math.min(edge, (edge * imageHeight) / imageWidth),
          view,
        );
        const done = performance.now();
        timings.push({
          [preset]: 1,
          createMs: Math.round(created - started),
          prepareMs: Math.round(prepared - created),
          exportMs: Math.round(exported - prepared),
          boxesMaskMs: Math.round(done - exported),
          totalMs: Math.round(done - started),
        });
        out.push(
          await payload(
            `eye-${preset}`,
            blob,
            mask,
            boxes,
            lib.visibleCeiling(mask) ? lib.VIEWER_CEILING_COLOR : undefined,
          ),
        );
      } finally {
        viewer.dispose();
      }
    }
    // Photo cameras: a photographer inside the front of the room, and one in the doorway.
    const photo = [];
    for (const [name, z] of [
      ['source-inside', room.depthMm - 300],
      ['source-doorway', room.depthMm + 250],
    ] as const) {
      // A level-ish phone photo (5° down) with the scene's own aspect, as a comparison photo has.
      const pitch = (-5 * Math.PI) / 180;
      const camera = {
        version: 1 as const,
        positionMm: [0, 1500, z] as [number, number, number],
        quaternion: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] as [number, number, number, number],
        verticalFovDegrees: 50,
        image: { width: imageWidth, height: imageHeight },
      };
      const view = lib.sourceRoomView(camera, room);
      const viewer = new lib.RoomViewerRenderer();
      try {
        await viewer.setSnapshot(snapshot, reader);
        const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        // The viewer's world background (#e8e8e4), where no room surface is drawn.
        let open = 0,
          openTop = 0;
        const topRows = Math.round(canvas.height * 0.2);
        for (let y = 0; y < canvas.height; y++)
          for (let x = 0; x < canvas.width; x++) {
            const o = (y * canvas.width + x) * 4;
            if (Math.abs(data[o] - 0xe8) + Math.abs(data[o + 1] - 0xe8) + Math.abs(data[o + 2] - 0xe4) > 6)
              continue;
            open++;
            if (y < topRows) openTop++;
          }
        photo.push({
          name,
          openShare: +(open / (canvas.width * canvas.height)).toFixed(3),
          openTopShare: +(openTop / (canvas.width * topRows)).toFixed(3),
          image: await dataUrl(blob),
        });
      } finally {
        viewer.dispose();
      }
    }
    return { gpuName, timings, out, photo };
  });
  assert.deepEqual(errors, [], errors.join('\n'));
  const png = (url: string) => Buffer.from(url.split(',')[1], 'base64');
  const summary = [];
  for (const r of run.out) {
    for (const key of ['capture', 'input', 'overlay', 'mask'] as const)
      await writeFile(`${output}/${r.label}-${key}.png`, png(r[key]));
    await writeFile(`${output}/${r.label}-prompt.txt`, r.prompt);
    await writeFile(
      `${output}/${r.label}-scene.json`,
      JSON.stringify({ scene: r.scene, layout: r.layout }, null, 2),
    );
    await writeFile(`${output}/${r.label}-mask.json`, JSON.stringify(r.maskData));
    assert.equal(r.valid, true, `${r.label}: the scene failed the server schema`);
    if (r.label === 'front-2d')
      assert.deepEqual(
        r.scene.fixtures.map((f) => f.kind).sort(),
        ['basin', 'shower', 'toilet'],
        'front-2d fixtures',
      );
    const eye = r.label.startsWith('eye-');
    // An in-room view names its ceiling; the front composite keeps the earlier prompt.
    assert.equal(!!r.scene.ceiling, eye, `${r.label} ceiling`);
    assert.equal(r.prompt.includes('The ceiling is plain'), eye, `${r.label} ceiling sentence`);
    if (eye) {
      // Boxes and mask come from the same camera as the image.
      assert.ok(r.agreement!.coveredShare > 0.97, `${r.label}: fixture pixels outside every box`);
      for (const [id, share] of Object.entries(r.agreement!.fillShares))
        assert.ok(share > 0.05, `${r.label}: box of ${id} holds almost no fixture pixels (${share})`);
      // The room fills the frame: only the ceiling (unchecked) is outside the faces and fixtures,
      // and every preset shows it with the AI lens.
      assert.ok(
        r.uncheckedShare > 0.01 && r.uncheckedShare < 0.2,
        `${r.label}: ceiling share ${r.uncheckedShare}`,
      );
      // Each preset shows the three placed fixtures of this room.
      assert.deepEqual(
        r.scene.fixtures.map((f) => f.kind).sort(),
        ['basin', 'shower', 'toilet'],
        `${r.label} fixtures`,
      );
    }
    summary.push({
      label: r.label,
      captureSize: r.captureSize,
      inputSize: r.inputSize,
      walls: r.walls,
      uncheckedShare: r.uncheckedShare,
      agreement: r.agreement,
      fixtures: r.scene.fixtures.map((f) => ({
        kind: f.kind,
        face: f.face,
        box: f.box.map((v) => +v.toFixed(3)),
      })),
      surfaces: r.scene.surfaces.map((s) => ({ faces: s.faces, color: s.color })),
      ceiling: r.scene.ceiling,
      placed: r.placed,
      promptLength: r.prompt.length,
    });
  }
  for (const p of run.photo) await writeFile(`${output}/${p.name}-capture.png`, png(p.image));
  const photo = run.photo.map(({ name, openShare, openTopShare }) => ({ name, openShare, openTopShare }));
  await writeFile(
    `${output}/summary${gpu ? '-gpu' : ''}.json`,
    JSON.stringify({ gpu, gpuName: run.gpuName, timings: run.timings, photo, summary }, null, 2),
  );
  console.log(JSON.stringify({ gpu, gpuName: run.gpuName, timings: run.timings, photo, summary }, null, 2));
} finally {
  await browser.close();
}
