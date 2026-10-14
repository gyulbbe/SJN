// Real, billed run of the material form's "AI로 방향 사진 만들기" for one product
// (docs/direction-photo-results-20261013.md). Drives the real screen: the real guides, the real
// background removal (BiRefNet, served from tmp/background-model by lib.mjs), the real route
// POST /api/materials/direction-photo and FLUX.2 klein 4B.
//
// Needs, for the run only (never committed): the local dev server (npm run dev) with a remote AI
// binding added to wrangler.dev.jsonc ("ai": { "binding": "AI", "remote": true }), and a signed-in
// admin session (test-results/e2e-flow/state.json; tmp/relogin.mjs signs the local test account in).
// Every request to the route is written to the ledger with its estimated neurons (callNeurons: the
// platform's price list) and refused beyond the cap: AI_CAP_FLUX calls (default 8) or 90% of
// AI_BUDGET_NEURONS (default none), both counted across runs in the same ledger. A failed request
// counts as spent. Nothing is saved to the material: the dialog is left without "자재 등록".
//
// Usage: [PRODUCT=bath|bear-toilet|smart-toilet] [FORM=lid-open] [AI_OUT=...] node tests/direction-photo-real/run.mjs
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import sharp from 'sharp';
import { session, BASE } from '../product-representation/lib.mjs';

/**
 * The products: what the form gets, which photos go in, whether 오른쪽 is 왼쪽 turned over, the
 * direction made once more and the candidates put in the slots.
 */
const PRODUCTS = {
  bath: {
    out: 'test-results/direction-photo-real',
    name: '실제 AI 방향 욕조(저장 안 함)',
    category: 'bath',
    size: ['1700', '560', '750'],
    installation: 'floor',
    symmetric: true,
    // The white catalogue photo and the staged one (blue floor, props): both go through the real cut-out.
    photos: ['61-bathtub-3q-white.png', '55-bathtub-3q-top.webp'],
    again: '왼쪽',
    pick: ['정면', '왼쪽', '뒤'],
  },
  // The one-piece bear toilet (ears on the tank, a face printed on its front, the lever on its right
  // side, a seat and no lid): not symmetric, so 오른쪽 is made, not turned over. The screen has no
  // seat-only shape: the person tried 뚜껑 열림.
  'bear-toilet': {
    out: 'test-results/direction-photo-bear/bear-baseline',
    ledger: 'test-results/direction-photo-bear/ledger.jsonl',
    name: '실제 AI 곰 변기(저장 안 함)',
    category: 'toilet',
    size: ['370', '660', '640'],
    installation: 'floor',
    form: 'lid-open',
    symmetric: false,
    photos: ['62-bear-toilet-3q.png'],
    pick: ['정면', '왼쪽', '오른쪽', '뒤'],
  },
  // A tankless smart toilet (a square body, a bidet seat with its lid closed, the button panel on its
  // right side): not symmetric either. Photos 53·52·60 are the same product from the front and the
  // sides, kept out of the request to judge the answers by.
  'smart-toilet': {
    out: 'test-results/direction-photo-bear/smart-baseline',
    ledger: 'test-results/direction-photo-bear/ledger.jsonl',
    name: '실제 AI 스마트 변기(저장 안 함)',
    category: 'toilet',
    size: ['400', '520', '700'],
    installation: 'floor',
    form: 'lid-closed',
    symmetric: false,
    photos: ['57-toilet-3q-small.png'],
    pick: ['정면', '왼쪽', '오른쪽', '뒤'],
  },
};
const product = PRODUCTS[process.env.PRODUCT ?? 'bath'];
if (!product) throw new Error(`PRODUCT is one of ${Object.keys(PRODUCTS).join(', ')}`);
const OUT = process.env.AI_OUT ?? product.out;
const CAP = Number(process.env.AI_CAP_FLUX ?? 8);
const BUDGET = Number(process.env.AI_BUDGET_NEURONS ?? Infinity);
const LEDGER = process.env.AI_LEDGER ?? product.ledger ?? `${OUT}/ledger.jsonl`;
const INPUT = process.env.AI_INPUT ?? 'test-results/product-representation/real/input';
mkdirSync(`${OUT}/answers`, { recursive: true });

