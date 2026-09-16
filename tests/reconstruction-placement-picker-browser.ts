/** Real pointer/keyboard/touch controls; the positions below are test inputs, not AI detections. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const output = 'test-results/reconstruction-placement-picker';
const bundle = await build({
  stdin: {
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { PlacementPicker } from './src/components/reconstruction/placement-picker';
      import { DEFAULT_ROOM } from './src/lib/room-geometry';
      function App() {
        const [point, setPoint] = useState({u:.5,v:.5});
        const [face, setFace] = useState('floor');
        const [disabled, setDisabled] = useState(false);
        return <main><h1>설치 위치 조작 검증</h1><p>수동 테스트 입력 · AI 인식 결과 아님</p>
          <button onClick={()=>setFace(face==='floor'?'back':'floor')}>설치 면 전환</button>
          <button onClick={()=>setDisabled(!disabled)}>잠금 전환</button>
          <PlacementPicker room={DEFAULT_ROOM} face={face} {...point} widthMm={600} heightMm={700} depthMm={400}
            yawDegrees={90} disabled={disabled} prefix="테스트" onChange={setPoint}/>
          <output data-testid="value">{JSON.stringify(point)}</output></main>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    `,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true, write: false, outfile: 'bundle.js', format: 'esm', platform: 'browser', jsx: 'automatic',
});
const js = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
const server = createServer((request, response) => {
  if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(js); }
  else if (request.url === '/bundle.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
  else { response.setHeader('Content-Type', 'text/html'); response.end('<html lang="ko"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>body{margin:16px;font:16px sans-serif}main{max-width:600px}button{margin:5px;padding:8px}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>'); }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  await mkdir(output, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(origin);
  const picker = page.getByTestId('placement-picker');
  await picker.waitFor();
  const value = async () => JSON.parse((await page.getByTestId('value').textContent())!) as {u:number;v:number};
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < .008, `${actual} != ${expected}`);
  let box = (await picker.boundingBox())!;
  await page.mouse.click(box.x + box.width * .25, box.y + box.height * .7);
  near((await value()).u, .25); near((await value()).v, .7);
  await picker.press('ArrowRight'); near((await value()).u, .26);
  await picker.press('Shift+ArrowUp'); near((await value()).v, .6);
  await page.mouse.move(box.x + box.width * .26, box.y + box.height * .6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .4, { steps: 10 });
  await page.mouse.up();
  near((await value()).u, .6); near((await value()).v, .4);
  await page.getByRole('button', { name: '잠금 전환' }).click();
  const locked = await value();
  await picker.click({ force: true });
  await picker.press('ArrowLeft');
  assert.deepEqual(await value(), locked);
  await page.getByRole('button', { name: '잠금 전환' }).click();
  await page.getByRole('button', { name: '설치 면 전환' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  box = (await picker.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width * .7, box.y + box.height * .8);
  near((await value()).u, .7); near((await value()).v, .8);
  const polygon = await picker.locator('polygon').getAttribute('points');
  const ys = polygon!.split(' ').map((entry) => Number(entry.split(',')[1]));
  near(Math.max(...ys) / 100, .8);
  near(Math.min(...ys) / 100, .8 - 700 / 2400);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: output + '/mobile-wall-picker.png', fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal(requests.every((url) => url.startsWith(origin)), true);
  const result = { scope: 'User interaction controls only; no AI or reconstruction accuracy claim', browser: browser.version(), checks: ['pointer', 'drag', 'keyboard', 'disabled', 'touch', 'wall bottom anchor', 'mobile overflow'], errors, requests };
  await writeFile(output + '/verification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
