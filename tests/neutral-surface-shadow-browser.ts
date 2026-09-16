/** Actual Three shadow-policy A/B on a preserved real inference result. No AI or image filtering. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { ProjectDocument, AssetRecord, MaterialVersion } from '../src/lib/types';
const input =
  'test-results/reconstruction-fifteen-rebuild/20260915-start/actual-app-2026-09-15T01-23-08-422Z/pc-01/project-bundle.json';
const out = 'test-results/reconstruction-fifteen-rebuild/20260915-start/neutral-surface-shadow-ab-final';
const bytes = await readFile(input),
  sha = createHash('sha256').update(bytes).digest('hex');
const source = JSON.parse(bytes.toString()) as {
  document: ProjectDocument;
  versions: MaterialVersion[];
  assets: (Omit<AssetRecord, 'blob'> & { blobBase64: string })[];
};
const bundle = await build({
  stdin: {
    contents:
      "export {RoomViewerRenderer} from './src/lib/room-viewer/renderer';export {createRoomViewCamera,roomViewViewport,sourceRoomView} from './src/lib/room-viewer/view-state';export {Mesh,DirectionalLight,Box3,Vector3} from 'three';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'ShadowTest',
  platform: 'browser',
});
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl'] });
try {
  await mkdir(out, { recursive: true });
  const page = await browser.newPage(),
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43219/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async (source) => {
    const m = (
      window as unknown as {
        ShadowTest: typeof import('../src/lib/room-viewer/renderer') &
          typeof import('../src/lib/room-viewer/view-state') &
          typeof import('three');
      }
    ).ShadowTest;
    const project = source.document,
      scene = project.shared.comparison!.before,
      materials = Object.fromEntries(source.versions.map((v) => [v.id, v]));
    const assets = new Map(
      source.assets.map((a) => [
        a.id,
        {
          ...a,
          blob: new Blob([Uint8Array.from(atob(a.blobBase64), (c) => c.charCodeAt(0))], { type: a.mime }),
        } as AssetRecord,
      ]),
    );
    const snapshot = {
      scene: project.designs[0].scene,
      beforeScene: scene,
      materials,
      roomView: project.roomView,
    };
    const width = 1200,
      height = 800,
      baseline = JSON.stringify(source),
      outputs: Record<string, string> = {},
      stats: Record<string, unknown> = {},
      faces: unknown[] = [];
    let normalPixels: Uint8ClampedArray | undefined;
    for (const mode of [
      'original-depth',
      'original-depth-no-shadows',
      'original-depth-hide-glass',
      'original-depth-no-receive',
      'normal',
      'neutral-no-receive',
      'neutral-no-cast',
      'fixture-no-cast',
      'all-shadows-off',
      'normal-bias-zero',
      'clip-near-10',
      'clip-near-50',
      'neutral-polygon-offset',
      'hide-glass',
    ]) {
      const renderer = new m.RoomViewerRenderer();
      await renderer.setSnapshot(snapshot, async (id) => assets.get(id));
      const state = renderer as unknown as {
        prepared: { before: { world: import('three').Scene; fixtures: { group: import('three').Group } } };
        renderer: import('three').WebGLRenderer;
      };
      const candidates = scene.fixtures.filter((f) =>
          ['mirror', 'mirrorCabinet', 'window'].includes(f.reconstruction?.kind ?? ''),
        ),
        ids = new Set(candidates.map((f) => f.id));
      const groups = state.prepared.before.fixtures.group.children.filter((g) =>
        ids.has(g.userData.fixtureId),
      );
      for (const group of groups)
        group.traverse((node) => {
          if (!(node instanceof m.Mesh)) return;
          const list = Array.isArray(node.material) ? node.material : [node.material];
          const neutral =
            !!node.geometry.getAttribute('color') &&
            list.every((mat) => 'vertexColors' in mat && mat.vertexColors) &&
            ['PlaneGeometry', 'ShapeGeometry'].includes(node.geometry.type);
          if (mode === 'normal')
            faces.push({
              fixtureId: group.userData.fixtureId,
              name: node.name,
              geometry: node.geometry.type,
              neutral,
              cast: node.castShadow,
              receive: node.receiveShadow,
            });
          if ((mode === 'neutral-no-receive' || mode === 'original-depth-no-receive') && neutral)
            node.receiveShadow = false;
          if (mode === 'neutral-no-cast' && neutral) node.castShadow = false;
          if (mode === 'fixture-no-cast') node.castShadow = false;
          if (mode === 'neutral-polygon-offset' && neutral)
            for (const mat of list) {
              mat.polygonOffset = true;
              mat.polygonOffsetFactor = -1;
              mat.polygonOffsetUnits = -1;
            }
        });
      if (mode === 'hide-glass' || mode === 'original-depth-hide-glass')
        for (const group of state.prepared.before.fixtures.group.children) {
          if (
            scene.fixtures.find((f) => f.id === group.userData.fixtureId)?.reconstruction?.kind ===
            'glassPartition'
          )
            group.visible = false;
        }
      if (mode.startsWith('clip-near-') || mode.startsWith('original-depth')) {
        const original = state.renderer.render.bind(state.renderer);
        state.renderer.render = (world, camera) => {
          if ('isPerspectiveCamera' in camera) {
            const perspective = camera as import('three').PerspectiveCamera;
            perspective.near = mode.startsWith('original-depth') ? 0.1 : mode === 'clip-near-10' ? 10 : 50;
            perspective.far = mode.startsWith('original-depth') ? 1e7 : 50000;
            perspective.updateProjectionMatrix();
          }
          original(world, camera);
        };
      }
      if (mode === 'all-shadows-off' || mode === 'original-depth-no-shadows')
        state.renderer.shadowMap.enabled = false;
      if (mode === 'normal-bias-zero')
        state.prepared.before.world.traverse((node) => {
          if (node instanceof m.DirectionalLight) node.shadow.normalBias = 0;
        });
      const canvas = renderer.render(width, height, project.roomView!, 'before'),
        copy = document.createElement('canvas');
      copy.width = width;
      copy.height = height;
      const ctx = copy.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      outputs[mode] = copy.toDataURL('image/png');
      if (mode === 'original-depth') normalPixels = pixels;
      let changed = 0,
        totalDelta = 0;
      for (let i = 0; i < pixels.length; i++) {
        const delta = Math.abs(pixels[i] - normalPixels![i]);
        if (delta) changed++;
        totalDelta += delta;
      }
      const camera = m.createRoomViewCamera(scene.room!, width / height, project.roomView!),
        rect = m.roomViewViewport(width, height, project.roomView!);
      const regions = groups.map((group) => {
        const box = new m.Box3().setFromObject(group),
          points = [box.min.x, box.max.x].flatMap((x) =>
            [box.min.y, box.max.y].flatMap((y) =>
              [box.min.z, box.max.z].map((z) => new m.Vector3(x, y, z).project(camera)),
            ),
          );
        return {
          fixtureId: group.userData.fixtureId,
          left: Math.max(
            0,
            Math.floor(rect.x + ((Math.min(...points.map((p) => p.x)) + 1) * rect.width) / 2),
          ),
          right: Math.min(
            width,
            Math.ceil(rect.x + ((Math.max(...points.map((p) => p.x)) + 1) * rect.width) / 2),
          ),
          top: Math.max(
            0,
            Math.floor(height - rect.y - ((Math.max(...points.map((p) => p.y)) + 1) * rect.height) / 2),
          ),
          bottom: Math.min(
            height,
            Math.ceil(height - rect.y - ((Math.min(...points.map((p) => p.y)) + 1) * rect.height) / 2),
          ),
        };
      });
      stats[mode] = {
        changedChannels: changed,
        meanChannelDelta: totalDelta / pixels.length,
        regions,
        diagnostics: renderer.diagnostics(),
      };
      renderer.dispose();
    }
    const authored: unknown[] = [];
    const authoredOutputs: Record<string, string> = {};
    // Authored model/render regression only. These changes are never attributed to AI recognition.
    for (const kind of ['mirror', 'mirrorCabinet', 'window'] as const)
      for (const version of [1, 2] as const) {
        const authoredScene = structuredClone(scene),
          fixture = structuredClone(scene.fixtures.find((f) => f.reconstruction?.kind === 'mirror')!);
        fixture.id = crypto.randomUUID();
        fixture.name = 'Authored ' + kind;
        fixture.reconstruction = {
          ...fixture.reconstruction!,
          kind,
          version,
          widthMm: 600,
          heightMm: 800,
          depthMm: 25,
          orientation: 'back',
          baseHeightMm: 1000,
        };
        fixture.roomPlacement = {
          ...fixture.roomPlacement!,
          face: 'back',
          u: 0.5,
          v: 0.4,
          widthMm: 600,
          heightMm: 800,
        };
        authoredScene.fixtures = [fixture];
        const view = m.sourceRoomView(
          {
            version: 1,
            positionMm: [0, 1500, 3500],
            quaternion: [0, 0, 0, 1],
            verticalFovDegrees: 64,
            image: { width: 960, height: 1280 },
          },
          scene.room!,
        );
        const r = new m.RoomViewerRenderer();
        await r.setSnapshot({ ...snapshot, beforeScene: authoredScene, roomView: view }, async (id) =>
          assets.get(id),
        );
        const a = r.render(600, 800, view, 'before').toDataURL();
        const prepared = r as unknown as {
          prepared: { before: { fixtures: { group: import('three').Group } } };
        };
        let neutralCount = 0,
          flagsPreserved = true;
        prepared.prepared.before.fixtures.group.traverse((n) => {
          if (!(n instanceof m.Mesh)) return;
          if (
            !n.geometry.getAttribute('color') ||
            !['PlaneGeometry', 'ShapeGeometry'].includes(n.geometry.type)
          )
            return;
          neutralCount++;
          flagsPreserved &&= n.castShadow && n.receiveShadow;
          for (const mat of Array.isArray(n.material) ? n.material : [n.material]) {
            mat.polygonOffset = true;
            mat.polygonOffsetFactor = -1;
            mat.polygonOffsetUnits = -1;
          }
        });
        const b = r.render(600, 800, view, 'before').toDataURL();
        if (!neutralCount || !flagsPreserved || a !== b)
          throw Error('Neutral depth regression ' + kind + ' v' + version);
        authored.push({
          kind,
          version,
          neutralCount,
          shadowFlagsPreserved: flagsPreserved,
          pixelsEqualWithOffset: a === b,
          depth: r.diagnostics().sourceDepthClip,
        });
        authoredOutputs[kind + '-v' + version] = a;
        r.dispose();
      }
    if (outputs.normal !== outputs['neutral-polygon-offset'])
      throw Error('Offset still changes neutral surface after depth fix');
    if (JSON.stringify(source) !== baseline) throw Error('Stored inputs changed');
    return { outputs: { ...outputs, ...authoredOutputs }, stats, faces, authored };
  }, source);
  for (const [name, data] of Object.entries(result.outputs))
    await writeFile(out + '/' + name + '.png', Buffer.from(data.split(',')[1], 'base64'));
  await writeFile(
    out + '/verification.json',
    JSON.stringify(
      {
        input,
        sha,
        stats: result.stats,
        faces: result.faces,
        authored: result.authored,
        errors,
        browser: await browser.version(),
        scope:
          'Same real saved input, actual Three flags changed only in temporary derived scene; no AI or stored model edits.',
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  assert.equal(
    createHash('sha256')
      .update(await readFile(input))
      .digest('hex'),
    sha,
  );
  console.log(
    JSON.stringify(
      {
        out,
        stats: Object.fromEntries(
          Object.entries(result.stats).map(([key, value]) => [
            key,
            (value as { meanChannelDelta: number }).meanChannelDelta,
          ]),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