// The server's own prompt and estimate, to write down what each request was sent with.
const bundled = await build({
  stdin: {
    contents: `export { buildDirectionPhotoPrompt } from './src/lib/direction-photo/prompt';
      export { callNeurons } from './src/lib/direction-photo/plan';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { buildDirectionPhotoPrompt, callNeurons } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

const ledger = () =>
  existsSync(LEDGER)
    ? readFileSync(LEDGER, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const spentRows = () => ledger().filter((row) => row.status !== 'refused');
let sent = spentRows().length;
let neurons = spentRows().reduce((sum, row) => sum + (row.neurons ?? 0), 0);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
log(`ledger: ${sent} sent before (~${Math.round(neurons)} neurons), cap ${CAP} calls, budget ${BUDGET}`);

const s = await session();
const { page, context } = s;
const formOf = (request) =>
  new Response(new Uint8Array(request.postDataBuffer()), {
    headers: { 'content-type': request.headers()['content-type'] },
  }).formData();
await context.route('**/api/materials/direction-photo', async (route) => {
  const form = await formOf(route.request());
  const spec = JSON.parse(String(form.get('spec')));
  const seed = String(form.get('seed'));
  const guideBytes = Buffer.from(await form.get('guide').arrayBuffer());
  const guideMeta = await sharp(guideBytes).metadata();
  const refs = form.getAll('refs');
  const cost = callNeurons({ width: guideMeta.width, height: guideMeta.height }, refs.length);
  if (sent >= CAP || neurons + cost > BUDGET * 0.9) {
    appendFileSync(
      LEDGER,
      JSON.stringify({ at: new Date().toISOString(), status: 'refused', direction: spec.direction, seed }) +
        '\n',
    );
    return route.fulfill({
      status: 429,
      json: { error: `시험 상한(${CAP}회·예산 ${BUDGET}뉴런의 90%)에 걸려 보내지 않았어요.` },
    });
  }
  const n = ++sent;
  neurons += cost;
  if (n === 1 || !existsSync(`${OUT}/request-spec.json`)) {
    writeFileSync(`${OUT}/request-spec.json`, JSON.stringify(spec, null, 2));
    for (const [index, ref] of refs.entries())
      writeFileSync(`${OUT}/sent-ref-${index + 1}.png`, Buffer.from(await ref.arrayBuffer()));
  }
  writeFileSync(`${OUT}/sent-guide-${spec.direction}.png`, guideBytes);
  writeFileSync(`${OUT}/prompt-${spec.direction}.txt`, buildDirectionPhotoPrompt(spec, refs.length));
  const started = Date.now();
  const row = {
    at: new Date().toISOString(),
    n,
    run: OUT,
    direction: spec.direction,
    seed,
    refs: refs.length,
    guide: [guideMeta.width, guideMeta.height],
    neurons: Number(cost.toFixed(2)),
  };
  let response, body;
  try {
    response = await route.fetch({ timeout: 200_000 });
    body = await response.body();
  } catch (error) {
    appendFileSync(
      LEDGER,
      JSON.stringify({ ...row, status: 'error', error: String(error).slice(0, 300) }) + '\n',
    );
    return route.abort();
  }
  row.status = response.status();
  row.ms = Date.now() - started;
  if (response.ok()) {
    const meta = await sharp(body).metadata();
    row.size = [meta.width, meta.height];
    writeFileSync(`${OUT}/answers/${String(n).padStart(2, '0')}-${spec.direction}-${seed}.png`, body);
  } else row.error = body.toString('utf8').slice(0, 400);
  appendFileSync(LEDGER, JSON.stringify(row) + '\n');
  log(
    'call',
    n,
    spec.direction,
    seed,
    row.status,
    `${(row.ms / 1000).toFixed(1)}s`,
    `~${Math.round(neurons)}`,
  );
  await route.fulfill({ response, body });
});

const dataOf = (locator) =>
  locator.evaluate(async (image) => {
    // The slot pictures load from the asset store: wait for a decoded blob: picture.
    for (let i = 0; i < 100 && !(image.src.startsWith('blob:') && image.complete && image.naturalWidth); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    await image.decode();
    const blob = await (await fetch(image.src)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text);
  });
const done = () =>
  page.waitForFunction(() => !document.body.innerText.includes('만드는 중'), null, { timeout: 900_000 });

try {
  await page.goto(`${BASE}/admin/materials`);
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('상품명').fill(product.name);
  await form.getByLabel('카테고리', { exact: true }).selectOption(product.category);
  await form.getByLabel('가로 (mm)', { exact: true }).fill(product.size[0]);
  await form.getByLabel('높이 (mm)', { exact: true }).fill(product.size[1]);
  await form.getByLabel('깊이 (mm)', { exact: true }).fill(product.size[2]);
  await form.getByLabel('설치 방식', { exact: true }).selectOption(product.installation);
  const generator = form.getByTestId('ai-direction-photos');
  await generator.getByText('AI로 방향 사진 만들기', { exact: true }).click();
  const shape = process.env.FORM ?? product.form;
  if (shape) await generator.getByLabel('가이드 모양', { exact: true }).selectOption(shape);
  const symmetric = generator.getByRole('checkbox', { name: /좌우 대칭 제품/ });
  if ((await symmetric.isChecked()) !== product.symmetric) await symmetric.click();
  await generator
    .getByLabel('+ 참고 사진 올리기(1~3장)', { exact: true })
    .setInputFiles(product.photos.map((name) => `${INPUT}/${name}`));
  for (const n of product.photos.keys())
    await generator
      .getByRole('img', { name: `참고 사진 ${n + 1}(배경 지움)`, exact: true })
      .waitFor({ timeout: 180_000 });
  for (const n of product.photos.keys())
    writeFileSync(
      `${OUT}/ref-${n + 1}-cutout-on-white.png`,
      Buffer.from(
        await dataOf(generator.getByRole('img', { name: `참고 사진 ${n + 1}(배경 지움)`, exact: true })),
        'base64',
      ),
    );
  const guides = generator.getByTestId('ai-guides');
  await guides.getByRole('img').nth(3).waitFor({ timeout: 60_000 });
  for (const direction of ['정면', '왼쪽', '오른쪽', '뒤'])
    writeFileSync(
      `${OUT}/guide-${direction}.png`,
      Buffer.from(
        await dataOf(guides.getByRole('img', { name: `${direction} 가이드`, exact: true })),
        'base64',
      ),
    );
  writeFileSync(`${OUT}/estimate.txt`, (await generator.getByTestId('ai-estimate').textContent()) ?? '');
  await generator.screenshot({ path: `${OUT}/screen-guides.png` });
  log('guides and photos ready:', await generator.getByTestId('ai-estimate').textContent());

  await generator.getByRole('button', { name: '방향 사진 만들기', exact: true }).click();
  await generator.getByRole('button', { name: '고른 사진 넣기', exact: true }).waitFor({ timeout: 900_000 });
  await done();
  log('first run done');
  if (product.again) {
    // As a person would: one more try for the hardest view.
    await generator.getByRole('button', { name: `${product.again} 다시 만들기`, exact: true }).click();
    await page.waitForTimeout(1000);
    await done();
    log(`${product.again} again done`);
  }
  const notice = generator.getByTestId('ai-notice');
  if (await notice.count()) log('notice:', await notice.textContent());
  await generator.screenshot({ path: `${OUT}/screen-candidates.png` });

  // Pick the first answer of each direction, put them in (real cut-out, anchor from the outline).
  for (const direction of product.pick) {
    const first = generator.getByRole('button', { name: `${direction} 후보 1`, exact: true });
    if (await first.count()) await first.click();
  }
  await generator.getByRole('button', { name: '고른 사진 넣기', exact: true }).click();
  await notice.filter({ hasText: '칸에 넣었어요' }).waitFor({ timeout: 300_000 });
  log('applied:', await notice.textContent());
  const slots = [];
  for (let index = 1; index <= 4; index++) {
    const select = form.getByLabel(`촬영 방향 ${index}`, { exact: true });
    if (!(await select.count())) break;
    const direction = await select.inputValue();
    const card = select.locator('xpath=ancestor::div[contains(@class, "viewCard")][1]');
    const image = card.getByRole('img', { name: '배치 기준점을 지정할 제품 이미지', exact: true });
    writeFileSync(`${OUT}/slot-${direction}.png`, Buffer.from(await dataOf(image), 'base64'));
    const values = await card
      .getByRole('spinbutton')
      .evaluateAll((inputs) => inputs.map((input) => input.value));
    slots.push({ direction, anchorPercent: values.map(Number) });
  }
  writeFileSync(`${OUT}/slots.json`, JSON.stringify(slots, null, 2));
  log('slots:', JSON.stringify(slots));
  await form.screenshot({ path: `${OUT}/screen-form.png` });
} finally {
  await s.close();
  const rows = ledger();
  log('ledger:', rows.length, 'rows,', rows.filter((r) => r.status === 200).length, 'answers');
}
