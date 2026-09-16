/** Synthetic state + real ManualPlacementEditor/WallAlignment UI. No AI, source photos, full app or renderer quality claim. */
import { chromium, expect, type Page, type Locator } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { LabManualDraft } from '../src/lib/reconstruction/lab-correction';
import type { LabWallReference } from '../src/components/reconstruction/lab-wall-alignment';

const outputRoot = 'test-results/reconstruction-wall-alignment-ui-20260913';
let run = 1;
while (
  await stat(`${outputRoot}/run-${String(run).padStart(2, '0')}`)
    .then(() => true)
    .catch(() => false)
)
  run++;
const output = `${outputRoot}/run-${String(run).padStart(2, '0')}`;
await mkdir(output, { recursive: true });
const sourcePaths = [
  'src/components/reconstruction/lab-wall-alignment.tsx',
  'src/components/reconstruction/manual-placement-editor.tsx',
  'src/lib/reconstruction/wall-alignment.ts',
  'src/lib/reconstruction/lab-correction.ts',
  'src/lib/reconstruction/lab-manual-placement.ts',
  'src/components/reconstruction/placement-picker.tsx',
  'src/lib/reconstruction/source-camera.ts',
  'src/lib/reconstruction/projection.ts',
  'src/lib/room-geometry.ts',
  'src/components/reconstruction/reconstruction-lab.module.css',
  'tests/reconstruction-wall-alignment-browser.ts',
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  );
const sourceHashesBefore = await hashes();
const bundled = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ManualPlacementEditor} from './src/components/reconstruction/manual-placement-editor';
const room={kind:'parametric',version:1,widthMm:2400,depthMm:3000,heightMm:2400};
const initial=()=>({enabled:false,face:'floor',u:'0.5',v:'0.5',baseHeightMm:'0',widthMm:'',heightMm:'',depthMm:'',yawDegrees:'0'});
const references=()=>[
 {id:'known-wall',label:'합성 벽걸이 세면대',wall:'back',plan:{kind:'basin',version:2,face:'back',u:.45,v:1-650/2400,baseHeightMm:650,widthMm:600,heightMm:200,depthMm:480,yawDegrees:0}},
 {id:'floor-left',label:'합성 왼쪽 하부장',wall:'left',plan:{kind:'vanity',version:2,face:'floor',u:.15,v:.4,baseHeightMm:0,widthMm:900,heightMm:850,depthMm:550,yawDegrees:90}},
 {id:'unknown-wall',label:'합성 설치 벽 미확정 하부장',plan:{kind:'vanity',version:2,face:'floor',u:.5,v:.4,baseHeightMm:0,widthMm:900,heightMm:850,depthMm:550,yawDegrees:0}},
 {id:'diagonal',label:'합성 대각 방향 하부장',wall:'left',plan:{kind:'vanity',version:2,face:'floor',u:.5,v:.5,baseHeightMm:0,widthMm:900,heightMm:850,depthMm:550,yawDegrees:45}},
 {id:'held',label:'합성 보류 세면대',reason:'합성 기준 설비의 배치가 아직 보류돼 있어요.'}
];
function Harness(){
 const[value,setValue]=useState(initial),[refs,setRefs]=useState(references),[disabled,setDisabled]=useState(false),[events,setEvents]=useState([]),[generation,setGeneration]=useState(0),[kind,setKind]=useState('mirror');
 const defaults=kind==='wallShelf'?{widthMm:700,heightMm:30,depthMm:250}:kind==='mirrorCabinet'?{widthMm:700,heightMm:600,depthMm:150}:{widthMm:700,heightMm:600,depthMm:30};
 return <main><h1>합성 입력 · 실제 벽 정렬 UI 검증</h1><p>아래 부모 관리 버튼은 하네스 상태 변경용입니다. 설비 관측이나 AI 실행이 아닙니다.</p>
 <section aria-label="검증 하네스"><button onClick={()=>{setValue(initial());setRefs(references());setDisabled(false);setEvents([]);setKind('mirror');setGeneration(n=>n+1)}}>하네스 초기화</button>
 <button onClick={()=>setRefs(items=>items.map(item=>item.id===(value.positionReference?.candidateId??'known-wall')&&item.plan?{...item,plan:{...item.plan,u:.7}}:item))}>하네스 기준 설비 이동</button>
 <button onClick={()=>setRefs(items=>items.filter(item=>item.id!==(value.positionReference?.candidateId??'known-wall')))}>하네스 기준 설비 삭제</button>
 <label><input aria-label="하네스 비활성화" type="checkbox" checked={disabled} onChange={e=>setDisabled(e.target.checked)}/>컴포넌트 비활성화</label>
 <label>대상 종류<select aria-label="하네스 대상 종류" value={kind} onChange={e=>setKind(e.target.value)}><option value="mirror">거울</option><option value="mirrorCabinet">거울장</option><option value="wallShelf">벽 선반</option></select></label></section>
 <section data-testid="production-editor"><ManualPlacementEditor key={generation} value={value} kind={kind} defaults={defaults} room={room} wallReferences={refs} prefix="합성 대상" disabled={disabled} onChange={next=>{setEvents(prior=>[...prior,structuredClone(next)]);setValue(next)}}/></section>
 <details><summary>검증용 상태 스냅샷</summary><pre data-testid="harness-state">{JSON.stringify({value,events,references:refs,disabled,kind})}</pre></details></main>
}
createRoot(document.getElementById('root')).render(<Harness/>);
`,
  },
  bundle: true,
  write: false,
  outfile: 'bundle.js',
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
});
const js = bundled.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
const css = bundled.outputFiles.find((f) => f.path.endsWith('.css'))!.text;
const server = createServer((req, res) => {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end('No model or mutation endpoints');
    return;
  }
  if (req.url === '/bundle.js') {
    res.setHeader('Content-Type', 'text/javascript').end(js);
    return;
  }
  if (req.url === '/bundle.css') {
    res.setHeader('Content-Type', 'text/css').end(css);
    return;
  }
  if (req.url !== '/') {
    res.statusCode = 404;
    res.end('No external assets or models');
    return;
  }
  res
    .setHeader('Content-Type', 'text/html')
    .end(
      '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>body{font:15px system-ui;color:#24312f;margin:20px;background:#f6f6f2}main{max-width:1100px}button,input,select{font:inherit}section[aria-label]{padding:12px;background:#fff3ce;margin:15px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>',
    );
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
type HarnessState = {
  value: LabManualDraft;
  events: LabManualDraft[];
  references: LabWallReference[];
  disabled: boolean;
  kind: string;
};
const errors: string[] = [],
  external: string[] = [],
  requests: { url: string; method: string }[] = [],
  records: object[] = [];
let page: Page | undefined;
const snapshot = async (): Promise<HarnessState> =>
  JSON.parse((await page!.getByTestId('harness-state').textContent()) ?? '{}');
const align = () => page!.getByTestId('wall-alignment');
const apply = () => page!.getByRole('button', { name: '합성 대상 위에 위치 맞추기', exact: true });
const gap = () => page!.getByLabel('합성 대상 위 간격 mm', { exact: true });
const reset = async () => {
  await page!.getByRole('button', { name: '하네스 초기화', exact: true }).click();
  await align().locator('summary').click();
};
const select = async (id: string) =>
  page!.getByLabel('합성 대상 위치 참고 설비', { exact: true }).selectOption(id);
const field = (name: string) => page!.getByLabel('합성 대상 ' + name, { exact: true });
const record = async (name: string, details: object = {}) => {
  records.push({ name, ...details, state: await snapshot() });
  console.log(JSON.stringify({ check: name, status: 'passed' }));
};
const disabledNoAction = async (control: Locator) => {
  await expect(control).toBeDisabled();
  const before = await snapshot();
  await control.evaluate((element) => (element as HTMLButtonElement).click());
  assert.deepEqual(await snapshot(), before, 'Disabled native click must not update draft or emit onChange');
};
try {
  page = await browser.newPage({ viewport: { width: 1400, height: 1050 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }));
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin && route.request().method() === 'GET')
      await route.continue();
    else {
      external.push(route.request().url());
      await route.abort();
    }
  });
  await page.addInitScript(() => {
    Object.assign(window, { wallAlignmentWorkerAttempts: 0 });
    window.Worker = new Proxy(window.Worker, {
      construct() {
        const state = window as unknown as { wallAlignmentWorkerAttempts: number };
        state.wallAlignmentWorkerAttempts++;
        throw Error('New model/worker execution is forbidden in this synthetic UI test');
      },
    });
  });
  await page.goto(origin);
  await align().locator('summary').click();
  await disabledNoAction(apply());
  await select('known-wall');
  await expect(gap()).toHaveValue('150');
  await expect(align()).toContainText('기본값');
  await expect(field('맞출 벽')).toHaveValue('back');
  await expect(field('맞출 벽')).toBeDisabled();
  await expect(apply()).toBeEnabled();
  const before = await snapshot();
  await apply().click();
  const copied = await snapshot();
  assert.equal(
    copied.events.length - before.events.length,
    1,
    'Wall/u/height copy is one atomic draft event',
  );
  assert.equal(copied.value.face, 'back');
  assert.equal(Number(copied.value.u), 0.45);
  assert.equal(Number(copied.value.v), 1 - 1000 / 2400);
  assert.equal(Number(copied.value.baseHeightMm), 1000);
  assert.equal(copied.value.enabled, true);
  assert.equal(copied.value.positionReference!.gapSource, 'default');
  assert.equal(copied.value.positionReference!.gapMm, 150);
  assert.deepEqual(
    copied.value.positionReference!.parent,
    before.references.find((ref) => ref.id === 'known-wall')!.plan,
  );
  for (const label of ['폭 mm', '높이 mm', '깊이 mm']) {
    await expect(field(label)).toHaveValue('');
    await expect(field(label)).toHaveAttribute('placeholder', '기본값 유지');
  }
  assert.deepEqual([copied.value.widthMm, copied.value.heightMm, copied.value.depthMm], ['', '', '']);
  await expect(field('수동 위치 지정')).toBeChecked();
  await expect(align().getByTestId('wall-alignment-history')).toContainText('복사한 위치를 사용 중');
  await page.screenshot({ path: output + '/default-copy.png', fullPage: true });
  await record('known-wall-default-copy-atomic-blank-dimensions');

  await gap().fill('250');
  await apply().click();
  const manualGap = await snapshot();
  assert.equal(manualGap.value.positionReference!.gapSource, 'user');
  assert.equal(manualGap.value.positionReference!.gapMm, 250);
  assert.equal(Number(manualGap.value.baseHeightMm), 1100);
  await expect(align().getByTestId('wall-alignment-history')).toContainText('250mm (사용자 입력)');
  await record('custom-gap-user-provenance');
  await gap().fill('0');
  await apply().click();
  assert.equal(Number((await snapshot()).value.baseHeightMm), 850);
  assert.equal((await snapshot()).value.positionReference!.gapSource, 'user');
  await record('zero-gap-is-explicit-user-input');

  const fixed = await snapshot();
  await page.getByRole('button', { name: '하네스 기준 설비 이동', exact: true }).click();
  assert.deepEqual((await snapshot()).value, fixed.value);
  assert.equal((await snapshot()).events.length, fixed.events.length);
  assert.equal((await snapshot()).references.find((ref) => ref.id === 'known-wall')!.plan!.u, 0.7);
  assert.equal((await snapshot()).value.positionReference!.parent.u, 0.45);
  await record('parent-move-preserves-child-and-parent-snapshot');
  await page.getByRole('button', { name: '하네스 기준 설비 삭제', exact: true }).click();
  assert.deepEqual((await snapshot()).value, fixed.value);
  await disabledNoAction(apply());
  await expect(field('위치 참고 설비')).toHaveValue('known-wall');
  await expect(field('위치 참고 설비')).toContainText('기존 설비 없음');
  await record('parent-delete-preserves-child-and-blocks-reapply');
  await field('가로 위치 u').fill('.55');
  await expect(align().getByTestId('wall-alignment-history')).toContainText('복사 이후 위치를 직접 수정');
  assert.equal(Number((await snapshot()).value.u), 0.55);
  assert.equal((await snapshot()).value.positionReference!.result.u, 0.45);
  await page.screenshot({ path: output + '/historical-copy-after-parent-delete.png', fullPage: true });
  await record('direct-position-edit-keeps-historical-notice');

  await reset();
  await select('known-wall');
  await apply().click();
  await field('폭 mm').fill('3000');
  await disabledNoAction(apply());
  await expect(align().getByRole('status')).toContainText('놓을 수 없어요');
  assert.equal((await snapshot()).value.widthMm, '3000');
  await record('oversized-width-held-without-resize');
  await field('폭 mm').fill('');
  for (const invalid of ['', '-10']) {
    await gap().fill(invalid);
    await disabledNoAction(apply());
    await record(invalid === '' ? 'blank-gap-held' : 'negative-gap-held');
  }
  await reset();
  await select('unknown-wall');
  await expect(field('맞출 벽')).toHaveValue('');
  await disabledNoAction(apply());
  await expect(align()).toContainText('기본 회전만으로 벽을 정하지');
  await record('unknown-wall-not-inferred-from-default-yaw');
  await field('맞출 벽').selectOption('left');
  await disabledNoAction(apply());
  await expect(align().getByRole('status')).toContainText('방향');
  await record('explicit-wall-conflicting-with-floor-yaw-held');
  await field('맞출 벽').selectOption('back');
  await expect(apply()).toBeEnabled();
  await apply().click();
  assert.equal((await snapshot()).value.positionReference!.wall, 'back');
  await record('explicit-confirmed-wall-can-enable-aligned-floor-parent');
  await reset();
  await select('diagonal');
  await disabledNoAction(apply());
  await expect(align().getByRole('status')).toContainText('방향');
  await record('diagonal-floor-parent-not-rotated');
  await reset();
  await select('held');
  await disabledNoAction(apply());
  await expect(align().getByRole('status')).toContainText('아직 보류');
  await record('unplaced-parent-held');

  await reset();
  await select('floor-left');
  await apply().click();
  const left = await snapshot();
  assert.equal(left.value.face, 'left');
  assert.equal(Number(left.value.u), 0.6);
  assert.equal(Number(left.value.baseHeightMm), 1000);
  assert.equal(left.value.positionReference!.wall, 'left');
  await record('left-floor-parent-coordinate-orientation');
  for (const kind of ['mirrorCabinet', 'wallShelf']) {
    await reset();
    await page.getByLabel('하네스 대상 종류', { exact: true }).selectOption(kind);
    await select('known-wall');
    await apply().click();
    assert.equal((await snapshot()).kind, kind);
    assert.equal((await snapshot()).value.enabled, true);
    assert.deepEqual(
      [(await snapshot()).value.widthMm, (await snapshot()).value.heightMm, (await snapshot()).value.depthMm],
      ['', '', ''],
    );
    await record(kind + '-uses-real-editor-and-retains-default-dimensions');
  }
  await reset();
  await select('known-wall');
  await expect(apply()).toBeEnabled();
  await page.getByLabel('하네스 비활성화', { exact: true }).check();
  for (const control of [field('위치 참고 설비'), gap(), field('수동 위치 지정')])
    await expect(control).toBeDisabled();
  await disabledNoAction(apply());
  assert.equal((await snapshot()).events.length, 0);
  await page.screenshot({ path: output + '/disabled-controls.png', fullPage: true });
  await record('disabled-component-no-actions');
  const workerAttempts = await page.evaluate(
    () => (window as unknown as { wallAlignmentWorkerAttempts: number }).wallAlignmentWorkerAttempts,
  );
  assert.equal(workerAttempts, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const sourceHashesAfter = await hashes();
  assert.deepEqual(
    sourceHashesAfter,
    sourceHashesBefore,
    'Source changed during independent UI verification',
  );
  const verification = {
    status: 'passed',
    at: new Date().toISOString(),
    scope:
      'Synthetic references/draft; actual production ManualPlacementEditor and LabWallAlignment, standalone esbuild/Chrome. No AI quality, full Lab assembly, project persistence, photograph or model rendering claim.',
    checks: records.length,
    records,
    sourceHashesBefore,
    sourceHashesAfter,
    workerAttempts,
    newModelCalls: 0,
    errors,
    external,
    requests,
    actionScope:
      'Harness-only parent move/delete changes input references. All copy, gap, dimensions and direct location operations use production UI events.',
  };
  await writeFile(output + '/verification.json', JSON.stringify(verification, null, 2));
  console.log(
    JSON.stringify({
      status: 'passed',
      checks: records.length,
      output,
      workerAttempts,
      externalRequests: external.length,
      pageErrors: errors.length,
      sourceHashesUnchanged: true,
    }),
  );
} catch (error) {
  if (page) await page.screenshot({ path: output + '/failure.png', fullPage: true }).catch(() => {});
  await writeFile(
    output + '/failure.json',
    JSON.stringify(
      {
        status: 'failed',
        error: String(error),
        records,
        sourceHashesBefore,
        sourceHashesAfter: await hashes(),
        errors,
        external,
        requests,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
