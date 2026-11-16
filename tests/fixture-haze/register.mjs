// Registers the fixture-haze trial's three basins (docs/fixture-haze-20261116.md, section 4) on the LOCAL dev
// server (http://127.0.0.1:3000, its local D1/R2 only) through the admin material form, as a person would:
// the three direction photos, the size, and the app's own background removal (BiRefNet, served from disk)
// on the photos that still have a backdrop. The photos are the 2026-11-07 Cloudflare answers judged
// "그대로 등록 가능" (B15 front/left, B13 side) and the catalogue's own Z65L photos; 오른쪽 is 왼쪽 turned
// over, as the app makes it for a product that is the same on both sides.
//
// Signs in with the local test account (the main checkout's test-results/e2e-flow, never printed); the
// signed-in state is kept in the trial's folder only.
//
// Usage (worktree, dev server running): node tests/fixture-haze/register.mjs [keys]
// Output: test-results/fixture-haze-20261116/register/<key>/{front,left,right}.png, shots, result.json
import { chromium } from '@playwright/test';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path, { join } from 'node:path';
import sharp from 'sharp';
import { MODELS, OUT, ROOT } from './paths.mjs';

const BASE = 'http://127.0.0.1:3000';
const DIR = join(OUT, 'register');
const SANITARY = join(ROOT, 'test-results', '위생도기-방향사진-20261107', 'runs', 'cf');
const CATALOG = join(ROOT, 'test-results', 'catalog-match', 'snapshot', 'images');
const STATE = join(DIR, 'state.json');
mkdirSync(DIR, { recursive: true });

/** front / left photo files, whether they still have a backdrop, the size (W × H × D mm) and placement. */
const BASINS = {
  ll821: {
    name: '시험용 마스 LL-821 세면대 (방향 사진)',
    front: join(SANITARY, 'B15', 'rep', 'G', 'front-1001.png'),
    left: join(SANITARY, 'B15', 'rep', 'G2', 'left-1001.png'),
    backdrop: true,
    size: [485, 390, 425],
    installation: 'wall',
  },
  ll802: {
    name: '시험용 위니 LL-802 세면대 (방향 사진)',
    front: join(SANITARY, 'B13', 'rep', 'G2', 'left-1001.png'),
    left: join(SANITARY, 'B13', 'rep', 'G2', 'left-1001.png'),
    backdrop: true,
    size: [450, 380, 450],
    installation: 'wall',
  },
  z65l: {
    name: '시험용 아델레 Z65L 세면대 (방향 사진)',
    front: join(CATALOG, 'cc3bd494-6d6a-43ad-8032-ac395ee7b6c8.png'),
    left: join(CATALOG, '22d3a862-7342-4186-9e63-3252f49fbc8c.png'),
    right: join(CATALOG, '8f5ef58c-bbe0-4659-9e7d-72da4f37ae5f.png'),
    backdrop: false,
    size: [450, 850, 450],
    installation: 'floor',
  },
};
const keys = (process.argv[2] ?? Object.keys(BASINS).join(',')).split(',');

// Photos as the form gets them.
for (const key of keys) {
  const b = BASINS[key];
  if (!b) throw new Error(`basin ${key}?`);
  const dir = join(DIR, key);
  mkdirSync(join(dir, 'shots'), { recursive: true });
  await sharp(b.front).png().toFile(join(dir, 'front.png'));
  await sharp(b.left).png().toFile(join(dir, 'left.png'));
  if (b.right) await sharp(b.right).png().toFile(join(dir, 'right.png'));
  else await sharp(b.left).flop().png().toFile(join(dir, 'right.png'));
}

