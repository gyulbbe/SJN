/** Saved real regression observation + its explicit user parent placement, production placement UI. No AI accuracy claim. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { LabManualDraft } from '../src/lib/reconstruction/lab-correction';

const source =
  'test-results/reconstruction-lab-regression-correction-20260913/run-02-alignment/corrected.json';
const bytes = await readFile(source);
const saved = JSON.parse(bytes.toString('utf8'));
const report = saved.analysis;
const original = report.pipeline.model.understanding;
const current = structuredClone(report.pipeline.understanding);
// Before the historical mirror copy: preserve its actual observed fields; keep the basin's already confirmed support/position.
current.candidates = current.candidates.map((candidate: { id: string }) =>
  candidate.id === 'item_03'
    ? structuredClone(original.candidates.find((item: { id: string }) => item.id === candidate.id))
    : candidate,
);
const prior = report.correctionSnapshot.draft.manual.item_03.positionReference;
const seed = {
  current,
  original,
  sourceKey: report.inputFingerprint,
  room: report.room,
  parent: {
    id: prior.candidateId,
    label: '세면대 · 사진 2 · ' + prior.candidateId,
    wall: prior.wall,
    plan: prior.parent,
  },
};
assert.equal(seed.sourceKey, '6ac1ccfc722a967012fd303ffe60e0c861d03339efe0f1248838a9cdf094a233');
const output =
  'test-results/reconstruction-installation-suggestions-20260914/' +
  new Date().toISOString().replaceAll(/[:.]/g, '-');
await mkdir(output, { recursive: true });
const sourcePaths = [
  'src/lib/reconstruction/wall-alignment-suggestions.ts',
  'src/components/reconstruction/lab-wall-alignment.tsx',
  'src/components/reconstruction/manual-placement-editor.tsx',
  'src/lib/reconstruction/wall-alignment.ts',
  'src/lib/reconstruction/lab-correction.ts',
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
const beforeHashes = await hashes();
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ManualPlacementEditor} from './src/components/reconstruction/manual-placement-editor';
import {wallAlignmentObservation} from './src/lib/reconstruction/wall-alignment-suggestions';
const seed=${JSON.stringify(seed)};
const initial=()=>({enabled:false,face:'floor',u:'0.5',v:'0.5',baseHeightMm:'0',widthMm:'',heightMm:'',depthMm:'',yawDegrees:'0'});
function Harness(){
 const[value,setValue]=useState(initial),[events,setEvents]=useState([]),[references,setReferences]=useState([seed.parent]),[disabled,setDisabled]=useState(false),[generation,setGeneration]=useState(0);
 const observation=wallAlignmentObservation(seed.current,seed.original,'item_03',seed.sourceKey);
 return <main><h1>실제 저장 관측 · 위치 참고 후보</h1><p>원모델 관측은 유지하고 이전 사용자 확인 세면대 위치를 참고해요. 이 화면은 AI를 실행하지 않아요.</p>
 <section aria-label="검증용 상태 조작"><button onClick={()=>{setValue(initial());setEvents([]);setReferences([seed.parent]);setDisabled(false);setGeneration(n=>n+1)}}>초기화</button>
 <button onClick={()=>setReferences(items=>items.map(item=>({...item,plan:{...item.plan,u:.5}})))}>부모 이동</button>
 <button onClick={()=>setReferences([])}>부모 삭제</button><button onClick={()=>setDisabled(true)}>잠금</button>
 <button onClick={()=>setValue(v=>({...v,widthMm:'5000'}))}>범위 초과 규격</button></section>
 <ManualPlacementEditor key={generation} value={value} kind="mirror" defaults={{widthMm:600,heightMm:800,depthMm:25}}
  room={seed.room} prefix="관측 거울" disabled={disabled} wallObservation={observation} wallReferences={references}
  onChange={next=>{setValue(next);setEvents(prior=>[...prior,structuredClone(next)])}}/>
 <pre data-testid="state">{JSON.stringify({value,events,original:seed.original})}</pre></main>
}createRoot(document.getElementById('root')).render(<Harness/>);`,
  },
  bundle: true,
  write: false,
  outfile: 'bundle.js',
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
});
const js = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') return void res.setHeader('Content-Type', 'text/javascript').end(js);
  if (req.url === '/bundle.css') return void res.setHeader('Content-Type', 'text/css').end(css);
  if (req.url !== '/') return void res.writeHead(404).end();
  res
    .setHeader('Content-Type', 'text/html')
    .end(
      '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>body{font:15px system-ui;background:#f5f5f1;color:#23332f;margin:16px}main{max-width:1100px}button,input,select{font:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere}section[aria-label="검증용 상태 조작"]{background:#fff2ca;padding:12px}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>',
    );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors: string[] = [],
  unexpectedRequests: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', async (route) => {
  if (new URL(route.request().url()).origin === origin && route.request().method() === 'GET')
    return route.continue();
  unexpectedRequests.push(route.request().url());
  await route.abort();
});
await page.addInitScript(() => {
  window.Worker = new Proxy(window.Worker, {
    construct() {
      throw Error('AI/Worker disabled for saved-observation UI verification');
    },
  });
});
const state = async (): Promise<{ value: LabManualDraft; events: LabManualDraft[]; original: unknown }> =>
  JSON.parse((await page.getByTestId('state').textContent())!);
const apply = () => page.getByRole('button', { name: '관측 거울 추천 item_02 위치 확인', exact: true });
const checks: string[] = [];
try {
  await page.goto(origin);
  await page.getByTestId('wall-alignment').locator('summary').click();
  await expect(apply()).toBeEnabled();
  await expect(page.getByTestId('wall-alignment-suggestions')).toContainText('사진 2');
  await expect(page.getByTestId('wall-alignment-suggestions')).toContainText('기본값');
  assert.equal((await state()).value.enabled, false);
  assert.equal((await state()).events.length, 0);
  checks.push('suggestion-pending-until-user-click');
  await page.screenshot({ path: output + '/before-choice.png', fullPage: true });
  await apply().focus();
  await page.keyboard.press('Enter');
  const applied = await state();
  assert.equal(applied.events.length, 1);
  assert.equal(applied.value.face, 'back');
  assert.equal(applied.value.u, '0.28');
  assert.equal(applied.value.baseHeightMm, '1120');
  assert.deepEqual([applied.value.widthMm, applied.value.heightMm, applied.value.depthMm], ['', '', '']);
  assert.equal(applied.value.positionReference?.gapSource, 'default');
  assert.equal(applied.value.positionReference?.recommendation?.confirmation, 'user');
  assert.equal(applied.value.positionReference?.recommendation?.source, 'inferred');
  assert.equal(applied.value.positionReference?.recommendation?.targetWall, 'unknown');
  assert.deepEqual(applied.original, original);
  checks.push('keyboard-one-atomic-copy-not-camera-left-wall');
  checks.push('blank-dimensions-retain-default-provenance');
  checks.push('model-unchanged-inferred-recommendation-user-confirmed');
  await page.getByRole('button', { name: '부모 이동', exact: true }).click();
  assert.deepEqual((await state()).value, applied.value);
  await page.getByRole('button', { name: '부모 삭제', exact: true }).click();
  assert.deepEqual((await state()).value, applied.value);
  await expect(apply()).toHaveCount(0);
  checks.push('snapshot-not-live-parent-link');
  await page.getByRole('button', { name: '초기화', exact: true }).click();
  await page.getByTestId('wall-alignment').locator('summary').click();
  await page.getByRole('button', { name: '범위 초과 규격', exact: true }).click();
  await expect(apply()).toBeDisabled();
  assert.equal((await state()).events.length, 0);
  assert.equal((await state()).value.widthMm, '5000');
  checks.push('overflow-held-no-shrink-no-move');
  await page.getByRole('button', { name: '초기화', exact: true }).click();
  await page.getByTestId('wall-alignment').locator('summary').click();
  await page.getByRole('button', { name: '잠금', exact: true }).click();
  await expect(apply()).toBeDisabled();
  checks.push('read-only-no-apply');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: output + '/mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  checks.push('mobile-390-no-overflow');
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  const result = {
    status: 'passed',
    source,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceInputFingerprint: seed.sourceKey,
    scope:
      'Saved real model bbox/relationships + historically user-confirmed basin placement; actual production manual placement UI. No new AI, renderer, full Lab persistence or human minimum-click claim.',
    caseId: 'prospective-03',
    exposure: 'previously evaluated now development regression',
    checks,
    errors,
    unexpectedRequests,
    browser: browser.version(),
    sourceHashesBefore: beforeHashes,
    sourceHashesAfter: await hashes(),
    applied,
  };
  await writeFile(output + '/verification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, status: result.status, checks: checks.length }));
} catch (error) {
  await writeFile(
    output + '/failure.json',
    JSON.stringify({ error: String(error), errors, unexpectedRequests, checks }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
