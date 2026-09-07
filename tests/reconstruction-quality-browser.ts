import { getActiveDesign } from '../src/lib/designs';
/** Private user-photo quality inspection; input is read locally, never bundled or uploaded. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const input = process.env.RECONSTRUCTION_PHOTO;
if (!input)
  throw new Error(
    'Set RECONSTRUCTION_PHOTO to a local photograph path. Photos are never bundled or uploaded.',
  );
const output = process.env.RECONSTRUCTION_OUTPUT || 'test-results/reconstruction-quality';
const entry = await build({
  stdin: {
    contents:
      "export * from './src/lib/reconstruction';export {segmentRoom} from './src/lib/segmentation';export {DEFAULT_ROOM} from './src/lib/room-geometry';export {createLocalRepositories} from './src/lib/repositories/local';export {PhotoCompositor} from './src/lib/render/compositor';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  define: { 'process.env.NEXT_PUBLIC_STORAGE_MODE': '"local"' },
});
const worker = await build({
  entryPoints: ['src/lib/segmentation/worker.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const root = resolve('public');
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://localhost'),
      p = url.pathname;
    if (p === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<html><head><link rel="icon" href="data:,"></head><body style="margin:0"><main id="images"></main></body></html>',
      );
      return;
    }
    if (p === '/index.js' || p === '/worker.ts') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end((p === '/index.js' ? entry : worker).outputFiles[0].text);
      return;
    }
    if (p === '/input.jpg') {
      res.setHeader('Content-Type', 'image/jpeg');
      res.end(await readFile(input));
      return;
    }
    const file = resolve(root, '.' + p);
    if (!file.startsWith(root + '/') && !file.startsWith(root + '\\')) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader(
      'Content-Type',
      extname(file) === '.wasm'
        ? 'application/wasm'
        : extname(file) === '.json'
          ? 'application/json'
          : 'application/octet-stream',
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!r.url().startsWith(base) && !r.url().startsWith('blob:')) external.push(r.url());
  });
  await page.goto(base);
  const result = await page.evaluate(async (base) => {
    const m = (await import(base + '/index.js')) as typeof import('../src/lib/reconstruction') &
      typeof import('../src/lib/segmentation') &
      typeof import('../src/lib/room-geometry') &
      typeof import('../src/lib/repositories/local') &
      typeof import('../src/lib/render/compositor');
    const blob = await (await fetch('/input.jpg')).blob();
    const repos = m.createLocalRepositories('private-quality');
    const started = performance.now();
    const stages: string[] = [];
    const project = await m.createReconstructionProject(
      new File([blob], 'reference.jpg', { type: 'image/jpeg' }),
      m.DEFAULT_ROOM,
      { repositories: repos, onStage: (stage) => stages.push(stage) },
    );
    const creationMs = performance.now() - started;
    const masks = await m.segmentRoom(blob, undefined, { quality: 'reconstruction' });
    const saved = await repos.projects.create(project).catch((failure: unknown) => {
      const e = failure as { issues?: unknown; message?: string };
      throw new Error(JSON.stringify({ message: e.message, issues: e.issues }));
    });
    const mats = await repos.materials.list(),
      materials = Object.fromEntries(mats.map(({ version }) => [version.id, version]));
    const engine = new m.PhotoCompositor();
    await engine.setSnapshot({ scene: ((value) => value.designs.find((item) => item.id === value.activeDesignId)!)(saved).scene, beforeScene: saved.shared.comparison!.before, materials }, (id) =>
      repos.assets.get(id),
    );
    const previews: Record<string, string> = {};
    for (const mode of ['before', 'after'] as const) {
      engine.render(1200, 800, mode);
      previews[mode] = engine.canvas.toDataURL();
    }
    const c = document.createElement('canvas');
    c.width = masks.width;
    c.height = masks.height;
    const ctx = c.getContext('2d')!,
      bitmap = await createImageBitmap(blob);
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    bitmap.close();
    const rgba = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < masks.wall.length; i++) {
      if (masks.wall[i]) {
        rgba.data[i * 4] = 30;
        rgba.data[i * 4 + 1] = 210;
        rgba.data[i * 4 + 2] = 110;
      }
      if (masks.floor[i]) {
        rgba.data[i * 4] = 210;
        rgba.data[i * 4 + 1] = 80;
        rgba.data[i * 4 + 2] = 40;
      }
    }
    ctx.putImageData(rgba, 0, 0);
    for (const o of masks.objects || []) {
      ctx.strokeStyle = o.kind === 'toilet' ? 'red' : o.kind === 'window' ? 'blue' : 'yellow';
      ctx.lineWidth = 2;
      ctx.strokeRect(
        o.bounds.left * c.width,
        o.bounds.top * c.height,
        (o.bounds.right - o.bounds.left) * c.width,
        (o.bounds.bottom - o.bounds.top) * c.height,
      );
      ctx.font = '12px sans-serif';
      ctx.fillStyle = 'black';
      ctx.fillText(o.kind, o.bounds.left * c.width, o.bounds.top * c.height + 12);
    }
    previews.masks = c.toDataURL();
    engine.dispose();
    return {
      creationMs,
      stages,
      project: saved,
      objects: masks.objects,
      wallPixels: masks.wall.reduce((n, v) => n + (v ? 1 : 0), 0),
      floorPixels: masks.floor.reduce((n, v) => n + (v ? 1 : 0), 0),
      size: [masks.width, masks.height],
      previews,
      materials,
    };
  }, base);
  for (const [name, data] of Object.entries(result.previews))
    await writeFile(output + '/' + name + '.png', Buffer.from(data.split(',')[1], 'base64'));
  await writeFile(
    output + '/result.json',
    JSON.stringify({ ...result, previews: undefined, errors, external }, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        creationMs: result.creationMs,
        stages: result.stages,
        objects: result.objects,
        planes: result.project.shared.comparison?.review?.planes,
        fixtures: result.project.shared.comparison?.before.fixtures.map((f) => ({
          kind: f.reconstruction?.kind,
          position: f.position,
          size: [f.width, f.height],
          anchor: f.anchor,
          roomPlacement: f.roomPlacement,
        })),
        wallPixels: result.wallPixels,
        floorPixels: result.floorPixels,
        errors,
        external,
      },
      null,
      2,
    ),
  );
  if (process.env.RECONSTRUCTION_EXPECT === 'mint-bathroom') {
    const before = result.project.shared.comparison!.before;
    const kinds = before.fixtures.map((f) => f.reconstruction?.kind);
    for (const kind of ['toilet', 'vanity', 'window', 'mirror'])
      assert.equal(kinds.filter((k) => k === kind).length, 1, kind + ' count');
    assert.equal(kinds.includes('bath'), false);
    assert.ok(
      before.surfaces.find((s) => s.roomFace === 'floor')!.tile.groutWidth > 0,
      'Observed floor grout',
    );
    for (const face of ['left', 'back', 'right'])
      assert.ok(
        before.surfaces.some((s) => s.roomFace === face && s.reconstructionBand && s.tile.groutWidth > 0),
        'Half-height tiles: ' + face,
      );
    assert.ok(
      before.fixtures
        .filter((f) => ['window', 'mirror'].includes(f.reconstruction!.kind))
        .every((f) => f.reconstruction?.appearanceAssetId),
      'Observed frames',
    );
    assert.equal(getActiveDesign(result.project)!.scene.fixtures.length, 0);
    assert.ok(getActiveDesign(result.project)!.scene.surfaces.every((s) => !s.materialVersionId));
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
