/** Actual saved user-03 DeepLab observations, production Review UI, actor corrections and local save. No new inference. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { ProjectDocument } from '../src/lib/types';
import type { ReconstructionCandidate } from '../src/lib/reconstruction/types';

const output =
  process.env.SJN_REVIEW_OUTPUT ?? 'test-results/reconstruction-placement-quality-20260914/review-ui/run-01';
const reportPath = 'test-results/reconstruction-product-color-20260914/actual-baseline/user-03/baseline.json';
const reportBytes = await readFile(reportPath),
  report = JSON.parse(reportBytes.toString('utf8'));
const manifest = JSON.parse(
  await readFile('test-results/reconstruction-product-color-20260914/manifest.json', 'utf8'),
);
const input = manifest.cases.find((item: { id: string }) => item.id === 'user-03').input;
const photo = await readFile(input.path);
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(photo), input.sha256);
const sourcePaths = [
  'src/components/reconstruction/reconstruction-review.tsx',
  'src/components/reconstruction/review-placement-picker.tsx',
  'src/lib/reconstruction/review-placement.ts',
  'src/components/reconstruction/reconstruction-properties.tsx',
  'src/lib/reconstruction/index.ts',
  'src/lib/reconstruction/types.ts',
  'src/lib/reconstruction/projection.ts',
  'src/lib/reconstruction/strict-placement.ts',
  'src/lib/reconstruction/product-color.ts',
  'src/lib/supabase/validation.ts',
];
const sourceHashes = Object.fromEntries(
  await Promise.all(sourcePaths.map(async (path) => [path, hash(await readFile(path))])),
);
const bundle = await build({
  stdin: {
    contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import Review from './src/components/reconstruction/reconstruction-review';import{AppProvider}from'./src/components/app-provider';
import{createReconstructionProject}from'./src/lib/reconstruction';import{reconstructionDefaults}from'./src/lib/reconstruction/types';
import{getRepositories}from'./src/lib/repositories';import{useEditor}from'./src/lib/editor-store';import{DEFAULT_ROOM}from'./src/lib/room-geometry';
let mounted,originalRaw,rawCallback,errors=[];
function App(){const [messages,setMessages]=useState([]);return <AppProvider><div role="status" data-testid="review-errors">{messages.join(' | ')}</div><Review open={true} onClose={()=>{}} onMaterialsChanged={async()=>{}} onError={message=>{errors.push(message);setMessages([...errors])}} onShowProperties={()=>{}}/></AppProvider>;}
function mount(){useEditor.getState().setEditing('before');mounted=createRoot(document.querySelector('main'));mounted.render(<App/>);}
export async function seed(){
 const report=await(await fetch('/report.json')).json(),photo=await(await fetch('/photo.jpg')).blob();originalRaw=structuredClone(report.rawReview);
 const project=await createReconstructionProject(new File([photo],'user-03.jpg',{type:'image/jpeg'}),DEFAULT_ROOM,{reuseAnalysis:report.rawReview,onRawReview:value=>rawCallback=structuredClone(value)});
 useEditor.getState().load(project);mount();return inspect();
}
export function inspect(){return{project:structuredClone(useEditor.getState().project),errors:[...errors],rawUnchanged:JSON.stringify(originalRaw)===JSON.stringify(rawCallback),originalRaw:structuredClone(originalRaw)}};
export function defaults(kind,variant){return reconstructionDefaults(kind,variant);}
export function undo(){useEditor.getState().undo();return inspect();}
export function redo(){useEditor.getState().redo();return inspect();}
export async function save(){return await getRepositories().projects.create(useEditor.getState().project);}
export async function reloadSaved(id){const p=await getRepositories().projects.load(id);useEditor.getState().load(p);mount();return inspect();}
`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  outfile: 'virtual-strict-review.js',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_STORAGE_MODE': '"local"' },
});
const js = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text,
  css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
const server = createServer((request, response) => {
  if (request.url === '/bundle.js') response.setHeader('Content-Type', 'text/javascript').end(js);
  else if (request.url === '/bundle.css') response.setHeader('Content-Type', 'text/css').end(css);
  else if (request.url === '/report.json')
    response.setHeader('Content-Type', 'application/json').end(reportBytes);
  else if (request.url === '/photo.jpg') response.setHeader('Content-Type', 'image/jpeg').end(photo);
  else
    response
      .setHeader('Content-Type', 'text/html')
      .end(
        '<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>*{box-sizing:border-box}body{font:16px sans-serif;color:#233c36;margin:16px}aside{position:relative!important;width:400px!important;max-width:100%!important;height:auto!important;overflow:visible!important}</style><h1>실제 보류 후보 · 사용자 확인 회귀</h1><p>기존 DeepLab 관측 재생. 아래 보정은 시험 사용자 입력이며 AI 자동 배치 성공이 아닙니다.</p><main></main></html>',
      );
});
await new Promise<void>((done, reject) => {
  server.once('error', reject);
  server.listen(43201, '127.0.0.1', () => {
    server.off('error', reject);
    done();
  });
});
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
type Inspection = {
  project: ProjectDocument;
  errors: string[];
  rawUnchanged: boolean;
  originalRaw: { candidates: ReconstructionCandidate[] };
};
const before = (value: Inspection) => value.project.shared.comparison!.before;
const candidates = (value: Inspection) => value.project.shared.comparison!.review!.candidates;
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
  const pageErrors: string[] = [],
    external: string[] = [];
  let workers = 0;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('worker', () => workers++);
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.goto(origin);
  const initial = (await page.evaluate(
    async (origin) => (await import(origin + '/bundle.js')).seed(),
    origin,
  )) as Inspection;
  const inspect = () =>
    page.evaluate(
      async (origin) => (await import(origin + '/bundle.js')).inspect(),
      origin,
    ) as Promise<Inspection>;
  assert.equal(initial.rawUnchanged, true);
  assert.deepEqual(initial.originalRaw, report.rawReview);
  assert.equal(before(initial).fixtures.length, 0);
  const toilet = candidates(initial).find(
    (candidate) => candidate.kind === 'toilet' && candidate.placementReview?.status === 'held',
  );
  const basin = candidates(initial).find(
    (candidate) => candidate.kind === 'basin' && candidate.placementReview?.status === 'held',
  );
  assert(
    toilet && basin,
    'Actual raw user-03 must yield a held toilet and basin; do not fabricate a rejection.',
  );
  const card = async (id: string) => page.locator('[data-candidate-id="' + id + '"]');
  const toiletCard = await card(toilet.id);
  await expect(toiletCard.getByRole('button', { name: '모형 추가', exact: true })).toBeEnabled();
  const requested = toilet.placementReview!.requested;
  assert.equal(
    Number(await toiletCard.getByLabel('보류 후보 가로 위치 (%)', { exact: true }).inputValue()),
    requested.u * 100,
  );
  assert.equal(
    Number(await toiletCard.getByLabel('보류 후보 폭 (mm)', { exact: true }).inputValue()),
    requested.widthMm,
  );
  await page.screenshot({ path: output + '/held-original.png', fullPage: true });
  const beforeInvalid = await inspect();
  await toiletCard.getByLabel('보류 후보 가로 위치 (%)', { exact: true }).fill('1000000000');
  await toiletCard.getByRole('button', { name: '모형 추가', exact: true }).click();
  await expect.poll(async () => (await inspect()).errors.length).toBe(1);
  const afterHuge = await inspect();
  assert.equal(afterHuge.project.editRevision, beforeInvalid.project.editRevision);
  assert.deepEqual(candidates(afterHuge), candidates(beforeInvalid));
  await toiletCard.getByLabel('보류 후보 가로 위치 (%)', { exact: true }).fill('');
  await toiletCard.getByRole('button', { name: '모형 추가', exact: true }).click();
  await expect.poll(async () => (await inspect()).errors.length).toBe(2);
  const afterBlank = await inspect();
  assert.equal(afterBlank.project.editRevision, beforeInvalid.project.editRevision);
  assert.deepEqual(candidates(afterBlank), candidates(beforeInvalid));
  await toiletCard.getByLabel('보류 후보 설치 면', { exact: true }).selectOption('back');
  assert.equal(
    Number(await toiletCard.getByLabel('보류 후보 세로·깊이 위치 (%)', { exact: true }).inputValue()),
    100,
  );
  assert.equal(
    Number(await toiletCard.getByLabel('보류 후보 설치 높이 (mm)', { exact: true }).inputValue()),
    0,
  );
  await toiletCard.getByLabel('보류 후보 설치 면', { exact: true }).selectOption('floor');
  await toiletCard.getByText('벽 쪽 기본 위치에서 시작', { exact: true }).click();
  await toiletCard.getByLabel('보류 후보 폭 (mm)', { exact: true }).fill('9000');
  for (const side of ['뒤쪽', '왼쪽', '오른쪽'])
    await expect(
      toiletCard.getByRole('button', { name: new RegExp(side + ' 벽 쪽 기본 위치 선택') }),
    ).toBeDisabled();
  await toiletCard.getByLabel('보류 후보 폭 (mm)', { exact: true }).fill(String(requested.widthMm));
  await toiletCard.getByRole('button', { name: /왼쪽 벽 쪽 기본 위치 선택/ }).click();
  assert.equal(
    Number(await toiletCard.getByLabel('보류 후보 가로 위치 (%)', { exact: true }).inputValue()),
    ((50 + requested.depthMm / 2) / 2400) * 100,
  );
  assert.deepEqual(
    (await inspect()).project,
    beforeInvalid.project,
    'Presets only edit local preview until Add.',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: output + '/mobile-preset.png', fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1200, height: 1100 });
  const plan = toiletCard.getByTestId('placement-picker');
  await plan.scrollIntoViewIfNeeded();
  const box = (await plan.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await plan.press('ArrowRight');
  await plan.press('ArrowLeft');
  await toiletCard.getByRole('button', { name: '오른쪽 보기', exact: true }).click();
  assert.equal(
    Number(await toiletCard.getByLabel('보류 후보 가로 위치 (%)', { exact: true }).inputValue()),
    50,
  );
  assert.equal(
    Number(await toiletCard.getByLabel('보류 후보 세로·깊이 위치 (%)', { exact: true }).inputValue()),
    50,
  );
  await toiletCard.getByRole('button', { name: '모형 추가', exact: true }).click();
  await expect
    .poll(
      async () => {
        const value = await inspect();
        assert.equal(value.errors.length, 2, value.errors.join(' | '));
        return before(value).fixtures.length;
      },
      { timeout: 30000 },
    )
    .toBe(1);
  const toiletAdded = await inspect(),
    placedToilet = before(toiletAdded).fixtures[0];
  assert.equal(placedToilet.roomPlacement!.u, 0.5);
  assert.equal(placedToilet.roomPlacement!.v, 0.5);
  assert.equal(placedToilet.reconstruction!.placementPolicy, 'preserve');
  for (const axis of ['width', 'height', 'depth'] as const) {
    assert.equal(placedToilet.reconstruction![`${axis}Mm`], requested[`${axis}Mm`]);
    assert.equal(
      placedToilet.reconstruction!.provenance![axis],
      requested.provenance?.[axis] ?? requested.provenance?.dimensions ?? 'default',
    );
  }
  assert.equal(placedToilet.reconstruction!.provenance!.position, 'user');
  assert.equal(placedToilet.reconstruction!.provenance!.wall, 'user');
  assert.equal(placedToilet.reconstruction!.yawDegrees, 90);
  assert.equal(toiletAdded.rawUnchanged, true);
  const basinCard = await card(basin.id);
  await basinCard.getByLabel('보류 후보 폭 (mm)', { exact: true }).fill('999');
  await basinCard.getByLabel('후보 설비 종류', { exact: true }).selectOption('vanity');
  const vanityDefaults = await page.evaluate(
    async (origin) => (await import(origin + '/bundle.js')).defaults('vanity'),
    origin,
  );
  assert.equal(
    Number(await basinCard.getByLabel('보류 후보 폭 (mm)', { exact: true }).inputValue()),
    vanityDefaults.widthMm,
  );
  assert.equal(
    await basinCard.getByLabel('보류 후보 설치 면', { exact: true }).inputValue(),
    vanityDefaults.face,
  );
  await basinCard.getByLabel('후보 설비 종류', { exact: true }).selectOption('basin');
  await basinCard.getByLabel('후보 세면대 설치 방식', { exact: true }).selectOption('wall');
  const wallDefaults = await page.evaluate(
    async (origin) => (await import(origin + '/bundle.js')).defaults('basin', 'wall'),
    origin,
  );
  assert.equal(
    Number(await basinCard.getByLabel('보류 후보 폭 (mm)', { exact: true }).inputValue()),
    wallDefaults.widthMm,
  );
  assert.equal(
    Number(await basinCard.getByLabel('보류 후보 설치 높이 (mm)', { exact: true }).inputValue()),
    wallDefaults.baseHeightMm,
  );
  assert.equal(
    await basinCard.getByLabel('보류 후보 설치 면', { exact: true }).inputValue(),
    wallDefaults.face,
  );
  await basinCard.getByLabel('보류 후보 폭 (mm)', { exact: true }).fill('620');
  const wallPlan = basinCard.getByTestId('placement-picker');
  await wallPlan.scrollIntoViewIfNeeded();
  const wallBox = (await wallPlan.boundingBox())!;
  await page.mouse.click(wallBox.x + wallBox.width * 0.37, wallBox.y + wallBox.height * (1 - 680 / 2400));
  const selectedWallU =
    Number(await basinCard.getByLabel('보류 후보 가로 위치 (%)', { exact: true }).inputValue()) / 100;
  const selectedHeight = Number(
    await basinCard.getByLabel('보류 후보 설치 높이 (mm)', { exact: true }).inputValue(),
  );
  assert(Math.abs(selectedWallU - 0.37) < 0.003);
  assert(Math.abs(selectedHeight - 680) < 5);
  await basinCard.getByRole('button', { name: '모형 추가', exact: true }).click();
  await expect
    .poll(
      async () => {
        const value = await inspect();
        assert.equal(value.errors.length, 2, value.errors.join(' | '));
        return before(value).fixtures.length;
      },
      { timeout: 30000 },
    )
    .toBe(2);
  const bothAdded = await inspect(),
    placedBasin = before(bothAdded).fixtures.find((fixture) => fixture.id !== placedToilet.id)!;
  assert.equal(placedBasin.reconstruction!.kind, 'basin');
  assert.equal(placedBasin.reconstruction!.basinVariant, 'wall');
  assert.equal(placedBasin.roomPlacement!.face, wallDefaults.face);
  assert.equal(placedBasin.roomPlacement!.u, selectedWallU);
  assert.equal(placedBasin.reconstruction!.widthMm, 620);
  assert.equal(placedBasin.reconstruction!.baseHeightMm, selectedHeight);
  assert.equal(placedBasin.reconstruction!.heightMm, wallDefaults.heightMm);
  assert.equal(placedBasin.reconstruction!.depthMm, wallDefaults.depthMm);
  assert.equal(placedBasin.reconstruction!.provenance!.width, 'user');
  assert.equal(placedBasin.reconstruction!.provenance!.height, 'default');
  assert.equal(placedBasin.reconstruction!.provenance!.depth, 'default');
  assert.equal(bothAdded.rawUnchanged, true);
  assert.equal(bothAdded.errors.length, 2, 'Only the deliberate huge/blank invalid actions should fail.');
  const undone = (await page.evaluate(
    async (origin) => (await import(origin + '/bundle.js')).undo(),
    origin,
  )) as Inspection;
  assert.equal(before(undone).fixtures.length, 1);
  const redone = (await page.evaluate(
    async (origin) => (await import(origin + '/bundle.js')).redo(),
    origin,
  )) as Inspection;
  assert.deepEqual(before(redone).fixtures, before(bothAdded).fixtures);
  const saved = (await page.evaluate(
    async (origin) => (await import(origin + '/bundle.js')).save(),
    origin,
  )) as ProjectDocument;
  await page.reload();
  const reloaded = (await page.evaluate(
    async ({ origin, id }) => (await import(origin + '/bundle.js')).reloadSaved(id),
    { origin, id: saved.id },
  )) as Inspection;
  assert.deepEqual(before(reloaded).fixtures, before(bothAdded).fixtures);
  assert.deepEqual(reloaded.project.shared.comparison!.review, bothAdded.project.shared.comparison!.review);
  assert(reloaded.project.designs.every((design) => design.scene.fixtures.length === 0));
  assert.deepEqual(
    before(reloaded).fixtures.map((fixture) => fixture.reconstruction!.colorEvidence),
    before(bothAdded).fixtures.map((fixture) => fixture.reconstruction!.colorEvidence),
  );
  await page.screenshot({ path: output + '/review-after-reload.png', fullPage: true });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(external, []);
  assert.equal(workers, 0);
  assert.equal(hash(await readFile(reportPath)), hash(reportBytes));
  assert.equal(hash(await readFile(input.path)), input.sha256);
  const finalHashes = Object.fromEntries(
    await Promise.all(sourcePaths.map(async (path) => [path, hash(await readFile(path))])),
  );
  assert.deepEqual(finalHashes, sourceHashes);
  const verification = {
    scope:
      'Actual saved DeepLab user-03 observations through production createReconstructionProject/reuseAnalysis and Review UI. User corrections are deliberate actor input, not automatic placement success. No new AI execution. Explicit repository save; no autosave timing claim.',
    sourceReport: reportPath,
    sourceReportSha256: hash(reportBytes),
    inputSha256: input.sha256,
    sourceHashes,
    sourceHashesUnchanged: true,
    browser: browser.version(),
    rendering: 'Chrome headless / SwiftShader',
    heldCandidateIds: { toilet: toilet.id, basin: basin.id },
    originalRequested: { toilet: toilet.placementReview!.requested, basin: basin.placementReview!.requested },
    invalidActions: ['u=1e9%', 'blank u producing NaN'],
    validActorInputs: {
      toilet: {
        wallPreset: 'left',
        pictureClick: [0.5, 0.5],
        keyboard: 'right then left',
        yaw: 90,
        dimensions: 'unchanged',
      },
      basin: {
        kind: 'vanity then basin',
        basinVariant: 'wall',
        pictureClick: [selectedWallU, 1 - selectedHeight / 2400],
        widthMm: 620,
        baseHeightMm: selectedHeight,
      },
    },
    initialFixtureCount: before(initial).fixtures.length,
    afterFixtureCount: before(bothAdded).fixtures.length,
    invalidRevisionUnchanged: true,
    presetPreviewDoesNotCommit: true,
    oversizedPresetsDisabled: true,
    mobileNoOverflow: true,
    pointerAndKeyboard: true,
    wallClickSetsPositionAndHeight: true,
    faceChangeKeepsHeightConsistent: true,
    undoRedo: true,
    originalRawUnchanged: true,
    storedProjectId: saved.id,
    reloadedFixtures: before(reloaded).fixtures,
    expectedInputErrors: bothAdded.errors,
    pageErrors,
    external,
    workers,
  };
  await writeFile(output + '/verification.json', JSON.stringify(verification, null, 2));
  await writeFile(output + '/initial-project.json', JSON.stringify(initial.project, null, 2));
  await writeFile(output + '/saved-project.json', JSON.stringify(saved, null, 2));
  console.log(
    JSON.stringify({
      initialFixtures: before(initial).fixtures.length,
      finalFixtures: before(bothAdded).fixtures.length,
      storedProjectId: saved.id,
      expectedInputErrors: bothAdded.errors.length,
      pageErrors,
      external,
      workers,
      output,
    }),
  );
} catch (error) {
  const activePage = browser.contexts()[0]?.pages()[0];
  if (activePage) {
    await activePage.screenshot({ path: output + '/failure.png', fullPage: true });
    const state = await activePage.evaluate(
      async (origin) => (await import(origin + '/bundle.js')).inspect(),
      origin,
    );
    await writeFile(output + '/failure.json', JSON.stringify({ error: String(error), state }, null, 2));
    console.error(
      JSON.stringify({
        applicationErrors: state.errors,
        fixtureCount: state.project.shared.comparison.before.fixtures.length,
      }),
    );
  }
  throw error;
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
