/** Actual saved user-01 DeepLab observations, production Review UI, actor corrections and local save. No new inference. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { ProjectDocument } from '../src/lib/types';
import type { ReconstructionCandidate } from '../src/lib/reconstruction/types';

const output =
  process.env.SJN_UNMAPPED_OUTPUT ??
  'test-results/reconstruction-placement-quality-20260914/unmapped-review-ui/run-01';
const reportPath = 'test-results/reconstruction-product-color-20260914/actual-baseline/user-01/baseline.json';
const reportBytes = await readFile(reportPath),
  report = JSON.parse(reportBytes.toString('utf8'));
const manifest = JSON.parse(
  await readFile('test-results/reconstruction-product-color-20260914/manifest.json', 'utf8'),
);
const input = manifest.cases.find((item: { id: string }) => item.id === 'user-01').input;
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
 const project=await createReconstructionProject(new File([photo],'user-01.jpg',{type:'image/jpeg'}),DEFAULT_ROOM,{reuseAnalysis:report.rawReview,onRawReview:value=>rawCallback=structuredClone(value)});
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
  server.listen(43202, '127.0.0.1', () => {
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

  const candidateId = 'object-48-109079';
  const candidate = candidates(initial).find((value) => value.id === candidateId)!;
  assert(candidate, 'Actual user-01 basin candidate must exist; never substitute a mock.');
  assert.equal(candidate.kind, 'basin');
  assert.equal(candidate.installation?.mode, 'wall');
  assert.equal(candidate.installation?.basinVariant, 'wall');
  assert.equal(candidate.installation?.wall, undefined);
  assert.equal(
    candidate.placementReview,
    undefined,
    'This test specifically covers the no-proposal fallback.',
  );
  const originalCandidate = structuredClone(candidate);
  const card = page.locator('[data-candidate-id="' + candidateId + '"]');
  await expect(
    card.getByText('설치 위치 근거가 부족해 기본값으로 시작해요.', { exact: false }),
  ).toBeVisible();
  const getValue = async (label: string) =>
    Number(await card.getByLabel(label, { exact: true }).inputValue());
  const defaults = await page.evaluate(
    async (origin) => (await import(origin + '/bundle.js')).defaults('basin', 'wall'),
    origin,
  );
  assert.equal(await getValue('보류 후보 설치 높이 (mm)'), 650);
  assert.equal(await getValue('보류 후보 폭 (mm)'), defaults.widthMm);
  assert.equal(await getValue('보류 후보 높이 (mm)'), defaults.heightMm);
  assert.equal(await getValue('보류 후보 깊이 (mm)'), defaults.depthMm);
  assert(Math.abs((await getValue('보류 후보 세로·깊이 위치 (%)')) / 100 - (1 - 650 / 2400)) < 1e-10);
  await expect(card.getByRole('button', { name: '모형 추가', exact: true })).toBeEnabled();
  await card.screenshot({ path: output + '/initial-unmapped-basin.png' });
  await card.getByLabel('보류 후보 설치 면', { exact: true }).selectOption('left');
  assert.equal(await getValue('보류 후보 설치 높이 (mm)'), 650);
  assert(Math.abs((await getValue('보류 후보 세로·깊이 위치 (%)')) / 100 - (1 - 650 / 2400)) < 1e-10);
  assert.deepEqual(
    (await inspect()).project,
    initial.project,
    'Selecting the install wall only edits preview.',
  );
  const picker = card.getByTestId('placement-picker');
  await picker.scrollIntoViewIfNeeded();
  const box = (await picker.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.7);
  const selectedU = (await getValue('보류 후보 가로 위치 (%)')) / 100;
  const selectedV = (await getValue('보류 후보 세로·깊이 위치 (%)')) / 100;
  const selectedHeight = await getValue('보류 후보 설치 높이 (mm)');
  assert(Math.abs(selectedU - 0.5) < 0.0002);
  assert(Math.abs(selectedV - 0.7) < 0.0002);
  assert(Math.abs(selectedHeight - (1 - selectedV) * 2400) < 1e-8);
  for (const [label, expected] of [
    ['보류 후보 폭 (mm)', defaults.widthMm],
    ['보류 후보 높이 (mm)', defaults.heightMm],
    ['보류 후보 깊이 (mm)', defaults.depthMm],
  ] as const)
    assert.equal(await getValue(label), expected);
  assert.deepEqual((await inspect()).project, initial.project, 'Picture input is uncommitted until Add.');
  await card.screenshot({ path: output + '/picture-selected.png' });
  await card.getByRole('button', { name: '모형 추가', exact: true }).click();
  await expect.poll(async () => before(await inspect()).fixtures.length).toBe(1);
  const added = await inspect(),
    fixture = before(added).fixtures[0];
  const applied = candidates(added).find((value) => value.id === candidateId)!;
  assert.deepEqual(added.errors, []);
  assert.equal(added.rawUnchanged, true);
  assert.equal(fixture.reconstruction!.kind, 'basin');
  assert.equal(fixture.reconstruction!.basinVariant, 'wall');
  assert.equal(fixture.reconstruction!.placementPolicy, 'preserve');
  assert.equal(fixture.roomPlacement!.face, 'left');
  assert.equal(fixture.roomPlacement!.u, selectedU);
  assert.equal(fixture.roomPlacement!.v, selectedV);
  assert.equal(fixture.reconstruction!.baseHeightMm, selectedHeight);
  for (const [field, expected] of [
    ['widthMm', defaults.widthMm],
    ['heightMm', defaults.heightMm],
    ['depthMm', defaults.depthMm],
  ] as const)
    assert.equal(fixture.reconstruction![field], expected);
  for (const field of ['width', 'height', 'depth', 'dimensions'] as const)
    assert.equal(fixture.reconstruction!.provenance![field], 'default');
  assert.equal(fixture.reconstruction!.provenance!.position, 'user');
  assert.equal(fixture.reconstruction!.provenance!.wall, 'user');
  assert.equal(
    fixture.reconstruction!.basinShape,
    originalCandidate.evidence.basinShape?.value ?? defaults.basinShape,
  );
  assert.equal(
    fixture.reconstruction!.provenance!.shape,
    originalCandidate.evidence.basinShape ? 'inferred' : 'default',
  );
  assert.deepEqual(applied.evidence, originalCandidate.evidence);
  assert.deepEqual(fixture.reconstruction!.colorEvidence, originalCandidate.colorEvidence);
  assert.deepEqual(applied.colorEvidence, originalCandidate.colorEvidence);
  assert.equal(fixture.reconstruction!.provenance!.color, originalCandidate.colorEvidence!.source);
  assert.equal(applied.installation?.source, 'user');
  assert.equal(applied.installation?.wall, 'left');
  assert.equal(applied.placementReview?.status, 'accepted');
  const saved = (await page.evaluate(
    async (origin) => (await import(origin + '/bundle.js')).save(),
    origin,
  )) as ProjectDocument;
  await page.reload();
  const reloaded = (await page.evaluate(
    async ({ origin, id }) => (await import(origin + '/bundle.js')).reloadSaved(id),
    { origin, id: saved.id },
  )) as Inspection;
  assert.deepEqual(before(reloaded).fixtures, before(added).fixtures);
  assert.deepEqual(candidates(reloaded), candidates(added));
  assert(
    reloaded.project.designs.every(
      (design) =>
        design.scene.fixtures.length === 0 &&
        design.scene.surfaces.every((surface) => !surface.materialVersionId),
    ),
  );
  await page
    .locator('[data-candidate-id="' + candidateId + '"]')
    .screenshot({ path: output + '/saved-basin.png' });
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
      'Actual user-01 cached DeepLab basin, no placementReview and unknown installation wall, default proposal UI then explicit actor left wall and picture click. Not automatic recognition or placement success. No new AI. Explicit repository save, not autosave timing.',
    sourceReport: reportPath,
    sourceReportSha256: hash(reportBytes),
    inputSha256: input.sha256,
    sourceHashes,
    sourceHashesUnchanged: true,
    browser: browser.version(),
    rendering: 'Chrome headless / SwiftShader',
    candidateId,
    originalCandidate,
    initialProposalMissing: true,
    defaultPositionNotice: true,
    defaultBaseHeightMm: 650,
    faceChangeHeightConsistent: true,
    actorInputs: { face: 'left', picture: [selectedU, selectedV], selectedHeight },
    previewDoesNotCommit: true,
    initialFixtureCount: before(initial).fixtures.length,
    afterFixtureCount: before(added).fixtures.length,
    dimensionsDefault: true,
    rawAndEvidenceUnchanged: true,
    storedProjectId: saved.id,
    reloadedFixture: before(reloaded).fixtures[0],
    afterEmpty: true,
    pageErrors,
    external,
    workers,
  };
  await writeFile(output + '/verification.json', JSON.stringify(verification, null, 2));
  await writeFile(output + '/initial-project.json', JSON.stringify(initial.project, null, 2));
  await writeFile(output + '/saved-project.json', JSON.stringify(saved, null, 2));
  console.log(
    JSON.stringify({
      candidateId,
      initial: 0,
      added: 1,
      baseHeight: selectedHeight,
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
