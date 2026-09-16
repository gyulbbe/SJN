/** Real browser controls; entered distances are functional test values, not photo measurements. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const output = 'test-results/reconstruction-wall-distance-drag-20260913';
const bundle = await build({
  stdin: {
    contents: `
import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
import {ManualPlacementEditor} from './src/components/reconstruction/manual-placement-editor';
import {resolveManualDraft} from './src/lib/reconstruction/lab-manual-placement';
import {DEFAULT_ROOM} from './src/lib/room-geometry';
function App(){const [draft,setDraft]=useState({enabled:true,face:'floor',u:'.5',v:'.5',baseHeightMm:'0',widthMm:'',heightMm:'',depthMm:'',yawDegrees:'0'});
let plan;try{plan=resolveManualDraft(draft,DEFAULT_ROOM,680)}catch(e){plan={error:e.message}}
return <main><h1>벽 기준 설치 보정</h1><p>기능 검사 입력 · 실제 사진 실측/AI 인식 아님</p>
<ManualPlacementEditor value={draft} room={DEFAULT_ROOM} defaults={{widthMm:600,heightMm:800,depthMm:680}} prefix="설비" disabled={false} onChange={setDraft}/>
<output data-testid="plan">{JSON.stringify(plan)}</output><output data-testid="draft">{JSON.stringify(draft)}</output></main>};
createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outfile: 'bundle.js',
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
});
const js = bundle.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
const css = bundle.outputFiles.find((f) => f.path.endsWith('.css'))!.text;
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
      '<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>body{margin:16px;font:16px sans-serif}main{max-width:760px}output{display:block;overflow-wrap:anywhere;font-size:11px}label{display:block}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>',
    );
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 }, hasTouch: true });
  const errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(origin);
  const plan = async () => JSON.parse((await page.getByTestId('plan').textContent())!);
  await page.getByLabel('설비 벽 기준 거리로 배치', { exact: true }).check();
  await expect(page.locator('p[role="status"]').first()).toContainText('벽과 두 거리');
  await expect(page.getByTestId('placement-picker')).toHaveAttribute('aria-disabled', 'true');
  await page.getByLabel('설비 제품 뒤쪽 벽', { exact: true }).selectOption('back');
  await page.getByLabel('설비 벽을 따른 중심 거리 mm', { exact: true }).fill('1200');
  await page.getByLabel('설비 벽과 제품 뒤쪽 간격 mm', { exact: true }).fill('70');
  assert.ok(Math.abs((await plan()).v * 2400 - 410) < 1e-8);
  assert.equal((await plan()).depthMm, undefined);
  await expect(page.getByLabel('설비 방향 °', { exact: true })).toHaveCount(0);
  await page.getByLabel('설비 깊이 mm', { exact: true }).fill('800');
  assert.ok(Math.abs((await plan()).v * 2400 - 470) < 1e-8);
  await page.getByLabel('설비 제품 뒤쪽 벽', { exact: true }).selectOption('right');
  await page.getByLabel('설비 벽을 따른 중심 거리 mm', { exact: true }).fill('1600');
  await page.getByLabel('설비 벽과 제품 뒤쪽 간격 mm', { exact: true }).fill('100');
  const right = await plan();
  assert.equal(right.yawDegrees, -90);
  assert.ok(Math.abs(right.u - (1 - 500 / 2400)) < 1e-8);
  assert.ok(Math.abs(right.v - 1600 / 2400) < 1e-8);
  const picker = page.getByTestId('placement-picker');
  await expect(picker).toHaveAttribute('aria-disabled', 'false');
  const near = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 2, `${actual} != ${expected}`);
  const movePicker = async (u: number, v: number) => {
    await picker.scrollIntoViewIfNeeded();
    const box = (await picker.boundingBox())!;
    await page.mouse.click(box.x + box.width * u, box.y + box.height * v);
  };
  for (const wall of ['back', 'left', 'right'] as const) {
    await page.getByLabel('설비 제품 뒤쪽 벽', { exact: true }).selectOption(wall);
    await movePicker(0.5, 0.5);
    const moved = await plan();
    near(moved.wallReference.alongMm, 1200);
    near(moved.wallReference.clearanceMm, 800);
    assert.equal(moved.yawDegrees, wall === 'left' ? 90 : wall === 'right' ? -90 : 0);
  }
  await picker.press('ArrowDown');
  near((await plan()).wallReference.alongMm, 1224);
  near((await plan()).wallReference.clearanceMm, 800);
  // The chosen point is inside the room but the body crosses its supporting wall. Never silently clamp.
  await movePicker(0.98, 0.5);
  assert.ok((await plan()).error);
  const invalidDraft = JSON.parse((await page.getByTestId('draft').textContent())!);
  assert.ok(Number(invalidDraft.wallPosition.clearanceMm) < 0);
  near(Number(invalidDraft.u) * 2400, 2352);
  // Invalid gap does not lock the picker; users can drag back to a valid point.
  await expect(picker).toHaveAttribute('aria-disabled', 'false');
  await movePicker(0.5, 0.5);
  assert.equal((await plan()).error, undefined);
  await picker.scrollIntoViewIfNeeded();
  const dragBox = (await picker.boundingBox())!;
  await page.mouse.move(dragBox.x + dragBox.width * 0.5, dragBox.y + dragBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width * 0.65, dragBox.y + dragBox.height * 0.7, { steps: 8 });
  await page.mouse.up();
  near((await plan()).wallReference.alongMm, 1680);
  near((await plan()).wallReference.clearanceMm, 440);
  await page.getByLabel('설비 벽을 따른 중심 거리 mm', { exact: true }).fill('1600');
  await page.getByLabel('설비 벽과 제품 뒤쪽 간격 mm', { exact: true }).fill('100');
  await page.getByLabel('설비 벽과 제품 뒤쪽 간격 mm', { exact: true }).fill('');
  assert.ok((await plan()).error);
  await page.getByLabel('설비 벽과 제품 뒤쪽 간격 mm', { exact: true }).fill('100');
  await page.getByLabel('설비 벽을 따른 중심 거리 mm', { exact: true }).fill('10');
  await expect(page.locator('p[role="status"]').first()).toContainText('정면 290mm');
  await page.getByLabel('설비 벽을 따른 중심 거리 mm', { exact: true }).fill('1600');
  await page.setViewportSize({ width: 390, height: 844 });
  await picker.scrollIntoViewIfNeeded();
  const mobileBox = (await picker.boundingBox())!;
  await page.touchscreen.tap(mobileBox.x + mobileBox.width * 0.5, mobileBox.y + mobileBox.height * 0.5);
  near((await plan()).wallReference.alongMm, 1200);
  near((await plan()).wallReference.clearanceMm, 800);
  assert.equal((await plan()).yawDegrees, -90);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: output + '/mobile.png', fullPage: true });
  await page.getByLabel('설비 설치 면', { exact: true }).selectOption('left');
  await page.getByLabel('설비 하단 높이 mm', { exact: true }).fill('1000');
  assert.equal((await plan()).wallReference, undefined);
  await page.getByLabel('설비 설치 면', { exact: true }).selectOption('floor');
  await expect(page.getByLabel('설비 벽 기준 거리로 배치', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('설비 방향 °', { exact: true })).toBeEnabled();
  assert.deepEqual(errors, []);
  assert.equal(
    requests.every((url) => url.startsWith(origin)),
    true,
  );
  const result = {
    scope:
      'Actual UI; all numbers are explicit functional test inputs. No AI, photo measurement or accuracy claim.',
    browser: browser.version(),
    right,
    errors,
    externalRequests: requests.filter((url) => !url.startsWith(origin)),
    checks: [
      'explicit wall required',
      'default depth provenance',
      'rear gap preserved after depth edit',
      'right-wall direction',
      'invalid empty distance',
      'body overflow shown, not clamped',
      'three wall pointer mapping',
      'wall direction preserved while dragging',
      'keyboard distances',
      'negative gap visible and recoverable',
      'mobile touch',
      'switch to wall and free mode',
    ],
  };
  await writeFile(output + '/verification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
