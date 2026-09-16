/** Actual Before property controls and IndexedDB. Deliberate synthetic fixture; no AI/model download. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { FixtureInstance } from '../src/lib/types';

const output =
  'test-results/reconstruction-properties-color-20260914' +
  (process.env.SJN_PROPERTIES_COLOR_RUN === 'strict' ? '/run-02-preserve' : '');
const sourcePaths = [
  'src/components/reconstruction/reconstruction-properties.tsx',
  'src/components/reconstruction/reconstruction-fixture-controls.tsx',
  'src/lib/reconstruction/product-color.ts',
  'src/lib/reconstruction/index.ts',
  'src/lib/reconstruction/types.ts',
  'src/lib/reconstruction/projection.ts',
  'src/lib/reconstruction/strict-placement.ts',
  'src/lib/supabase/validation.ts',
];
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const sourceHashes = Object.fromEntries(
  await Promise.all(sourcePaths.map(async (path) => [path, hash(await readFile(path))])),
);
const bundle = await build({
  stdin: {
    contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import Properties from './src/components/reconstruction/reconstruction-properties';
import {createReconstructionFixture} from './src/lib/reconstruction';
import {getRepositories} from './src/lib/repositories';
import {useEditor} from './src/lib/editor-store';
import {DEFAULT_ROOM} from './src/lib/room-geometry';
import {DEFAULT_COLOR,EMPTY_MASK} from './src/lib/types';
import {resolveProductColor} from './src/lib/reconstruction/product-color';
function Mount(){
 const project=useEditor(state=>state.project);
 const scene=project.shared.comparison.before, fixture=scene.fixtures[0];
 return <Properties key={fixture.materialVersionId} scene={scene} fixture={fixture} materials={{}} onMaterialsChanged={async()=>{}}/>;
}
function mount(){useEditor.getState().setEditing('before');createRoot(document.querySelector('main')).render(<Mount/>);}
export async function seed(){
 const colorEvidence=resolveProductColor('toilet',{color:'#8a7767'});
 const fixture=await createReconstructionFixture({kind:'toilet',version:2,room:DEFAULT_ROOM,color:colorEvidence.color,colorEvidence,provenance:{appearance:colorEvidence.source,color:colorEvidence.source},widthMm:400,heightMm:800,depthMm:700,u:.5,v:.5});
 const repo=getRepositories(), materials=await repo.materials.list(), assetId=materials[0].version.views[0].assetId;
 const blank={originalAssetId:assetId,previewAssetId:assetId,room:DEFAULT_ROOM,imageWidth:1200,imageHeight:800,surfaces:[],fixtures:[],protection:EMPTY_MASK(),color:{...DEFAULT_COLOR}};
 const stamp=new Date().toISOString();
 useEditor.getState().load({id:crypto.randomUUID(),ownerId:'local',name:'색 근거 Before 속성 시험',schemaVersion:2,editRevision:0,storageRevision:0,createdAt:stamp,updatedAt:stamp,viewport:{zoom:1,pan:{x:0,y:0}},history:{past:[],future:[]},scene:blank,comparison:{before:{...blank,fixtures:[fixture]},room:DEFAULT_ROOM,aspect:1.5,cameraVersion:1,status:'draft',referenceOriginalAssetId:assetId,referencePreviewAssetId:assetId,review:{version:2,analysis:'partial',warnings:[],planes:[],candidates:[{id:'synthetic-toilet',kind:'toilet',fixtureId:fixture.id,bounds:{left:.25,right:.6,top:.3,bottom:.8},foot:{x:.4,y:.8},color:fixture.reconstruction.color,colorEvidence:structuredClone(colorEvidence),pixels:20,evidence:{semanticPixels:20,meanMargin:2},status:'placed'}]}}});
 mount();
 return {fixture:structuredClone(fixture),versions:structuredClone(materials)};
}
export function inspect(){const state=useEditor.getState(),p=state.project;return {fixture:structuredClone(p.shared.comparison.before.fixtures[0]),candidate:structuredClone(p.shared.comparison.review.candidates[0]),revision:p.editRevision,history:p.shared.beforeHistory.past.length,emptyAfter:p.designs.every(d=>d.scene.fixtures.length===0)};}
export function history(action){useEditor.getState()[action]();return inspect();}
export async function save(){const repo=getRepositories(),saved=await repo.projects.create(useEditor.getState().project);return {id:saved.id,project:saved,versions:await repo.materials.list()};}
export async function reloadSaved(id){const project=await getRepositories().projects.load(id);useEditor.getState().load(project);mount();return inspect();}
`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  outfile: 'virtual-properties-color.js',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_STORAGE_MODE': '"local"' },
});
const script = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
const server = createServer((request, response) => {
  if (request.url === '/bundle.js') response.setHeader('Content-Type', 'text/javascript').end(script);
  else if (request.url === '/bundle.css') response.setHeader('Content-Type', 'text/css').end(css);
  else
    response
      .setHeader('Content-Type', 'text/html')
      .end(
        '<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>*{box-sizing:border-box}body{font:16px sans-serif;color:#233a35;max-width:520px;margin:20px auto;padding:12px}</style><h1>Before 색 근거 보존 검사</h1><p>직접 만든 시험 모형 · AI 인식 검증 아님</p><main></main></html>',
      );
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
type Inspection = {
  fixture: FixtureInstance;
  candidate: {
    color: string;
    colorEvidence: NonNullable<FixtureInstance['reconstruction']>['colorEvidence'];
  };
  revision: number;
  history: number;
  emptyAfter: boolean;
};
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  const errors: string[] = [],
    external: string[] = [];
  let workers = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('worker', () => workers++);
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.goto(origin);
  const seeded = await page.evaluate(async (origin) => (await import(origin + '/bundle.js')).seed(), origin);
  const inspect = () =>
    page.evaluate(
      async (origin) => (await import(origin + '/bundle.js')).inspect(),
      origin,
    ) as Promise<Inspection>;
  const initial = await inspect();
  const originalEvidence = structuredClone(initial.fixture.reconstruction!.colorEvidence);
  const apply = page.getByRole('button', { name: '재구성 설정 적용', exact: true });
  await page.getByLabel('재구성 가로 (mm)', { exact: true }).fill('420');
  await apply.click();
  await expect.poll(async () => (await inspect()).fixture.reconstruction!.widthMm).toBe(420);
  const defaultGeometry = await inspect();
  assert.deepEqual(defaultGeometry.fixture.reconstruction!.colorEvidence, originalEvidence);
  assert.equal(defaultGeometry.fixture.reconstruction!.provenance!.color, 'default');
  assert.equal(defaultGeometry.fixture.reconstruction!.provenance!.appearance, 'default');
  assert.equal(defaultGeometry.fixture.reconstruction!.provenance!.width, 'user');
  assert.deepEqual(defaultGeometry.candidate.colorEvidence, originalEvidence);
  await page.getByLabel('재구성 대표 색상', { exact: true }).fill('#6d95a3');
  await apply.click();
  await expect.poll(async () => (await inspect()).fixture.reconstruction!.color).toBe('#6d95a3');
  const custom = await inspect();
  assert.equal(custom.fixture.reconstruction!.provenance!.color, 'user');
  assert.equal(custom.fixture.reconstruction!.colorEvidence!.observedColor, '#8a7767');
  assert.equal(custom.fixture.reconstruction!.colorEvidence!.requiresReview, false);
  await page.getByLabel('재구성 높이 (mm)', { exact: true }).fill('810');
  await apply.click();
  await expect.poll(async () => (await inspect()).fixture.reconstruction!.heightMm).toBe(810);
  const customGeometry = await inspect();
  assert.deepEqual(
    customGeometry.fixture.reconstruction!.colorEvidence,
    custom.fixture.reconstruction!.colorEvidence,
  );
  assert.equal(customGeometry.fixture.reconstruction!.provenance!.appearance, 'user');
  const undone = (await page.evaluate(
    async (origin) => (await import(origin + '/bundle.js')).history('undo'),
    origin,
  )) as Inspection;
  assert.equal(undone.fixture.reconstruction!.heightMm, 800);
  assert.deepEqual(
    undone.fixture.reconstruction!.colorEvidence,
    custom.fixture.reconstruction!.colorEvidence,
  );
  const redone = (await page.evaluate(
    async (origin) => (await import(origin + '/bundle.js')).history('redo'),
    origin,
  )) as Inspection;
  assert.deepEqual(redone.fixture.reconstruction, customGeometry.fixture.reconstruction);
  await page.getByRole('button', { name: '중립 기본색으로 확인', exact: true }).click();
  await apply.click();
  await expect.poll(async () => (await inspect()).fixture.reconstruction!.color).toBe('#efefea');
  const neutral = await inspect();
  assert.equal(neutral.fixture.reconstruction!.colorEvidence!.source, 'user');
  assert.equal(neutral.fixture.reconstruction!.colorEvidence!.observedColor, '#8a7767');
  assert.equal(neutral.fixture.reconstruction!.colorEvidence!.requiresReview, false);
  await page.getByLabel('재구성 깊이 (mm)', { exact: true }).fill('690');
  await apply.click();
  await expect.poll(async () => (await inspect()).fixture.reconstruction!.depthMm).toBe(690);
  const neutralGeometry = await inspect();
  assert.deepEqual(
    neutralGeometry.fixture.reconstruction!.colorEvidence,
    neutral.fixture.reconstruction!.colorEvidence,
  );
  await page.getByLabel('재구성 대표 색상', { exact: true }).fill('#112233');
  await page.getByRole('button', { name: '원래 색 유지', exact: true }).click();
  assert.equal(await page.getByLabel('재구성 대표 색상', { exact: true }).inputValue(), '#efefea');
  assert.equal((await inspect()).revision, neutralGeometry.revision);
  const saved = await page.evaluate(async (origin) => (await import(origin + '/bundle.js')).save(), origin);
  for (const original of seeded.versions)
    assert.deepEqual(
      saved.versions.find((entry: { version: { id: string } }) => entry.version.id === original.version.id),
      original,
    );
  await page.reload();
  const reloaded = (await page.evaluate(
    async ({ origin, id }) => (await import(origin + '/bundle.js')).reloadSaved(id),
    { origin, id: saved.id },
  )) as Inspection;
  assert.deepEqual(reloaded.fixture.reconstruction, neutralGeometry.fixture.reconstruction);
  assert.deepEqual(reloaded.candidate.colorEvidence, neutralGeometry.fixture.reconstruction!.colorEvidence);
  assert.equal(reloaded.emptyAfter, true);
  await page.screenshot({ path: output + '/properties-after-reload.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: output + '/properties-mobile.png', fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(workers, 0);
  const afterHashes = Object.fromEntries(
    await Promise.all(sourcePaths.map(async (path) => [path, hash(await readFile(path))])),
  );
  assert.deepEqual(afterHashes, sourceHashes);
  const verification = {
    scope:
      'Actual production Before properties, renderer, editor undo/redo, repository write and page reload; synthetic fixture, no AI accuracy claim. Save explicitly invokes the real repository, not the editor autosave scheduler.',
    browser: browser.version(),
    rendering: 'Headless Chrome / SwiftShader',
    sourceHashes,
    bundleHash: hash(script),
    sourceHashesUnchanged: true,
    checks: [
      'default evidence survives geometry-only edit',
      'custom colour marks user and retains observation',
      'custom evidence survives geometry-only edit',
      'undo/redo preserves colour evidence',
      'explicit neutral confirmation is user, not automatic default',
      'neutral user evidence survives geometry-only edit',
      'cancelled pending colour leaves document unchanged',
      'review candidate evidence matches fixture',
      'IndexedDB save and actual page reload preserve evidence/history',
      'original immutable material versions unchanged',
      'After remains empty',
      '390px no horizontal overflow',
    ],
    initial,
    defaultGeometry,
    custom,
    customGeometry,
    undone,
    redone,
    neutral,
    neutralGeometry,
    reloaded,
    savedProjectId: saved.id,
    historyLength: reloaded.history,
    errors,
    external,
    workers,
  };
  await writeFile(output + '/verification.json', JSON.stringify(verification, null, 2));
  console.log(
    JSON.stringify({
      checks: verification.checks.length,
      savedProjectId: saved.id,
      historyLength: reloaded.history,
      errors,
      external,
      workers,
      output,
    }),
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
