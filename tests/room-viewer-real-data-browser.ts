/** Re-render preserved real-photo user-confirmed fixtures and a single flat product photo. No new AI. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { RoomDefinition } from '../src/lib/room-types';
import type { FixtureInstance, AssetRecord, MaterialVersion, Scene } from '../src/lib/types';

const output = process.env.SJN_VIEWER_REAL_OUTPUT || 'test-results/room-viewer-20260914/real-data-run02';
await mkdir(output, { recursive: true });
const reportsRoot = 'test-results/reconstruction-placement-quality-20260914/e2e-run-01';
const cases: {
  id: string;
  room: RoomDefinition;
  fixtures: FixtureInstance[];
  sourcePath: string;
  sourceHash: string;
}[] = [];
for (const directory of await readdir(reportsRoot)) {
  const sourcePath = reportsRoot + '/' + directory + '/corrected-report.json';
  const bytes = await readFile(sourcePath).catch(() => undefined);
  if (!bytes) continue;
  const verification = JSON.parse(
    await readFile(reportsRoot + '/' + directory + '/verification.json', 'utf8'),
  );
  const report = JSON.parse(bytes.toString('utf8'));
  cases.push({
    id: verification.caseId,
    room: report.room,
    fixtures: report.fixtures,
    sourcePath,
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
  });
}
assert.equal(cases.length, 4);
cases.sort((a, b) => a.id.localeCompare(b.id));
const photoRoot = 'test-results/front-alignment-toilet/photograph';
const photoFiles = await Promise.all(
  ['front.png'].map(async (name) => ({
    name,
    data: (await readFile(photoRoot + '/' + name)).toString('base64'),
    hash: createHash('sha256')
      .update(await readFile(photoRoot + '/' + name))
      .digest('hex'),
  })),
);
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {createRoomSurfaces} from './src/lib/room-geometry';export {productContentBounds} from './src/lib/room-fixtures';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'RealRoom',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors: string[] = [],
  external: string[] = [];
let workers = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('worker', () => workers++);
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:43217/'))
      return route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"></body></html>' });
    if (url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.goto('http://127.0.0.1:43217/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const runs = [];
  for (const item of cases) {
    const result = await page.evaluate(
      async ({ item, photoFiles }) => {
        const api = (
          window as unknown as {
            RealRoom: typeof import('../src/lib/room-viewer/renderer') &
              typeof import('../src/lib/room-viewer/view-state') &
              typeof import('../src/lib/room-geometry') &
              typeof import('../src/lib/room-fixtures');
          }
        ).RealRoom;
        const check = (condition: unknown, message: string) => {
          if (!condition) throw new Error(message);
        };
        const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
        const assets: Record<string, AssetRecord> = {},
          materials: Record<string, MaterialVersion> = {};
        const empty = () => ({ polygon: [], strokes: [] });
        const material = (id: string): MaterialVersion => ({
          id,
          materialId: id,
          version: 1,
          name: id,
          brand: '',
          code: '',
          category: 'tile',
          scope: 'personal',
          description: 'Authored renderer test texture',
          color: '#eeeeee',
          finish: '',
          widthMm: 300,
          heightMm: 600,
          depthMm: 10,
          usage: 'both',
          installation: 'wall',
          textureAssetIds: [],
          views: [],
          defaultGroutWidth: 3,
          defaultGroutColor: '#777777',
          defaultPattern: 'brick',
          createdAt: '2026-09-14',
        });
        for (const [id, hex] of [
          ['gray', '#6b6c69'],
          ['light', '#ece5d5'],
        ]) {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 128;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = hex;
          ctx.fillRect(0, 0, 128, 128);
          ctx.fillStyle = id === 'gray' ? '#747571' : '#d9d2c1';
          ctx.fillRect(4, 4, 22, 4);
          const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
          assets[id] = {
            id,
            name: id,
            ownerId: 'local',
            mime: 'image/png',
            size: blob.size,
            kind: 'texture',
            width: 128,
            height: 128,
            blob,
            createdAt: '2026-09-14',
          };
          materials[id] = { ...material(id), textureAssetIds: [id] };
        }
        for (const fixture of item.fixtures)
          materials[fixture.materialVersionId] = {
            ...material(fixture.materialVersionId),
            name: fixture.name,
            category: 'toilet',
            reconstruction: { version: 2, kind: fixture.reconstruction!.kind },
            widthMm: fixture.reconstruction!.widthMm,
            heightMm: fixture.reconstruction!.heightMm,
            depthMm: fixture.reconstruction!.depthMm,
          };
        const sourceFixtureText = JSON.stringify(item.fixtures);
        const before: Scene = {
          room: item.room,
          originalAssetId: 'photo-reference',
          previewAssetId: 'photo-preview',
          imageWidth: 1800,
          imageHeight: 1200,
          surfaces: api.createRoomSurfaces(item.room).map((s) => ({
            ...s,
            materialVersionId: 'gray',
            tile: { ...s.tile, seed: 19, groutWidth: 3, pattern: 'brick' },
          })),
          fixtures: structuredClone(item.fixtures),
          protection: empty(),
          color,
        };
        const after: Scene = structuredClone(before);
        after.surfaces.forEach((s) => (s.materialVersionId = 'light'));
        // New After configuration is a test action, not additional photo inference.
        after.fixtures = after.fixtures.filter((f) =>
          ['basin', 'toilet', 'vanity', 'window', 'mirror'].includes(f.reconstruction!.kind),
        );
        const decode = (name: string) =>
          Uint8Array.from(atob(photoFiles.find((f) => f.name === name)!.data), (c) => c.charCodeAt(0));
        const photoBlob = new Blob([decode('front.png')], { type: 'image/png' });
        const bitmap = await createImageBitmap(photoBlob);
        const imageWidth = bitmap.width,
          imageHeight = bitmap.height;
        bitmap.close();
        assets['product-photo'] = {
          id: 'product-photo',
          name: 'Saved product render',
          ownerId: 'local',
          kind: 'product',
          mime: 'image/png',
          size: photoBlob.size,
          blob: photoBlob,
          width: imageWidth,
          height: imageHeight,
          createdAt: '2026-09-14',
        };
        const baseToilet = structuredClone(item.fixtures.find((f) => f.reconstruction?.kind === 'toilet')!);
        let productMetadata: unknown;
        if (item.id === 'user-01') {
          const flatBounds = await api.productContentBounds(assets['product-photo']);
          const flatAnchor = { x: (flatBounds.left + flatBounds.right) / 2, y: flatBounds.bottom };
          productMetadata = {
            flatBounds,
            flatAnchor,
            flatAspect: imageWidth / imageHeight,
            physicalEnvelope: { widthMm: 400, heightMm: 750 },
            scope: 'The historical front.png as a single flat product photo. No new inference.',
          };
          const flat = {
            ...baseToilet,
            id: 'flat-photo-fixture',
            name: 'Single photo test',
            materialVersionId: 'flat-photo',
            reconstruction: undefined,
            roomPlacement: {
              ...baseToilet.roomPlacement!,
              u: 0.4,
              v: 0.82,
              widthMm: 400,
              heightMm: 750,
              scale: 1,
              contentBounds: flatBounds,
              imageAspect: imageWidth / imageHeight,
            },
            rotation: 0,
            anchor: flatAnchor,
            color: { ...color },
            occlusion: empty(),
          };
          materials['flat-photo'] = {
            ...material('flat-photo'),
            category: 'toilet',
            installation: 'floor',
            widthMm: 400,
            heightMm: 750,
            depthMm: 680,
            views: [{ assetId: 'product-photo', direction: '정면', anchor: flatAnchor }],
          };
          after.fixtures.splice(1, 0, flat);
        }
        const initial = JSON.stringify({ before, after, materials });
        let reads = 0;
        const reader = async (id: string) => {
          reads++;
          const asset = assets[id];
          if (!asset) throw new Error('missing ' + id);
          return asset;
        };
        const renderer = new api.RoomViewerRenderer();
        document.body.appendChild(renderer.canvas);
        const started = performance.now();
        await renderer.setSnapshot({ scene: after, beforeScene: before, materials }, reader);
        const prepareMs = performance.now() - started;
        const pictures: Record<string, string> = {};
        const views: { name: string; view: ReturnType<typeof api.defaultRoomView> }[] = [];
        let view = api.defaultRoomView();
        for (let i = 0; i < 4; i++) {
          views.push({ name: ['front', 'right', 'back', 'left'][i], view });
          view = api.rotateRoomView(view, 'right');
        }
        views.push(
          { name: 'top', view: api.rotateRoomView(api.defaultRoomView(), 'up') },
          { name: 'bottom', view: api.rotateRoomView(api.defaultRoomView(), 'down') },
        );
        const renderMs: number[] = [];
        for (const entry of views) {
          const t = performance.now();
          renderer.render(1200, 400, entry.view, 'compare');
          pictures[entry.name] = renderer.canvas.toDataURL('image/png').split(',')[1];
          renderMs.push(performance.now() - t);
        }
        renderer.render(900, 600, api.defaultRoomView(), 'before');
        const first = renderer.canvas.toDataURL();
        let cycle = api.defaultRoomView();
        for (let i = 0; i < 4; i++) cycle = api.rotateRoomView(cycle, 'up');
        renderer.render(900, 600, cycle, 'before');
        check(first === renderer.canvas.toDataURL(), 'four up turns must restore exact pixels');
        const loaded = renderer.diagnostics(),
          readsAfterPrepare = reads;
        const turnTimes = [];
        for (let i = 0; i < 50; i++) {
          const t = performance.now();
          view = api.rotateRoomView(view, i % 2 ? 'right' : 'up');
          renderer.render(900, 600, view, 'split');
          turnTimes.push(performance.now() - t);
        }
        check(reads === readsAfterPrepare, 'rotation downloaded/decoded assets again');
        check(renderer.diagnostics().preparations === loaded.preparations, 'rotation rebuilt scene');
        check(JSON.stringify({ before, after, materials }) === initial, 'render modified source data');
        check(JSON.stringify(item.fixtures) === sourceFixtureText, 'saved fixtures mutated');
        const notices = [...renderer.notices];
        check(
          !notices.some((n) => n.severity === 'error'),
          'unexpected fixture error: ' + JSON.stringify(notices),
        );
        if (item.id === 'user-01') {
          check(
            notices.some((n) => n.id === 'flat-photo-fixture'),
            'single PNG restriction missing',
          );
        }
        const top = api.rotateRoomView(api.defaultRoomView(), 'up');
        renderer.render(900, 600, top, 'split');
        const blob = await renderer.export(top, { format: 'png', mode: 'compare', longEdge: 4096 });
        const png = await createImageBitmap(blob);
        check(png.width === 1800 && png.height === 600, 'source/output limits or comparison aspect wrong');
        png.close();
        const toBase64 = (b: Blob) =>
          new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve((r.result as string).split(',')[1]);
            r.onerror = () => reject(r.error);
            r.readAsDataURL(b);
          });
        pictures.export = await toBase64(blob);
        const final = renderer.diagnostics();
        renderer.dispose();
        renderer.canvas.remove();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const disposed = renderer.diagnostics();
        check(
          disposed.contexts === 0 && disposed.preparedScenes === 0 && disposed.productCache.assets === 0,
          'owned caches not disposed',
        );
        return {
          id: item.id,
          fixtureCount: { before: before.fixtures.length, after: after.fixtures.length },
          prepareMs,
          renderMs,
          turnTimes,
          reads,
          notices,
          diagnostics: final,
          disposed,
          pictures,
          unchanged: true,
          productMetadata,
        };
      },
      { item, photoFiles },
    );
    for (const [name, bytes] of Object.entries(result.pictures))
      await writeFile(`${output}/${item.id}-${name}.png`, Buffer.from(bytes, 'base64'));
    const { pictures, ...summary } = result;
    void pictures;
    runs.push(summary);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(workers, 0);
  for (const item of cases)
    assert.equal(
      createHash('sha256')
        .update(await readFile(item.sourcePath))
        .digest('hex'),
      item.sourceHash,
    );
  await writeFile(
    output + '/verification.json',
    JSON.stringify(
      {
        scope:
          'Real existing photo-confirmed fixtures reused without alteration. Authored test tile treatments and After changes; one flat product photo placed. No new AI/geometry inference and no source photo accuracy claim.',
        browser: browser.version(),
        inputs: cases.map(({ fixtures, ...rest }) => ({ ...rest, count: fixtures.length })),
        photoInputs: photoFiles.map(({ name, hash }) => ({ name, hash })),
        errors,
        external,
        workers,
        runs,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      runs.map((r) => ({
        id: r.id,
        fixtureCount: r.fixtureCount,
        prepareMs: r.prepareMs,
        reads: r.reads,
        notices: r.notices.length,
      })),
    ),
  );
} finally {
  await browser.close();
}
