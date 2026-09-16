/** Actual React interaction and saved-report reuse only. Fixture/relationship edits are user test inputs, not AI detections. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionLabReport } from '../src/lib/reconstruction/lab';
const output = 'test-results/reconstruction-lab-relations';
const fixture: SceneUnderstanding = {
  schemaVersion: 1,
  roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  candidates: [
    {
      id: 'bowl',
      kind: 'basin',
      mounting: 'countertop',
      wall: 'left',
      basinStyle: 'unknown',
      shape: 'round',
      reflection: 'physical',
      bounds: { left: 0.2, top: 0.3, right: 0.5, bottom: 0.5 },
      evidence: ['Deliberate user test fixture'],
      uncertainty: [],
    },
    {
      id: 'cabinet',
      kind: 'vanity',
      mounting: 'floor',
      wall: 'left',
      basinStyle: 'unknown',
      shape: 'round',
      reflection: 'physical',
      bounds: { left: 0.15, top: 0.4, right: 0.6, bottom: 0.9 },
      evidence: ['Deliberate user test fixture'],
      uncertainty: [],
    },
    {
      id: 'bad-parent',
      kind: 'vanity',
      mounting: 'ceiling',
      wall: 'left',
      basinStyle: 'unknown',
      shape: 'round',
      reflection: 'physical',
      bounds: { left: 0.15, top: 0.4, right: 0.6, bottom: 0.9 },
      evidence: ['Deliberate invalid parent'],
      uncertainty: [],
    },
    {
      id: 'mirror-copy',
      kind: 'mirror',
      mounting: 'wall',
      wall: 'back',
      basinStyle: 'unknown',
      shape: 'rectangular',
      reflection: 'reflected',
      bounds: { left: 0.05, top: 0.01, right: 0.3, bottom: 0.25 },
      evidence: ['Deliberate incorrect reflection fixture'],
      uncertainty: [],
    },
    {
      id: 'mirror-real',
      kind: 'mirror',
      mounting: 'wall',
      wall: 'right',
      basinStyle: 'unknown',
      shape: 'rectangular',
      reflection: 'physical',
      bounds: { left: 0.65, top: 0.01, right: 0.9, bottom: 0.25 },
      evidence: ['Deliberate fixture'],
      uncertainty: [],
    },
  ],
  relations: [
    {
      frontId: 'mirror-copy',
      behindId: 'mirror-real',
      relation: 'reflectionOf',
      evidence: ['Deliberate incorrect relationship'],
    },
  ],
};
const code = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LabRelationControls} from './src/components/reconstruction/lab-relation-controls';
import {applyLabRelationEdits} from './src/lib/reconstruction/lab-relations';
import {validateUserUnderstanding} from './src/lib/reconstruction/scene-understanding';
export {applyLabRelationEdits,validateUserUnderstanding};
export function mount(observed) {
 const original=JSON.stringify(observed);
 function App(){
  const [effective,setEffective]=useState(structuredClone(observed));
  const [edits,setEdits]=useState({}); const [disabled,setDisabled]=useState(false);
  const [applied,setApplied]=useState(null);
  return <main><h1>사용자 관계 보정 UI 검증</h1><p>테스트 입력이며 AI 인식 성공이 아닙니다.</p>
   <button onClick={()=>setEffective(current=>({...current,candidates:current.candidates.map(item=>item.id==='mirror-copy'?{...item,reflection:'physical'}:item)}))}>거울을 실제 물체로 확인</button>
   <button onClick={()=>setDisabled(!disabled)}>잠금 전환</button>
   <LabRelationControls observed={observed} effective={effective} edits={edits} disabled={disabled} onChange={setEdits}/>
   <button onClick={()=>setApplied(validateUserUnderstanding(applyLabRelationEdits(effective,edits),observed))}>교정 관계 확정</button>
   <output data-testid="draft">{JSON.stringify(edits)}</output>
   <output data-testid="applied">{JSON.stringify(applied)}</output>
   <output data-testid="original-unchanged">{String(JSON.stringify(observed)===original)}</output>
  </main>;
 }
 createRoot(document.getElementById('root')).render(<App/>);
}
`;
const bundle = await build({
  stdin: { contents: code, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true,
  write: false,
  outfile: 'bundle.js',
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
});
const js = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
const server = createServer((request, response) => {
  if (request.url === '/bundle.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(js);
  } else if (request.url === '/bundle.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end(css);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<html lang="ko"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>body{margin:12px;font:16px sans-serif}main{max-width:750px}button{margin:5px;padding:8px}output{display:block;overflow-wrap:anywhere;max-height:130px;overflow:auto}select{max-width:100%}</style><div id="root"></div></html>',
    );
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(origin);
  await page.evaluate(
    async ({ fixture, origin }) => {
      const url = origin + '/bundle.js';
      const relationModule = await import(url);
      relationModule.mount(fixture);
    },
    { fixture, origin },
  );
  await page.getByText('부품·가림·반사 관계 확인 · 원래 관계 1개', { exact: true }).click();
  await page.getByRole('button', { name: '거울을 실제 물체로 확인', exact: true }).click();
  await page
    .getByRole('button', { name: 'mirror-copy:reflectionOf:mirror-real 관계 해제 전환', exact: true })
    .click();
  await page.getByLabel('bowl 하부장 선택', { exact: true }).selectOption('bad-parent');
  assert.match((await page.getByRole('alert').first().textContent())!, /부모는 바닥 또는 벽/);
  await page.getByLabel('bowl 하부장 선택', { exact: true }).selectOption('cabinet');
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByRole('button', { name: '교정 관계 확정', exact: true }).click();
  const applied = JSON.parse((await page.getByTestId('applied').textContent())!) as SceneUnderstanding;
  assert.equal(applied.relations.length, 1);
  assert.equal(applied.relations[0].relation, 'partOf');
  assert.equal(applied.relations[0].provenance, 'user');
  assert.equal(applied.relations[0].behindId, 'cabinet');
  assert.equal(applied.candidates.find((c) => c.id === 'mirror-copy')!.reflection, 'physical');
  assert.equal(applied.candidates.find((c) => c.id === 'mirror-copy')!.validation, undefined);
  assert.equal(await page.getByTestId('original-unchanged').textContent(), 'true');
  const draft = await page.getByTestId('draft').textContent();
  await page.getByRole('button', { name: '잠금 전환', exact: true }).click();
  assert.equal(await page.getByLabel('bowl 하부장 선택').isDisabled(), true);
  assert.equal(
    await page
      .getByRole('button', { name: 'mirror-copy:reflectionOf:mirror-real 관계 해제 전환' })
      .isDisabled(),
    true,
  );
  assert.equal(await page.getByTestId('draft').textContent(), draft);
  await page.getByRole('button', { name: '잠금 전환', exact: true }).click();
  await page.getByRole('button', { name: '부모 선택 취소', exact: true }).click();
  assert.equal(await page.getByLabel('bowl 하부장 선택').inputValue(), '');
  await page.getByLabel('bowl 하부장 선택').selectOption('cabinet');
  await page.getByLabel('bowl 하부장 선택').selectOption('');
  assert.equal(JSON.parse((await page.getByTestId('draft').textContent())!).supportParents.bowl, null);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: output + '/mobile-relations.png', fullPage: true });
  // Reuse the previously measured real model report when it is available locally; no inference is performed.
  const savedPath =
    process.env.SJN_RELATION_REUSE_REPORT ??
    'test-results/user-reconstruction-improvement-20260913/after-inventory/user-04/candidate.json';
  let saved: ReconstructionLabReport | undefined;
  try {
    saved = JSON.parse(await readFile(savedPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let reuse: unknown = { status: 'not-run', reason: 'No private saved report supplied' };
  if (saved?.pipeline) {
    const before = JSON.stringify(saved);
    const parent = saved.pipeline.understanding.candidates.find((c) => c.kind === 'vanity');
    if (parent) {
      reuse = await page.evaluate(
        async ({ saved, parentId, origin }) => {
          const url = origin + '/bundle.js';
          const relationModule = await import(url);
          const automatic = saved.pipeline!.understanding;
          const user = structuredClone(automatic);
          const parent = user.candidates.find((c) => c.id === parentId)!;
          parent.mounting = 'floor';
          parent.wall = 'left';
          parent.reflection = 'physical';
          parent.provenance = { ...parent.provenance, mounting: 'user', wall: 'user' };
          const bounds = parent.bounds;
          user.candidates.push({
            id: 'user-bowl',
            kind: 'basin',
            mounting: 'countertop',
            wall: 'left',
            basinStyle: 'unknown',
            shape: 'round',
            bowlCount: 1,
            reflection: 'physical',
            bounds: { ...bounds },
            evidence: ['Explicit user component input for relationship replay, not an AI detection'],
            uncertainty: ['Bounds copied from parent for this functional test; not a measured bowl contour'],
            provenance: {
              kind: 'user',
              mounting: 'user',
              shape: 'user',
              bowlCount: 'user',
              position: 'user',
            },
          });
          const linked = relationModule.applyLabRelationEdits(user, {
            supportParents: { 'user-bowl': parentId },
          });
          const confirmed = relationModule.validateUserUnderstanding(linked, automatic) as SceneUnderstanding;
          return {
            scope:
              'Saved actual model observation plus explicit user-added bowl and parent mounting confirmation; no AI quality claim',
            modelRawPreserved: saved.pipeline!.model.rawText,
            confirmed,
          };
        },
        { saved, parentId: parent.id, origin },
      );
      assert.equal(JSON.stringify(saved), before);
      const proof = reuse as { modelRawPreserved: string; confirmed: SceneUnderstanding };
      assert.equal(proof.modelRawPreserved, saved.pipeline.model.rawText);
      assert.equal(
        proof.confirmed.relations.some((r) => r.frontId === 'user-bowl' && r.behindId === parent.id),
        true,
      );
      assert.equal(proof.confirmed.candidates.find((c) => c.id === 'user-bowl')?.validation, undefined);
      assert.equal(proof.confirmed.relations.find((r) => r.frontId === 'user-bowl')?.provenance, 'user');
    }
  }
  assert.deepEqual(errors, []);
  assert.equal(
    requests.every((url) => url.startsWith(origin)),
    true,
  );
  const result = {
    scope: 'User relation controls and saved-report validation, not automatic inference success',
    browser: browser.version(),
    checks: [
      'reflection unlink plus physical confirmation',
      'valid parent',
      'invalid parent rejection',
      'remove/cancel parent',
      'disabled controls',
      'mobile overflow',
      'original immutability',
    ],
    aiRequests: 0,
    requests,
    errors,
    reuse,
  };
  await writeFile(output + '/verification.json', JSON.stringify(result, null, 2));
  await writeFile(output + '/applied-test-relations.json', JSON.stringify(applied, null, 2));
  console.log(JSON.stringify({ output, checks: result.checks, aiRequests: 0, errors }));
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
