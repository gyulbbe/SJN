/**
 * The real product photos through the real editor, no replay (docs/product3d-editor.md, "입체화한 각도
 * 자동 저장"): register a material, remove the photo's background, make the 3D model, and see that the
 * 정면 angle becomes 3D by itself, facing front, with no click on 선택한 각도 수정. Needs the dev server
 * (npm run dev) with its local D1, a signed-in admin session in test-results/e2e-flow/state.json, the
 * pinned models in tmp/multiview-model and tmp/background-model, and WebGPU Chrome.
 *
 * Usage: node tests/run-browser-test.mjs tests/product3d-auto-save-real-browser.ts <product> [angles]
 *   <product>  a key of test-results/e2e-flow/products.json (bear-toilet, smart-toilet, bathtub, basin)
 *   [angles]   comma-separated names to add afterwards (default 오른쪽,왼쪽,뒤)
 * Writes test-results/product3d-auto-save/<product>-*.png and <product>.json.
 */
import { chromium, type ConsoleMessage, type Page } from '@playwright/test';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { nearestPoseDirection, poseDirection } from '../src/lib/product3d/direction-pose';

const BASE = 'http://127.0.0.1:3000';
const ROOT = 'test-results/e2e-flow';

/** The pinned ONNX models and the onnxruntime files, served from disk (nothing is downloaded). */
async function modelServer() {
  const roots = [
    path.resolve('tmp/multiview-model'),
    path.resolve('tmp/background-model'),
    path.resolve('node_modules/onnxruntime-web/dist'),
  ];
  const server = createServer((req, res) => {
    const name = path.basename(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = roots.map((r) => path.join(r, name)).find((candidate) => existsSync(candidate));
    if (!file) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': name.endsWith('.wasm')
        ? 'application/wasm'
        : /\.m?js$/.test(name)
          ? 'text/javascript'
          : 'application/octet-stream',
      'Content-Length': statSync(file).size,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
/** Chrome (WebGPU) signed in with the saved session, its model downloads answered from disk. */
async function session() {
  const models = await modelServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [] });
  const context = await browser.newContext({
    storageState: `${ROOT}/state.json`,
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
  });
  const redirect = (route: import('@playwright/test').Route) =>
    route.fulfill({
      status: 307,
      headers: {
        location: `${models.origin}/${path.basename(new URL(route.request().url()).pathname)}`,
        'access-control-allow-origin': '*',
      },
    });
  await context.route('https://huggingface.co/**', redirect);
  await context.route('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/**', redirect);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
  return {
    page,
    close: async () => {
      await browser.close();
      models.close();
    },
  };
}

const key = process.argv[3];
const angles = (process.argv[4] ?? '오른쪽,왼쪽,뒤').split(',').filter(Boolean);
const products = JSON.parse(readFileSync(`${ROOT}/products.json`, 'utf8'));
const p = products[key];
if (!p) throw new Error(`unknown product ${key}`);
const out = 'test-results/product3d-auto-save';
mkdirSync(out, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `${out}/${key}-${name}.png` });
const s = await session();
const { page } = s;
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
page.on('console', (m: ConsoleMessage) => {
  if (m.type() === 'error' && !/onnxruntime|favicon/.test(m.text()))
    log('CONSOLE-ERR', m.text().slice(0, 200));
});
const report: Record<string, unknown> = { product: key };
try {
  await page.goto(`${BASE}/admin/materials`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('카테고리', { exact: true }).selectOption(p.category);
  await form.getByLabel('상품명').fill(`${p.name} 자동저장`);
  await form.getByLabel('가로 (mm)').fill(String(p.width));
  await form.getByLabel('높이 (mm)').fill(String(p.height));
  await form.getByLabel('깊이 (mm)').fill(String(p.depth));
  await form.getByLabel('설치 방식').selectOption({ label: p.install });
  await form.getByLabel('+ 제품 이미지 올리기', { exact: true }).setInputFiles(`${ROOT}/input/${p.file}`);
  await form.getByLabel('촬영 방향 1', { exact: true }).selectOption('정면');
  await page.waitForTimeout(800);
  const formImage = form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true });
  // Background removal first, as the user does.
  await form.getByRole('button', { name: '정면 사진 AI 360° 입체화', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: '360° 제품 편집', exact: true });
  await viewer.waitFor();
  await viewer.getByRole('button', { name: '원본 배경 제거', exact: true }).click();
  const upload = page.getByRole('button', { name: '투명 PNG 업로드', exact: true });
  await upload.waitFor();
  for (let i = 0; i < 90 && !(await upload.isEnabled()); i++) await page.waitForTimeout(2000);
  await upload.click();
  await page.waitForTimeout(1500);
  const flatSrc = await formImage.getAttribute('src');
  // The 3D editor on the cutout; the 정면 stays a flat photo until the model is made.
  await form.getByRole('button', { name: '정면 사진 AI 360° 입체화', exact: true }).click();
  const v = page.getByRole('dialog', { name: '360° 제품 편집', exact: true });
  await v.waitFor();
  await v.getByRole('button', { name: '입체화 시작', exact: true }).click();
  log('3D generation started');
  let saved = false;
  for (let i = 0; i < 400 && !saved; i++) {
    if (await v.getByRole('alert').count())
      throw new Error('alert: ' + (await v.getByRole('alert').first().innerText()));
    saved = (await v.getByText('사진을 입체로 저장했어요').count()) > 0;
    if (!saved) await page.waitForTimeout(3000);
  }
  if (!saved) throw new Error('the 정면 was not saved by itself');
  log('정면 saved as 3D by itself');
  await v.getByRole('button', { name: '화면 맞춤', exact: true }).waitFor();
  await page.waitForTimeout(1500);
  const afterSrc = await formImage.getAttribute('src');
  report.formImageChanged = afterSrc !== flatSrc;
  const read = async () => {
    const pose = JSON.parse((await v.getByTestId('product3d-pose').getAttribute('data-pose')) ?? '{}');
    const { angle, elevation } = poseDirection(pose);
    return {
      angle: +angle.toFixed(2),
      elevation: +elevation.toFixed(2),
      name: nearestPoseDirection(pose).name,
    };
  };
  report.firstScreen = await read();
  report.directionWarning = await v.getByTestId('product3d-direction-warning').count();
  report.directionHint = await v.getByTestId('product3d-direction-hint').count();
  report.angleWarning = (await v.getByTestId('product3d-angle-warning').count())
    ? await v.getByTestId('product3d-angle-warning').innerText()
    : null;
  log(
    'first screen',
    JSON.stringify(report.firstScreen),
    'warning',
    report.directionWarning,
    'hint',
    report.directionHint,
  );
  await v.screenshot({ path: `${out}/${key}-10-first-screen.png` });
  await v.getByTestId('product3d-canvas').screenshot({ path: `${out}/${key}-11-front.png` });
  // The next angles: pick the name (the product turns to it), add it.
  const added: Record<string, unknown>[] = [];
  for (const name of angles) {
    await v.getByLabel('새 각도 이름', { exact: true }).selectOption(name);
    await page.waitForTimeout(600);
    const before = await read();
    await v.getByRole('button', { name: '이 각도 추가', exact: true }).click();
    await page.waitForTimeout(3000);
    const alert = await v.getByRole('alert').count();
    added.push({ name, pose: before, alert });
    await v.getByTestId('product3d-canvas').screenshot({ path: `${out}/${key}-21-angle-${name}.png` });
    log('added', name, JSON.stringify(before), alert ? 'ALERT' : 'ok');
  }
  report.added = added;
  await v.screenshot({ path: `${out}/${key}-22-viewer-final.png` });
  await v.getByRole('button', { name: '닫기', exact: true }).first().click();
  await page.waitForTimeout(800);
  await form.getByRole('button', { name: '자재 등록', exact: true }).click();
  await page.waitForTimeout(4000);
  report.dialogsAfterSave = await page.getByRole('dialog').count();
  await shot(page, '23-after-save');
} catch (reason) {
  report.error = reason instanceof Error ? reason.message : String(reason);
  await shot(page, '99-error').catch(() => {});
  log('ERROR', report.error);
} finally {
  writeFileSync(`${out}/${key}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await s.close();
}