// The cut-out model and runtime from disk.
const roots = [MODELS, path.resolve('node_modules/onnxruntime-web/dist')];
const models = createServer((req, res) => {
  const name = path.basename(new URL(req.url ?? '/', 'http://localhost').pathname);
  const file = roots.map((r) => join(r, name)).find((f) => existsSync(f));
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
await new Promise((resolve) => models.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${models.address().port}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = {};
try {
  const fresh = !existsSync(STATE);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    ...(fresh ? {} : { storageState: STATE }),
  });
  const redirect = (route) =>
    route.fulfill({
      status: 307,
      headers: {
        location: `${origin}/${path.basename(new URL(route.request().url()).pathname)}`,
        'access-control-allow-origin': '*',
      },
    });
  await context.route('https://huggingface.co/**', redirect);
  await context.route('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/**', redirect);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
  page.setDefaultTimeout(60000);

  // Sign in with the local test account when there is no session yet.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const signedIn = async () =>
    page.evaluate(() =>
      fetch('/api/auth/get-session').then(async (r) => r.ok && (await r.text()).includes('"user"')),
    );
  if (!(await signedIn())) {
    const account = JSON.parse(readFileSync(join(ROOT, 'test-results', 'e2e-flow', 'account.json'), 'utf8'));
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.locator('input[name=username]').fill(account.username);
    await page.locator('input[type=password]').first().fill(account.password);
    await page.locator('button[type=submit]').click();
    await page.waitForTimeout(5000);
    if (!(await signedIn())) throw new Error('local sign-in failed');
    await context.storageState({ path: STATE });
  }
  console.log('signed in (local)');

  for (const key of keys) {
    const b = BASINS[key];
    const dir = join(DIR, key);
    const shot = (name) => page.screenshot({ path: join(dir, 'shots', `${name}.png`) });
    await page.goto(`${BASE}/admin/materials`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '자재 등록', exact: true }).first().click();
    const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
    await form.getByLabel('상품명').fill(b.name);
    await form.getByLabel('카테고리', { exact: true }).selectOption('basin');
    await form.getByLabel('가로 (mm)', { exact: true }).fill(String(b.size[0]));
    await form.getByLabel('높이 (mm)', { exact: true }).fill(String(b.size[1]));
    await form.getByLabel('깊이 (mm)', { exact: true }).fill(String(b.size[2]));
    await form.getByLabel('설치 방식').selectOption(b.installation);
    const views = [
      ['정면', 'front'],
      ['왼쪽', 'left'],
      ['오른쪽', 'right'],
    ];
    await form.getByLabel('+ 제품 이미지 올리기', { exact: true }).setInputFiles(
      views.map(([, file]) => ({
        name: `${key}-${file}.png`,
        mimeType: 'image/png',
        buffer: readFileSync(join(dir, `${file}.png`)),
      })),
    );
    for (const [index, [direction]] of views.entries())
      await form.getByLabel(`촬영 방향 ${index + 1}`, { exact: true }).selectOption(direction);
    await form.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true }).first().waitFor();
    if (b.backdrop)
      for (const [direction] of views) {
        await form
          .getByRole('button', { name: `${direction} 사진 AI 배경 제거 테스트`, exact: true })
          .click();
        const upload = page.getByRole('button', { name: '투명 PNG 업로드', exact: true });
        const ready = async () =>
          (await upload.count()) === 1 && (await upload.isEnabled({ timeout: 1000 }).catch(() => false));
        for (let i = 0; i < 180 && !(await ready()); i++) await page.waitForTimeout(1000);
        if (!(await ready())) {
          await shot(`no-cutout-${direction}`);
          throw new Error(`${key} ${direction}: no cut-out (buttons ${await upload.count()})`);
        }
        await upload.click();
        await upload.waitFor({ state: 'detached', timeout: 60000 });
        console.log(key, direction, 'cut out');
      }
    await shot('form');
    await form.getByRole('button', { name: '자재 등록', exact: true }).click();
    await form.waitFor({ state: 'detached', timeout: 60000 });
    await shot('after-save');
    results[key] = { name: b.name, saved: true };
    console.log(key, 'registered');
  }
} finally {
  writeFileSync(join(DIR, 'result.json'), JSON.stringify(results, null, 1));
  await browser.close();
  models.close();
}
