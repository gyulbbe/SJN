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
// Usage: [PRODUCT=bath|bear-toilet|smart-toilet|toilet-t1|toilet-t6|toilet-t2] [FORM=one-piece] [AI_OUT=...]
//   [FLUX_ENGINE=local: answered by the local FLUX server, no AI binding needed]
//   node tests/direction-photo-real/run.mjs
// The toilet-t* products are the 2026-10-17 trial's photos (docs/toilet-direction-photo-results-20261018.md),
// on that trial's ledger.
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
  // side, a seat and no lid): not symmetric, so 오른쪽 is made, not turned over; a toilet has no 뒤.
  // Its photo shows its front and right side from above. (The 2026-10-14 baseline was the harness's,
  // with the screen's shapes then: two-piece, 뚜껑 열림.)
  'bear-toilet': {
    out: 'test-results/direction-photo-bear/bear-screen',
    ledger: 'test-results/direction-photo-bear/ledger.jsonl',
    name: '실제 AI 곰 변기(저장 안 함)',
    category: 'toilet',
    size: ['370', '660', '640'],
    installation: 'floor',
    form: 'one-piece',
    lid: 'seat',
    symmetric: false,
    photos: ['62-bear-toilet-3q.png'],
    angles: ['front-right'],
    pick: ['정면', '왼쪽', '오른쪽'],
  },
  // A tankless smart toilet (a square body, a bidet seat with its lid closed, the button panel on its
  // right side): not symmetric either. Photos 53·52·60 are the same product from the front and the
  // sides, kept out of the request to judge the answers by.
  'smart-toilet': {
    out: 'test-results/direction-photo-bear/smart-screen',
    ledger: 'test-results/direction-photo-bear/ledger.jsonl',
    name: '실제 AI 스마트 변기(저장 안 함)',
    category: 'toilet',
    size: ['400', '520', '700'],
    installation: 'floor',
    form: 'tankless',
    lid: 'closed',
    symmetric: false,
    photos: ['57-toilet-3q-small.png'],
    angles: ['front-right'],
    pick: ['정면', '왼쪽', '오른쪽'],
  },
  // The toilet trial's products on the real screen (sizes assumed: the photos have none). t1 is a
  // one-piece with a blue seat and lid on a white body, its staged backdrop and label mark left to
  // the real cut-out; t6 a white tankless with a remote drawn beside it, its colours left to the
  // photo; t2 a black square tankless.
  'toilet-t1': {
    out: 'test-results/toilet-direction/screen-t1',
    ledger: 'test-results/toilet-direction/ledger.jsonl',
    input: 'test-results/toilet-direction/input',
    name: '실제 AI 양변기 t1(저장 안 함)',
    category: 'toilet',
    size: ['380', '700', '700'],
    installation: 'floor',
    form: 'one-piece',
    lid: 'closed',
    bodyColor: 'white',
    seatColor: 'blue',
    symmetric: false,
    photos: ['t1-onepiece-blue-seat.webp'],
    angles: ['front-right'],
    pick: ['정면', '왼쪽', '오른쪽'],
  },
  'toilet-t6': {
    out: 'test-results/toilet-direction/screen-t6',
    ledger: 'test-results/toilet-direction/ledger.jsonl',
    input: 'test-results/toilet-direction/input',
    name: '실제 AI 양변기 t6(저장 안 함)',
    category: 'toilet',
    size: ['400', '500', '680'],
    installation: 'floor',
    form: 'tankless',
    lid: 'closed',
    symmetric: false,
    photos: ['t6-tankless-white-remote.webp'],
    angles: ['front-right'],
    pick: ['정면', '왼쪽', '오른쪽'],
  },
  'toilet-t2': {
    out: 'test-results/toilet-direction/screen-t2',
    ledger: 'test-results/toilet-direction/ledger.jsonl',
    input: 'test-results/toilet-direction/input',
    name: '실제 AI 양변기 t2(저장 안 함)',
    category: 'toilet',
    size: ['400', '500', '680'],
    installation: 'floor',
    form: 'tankless',
    lid: 'closed',
    bodyColor: 'black',
    seatColor: 'body',
    symmetric: false,
    photos: ['t2-tankless-black-square.webp'],
    angles: ['front-right'],
    pick: ['정면', '왼쪽', '오른쪽'],
  },
};
const product = PRODUCTS[process.env.PRODUCT ?? 'bath'];
if (!product) throw new Error(`PRODUCT is one of ${Object.keys(PRODUCTS).join(', ')}`);
const OUT = process.env.AI_OUT ?? product.out;
// FLUX_ENGINE=local: the route's request is answered here by the local FLUX.2 klein 4B server
// (local-flux/server.py, default http://127.0.0.1:8798) with the route's model input, instead of going
// on to the dev server and Cloudflare; free, so neither the cap nor the budget counts it. An answer
// that does not say `meta.engine: 'local'` is refused.
const LOCAL = process.env.FLUX_ENGINE === 'local';
if (process.env.FLUX_ENGINE && !LOCAL) throw new Error('FLUX_ENGINE is local or unset (Cloudflare).');
const LOCAL_FLUX = process.env.FLUX_WORKER ?? 'http://127.0.0.1:8798';
const CAP = Number(process.env.AI_CAP_FLUX ?? 8);
const BUDGET = Number(process.env.AI_BUDGET_NEURONS ?? Infinity);
const LEDGER = process.env.AI_LEDGER ?? product.ledger ?? `${OUT}/ledger.jsonl`;
const INPUT = process.env.AI_INPUT ?? product.input ?? 'test-results/product-representation/real/input';
mkdirSync(`${OUT}/answers`, { recursive: true });

// The server's own prompt and estimate, to write down what each request was sent with.
const bundled = await build({
  stdin: {
    contents: `export { buildDirectionPhotoPrompt } from './src/lib/direction-photo/prompt';
      export { callNeurons } from './src/lib/direction-photo/plan';
      export { directionPhotoSpecSchema } from './src/lib/direction-photo/contract';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { buildDirectionPhotoPrompt, callNeurons, directionPhotoSpecSchema } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

const ledger = () =>
  existsSync(LEDGER)
    ? readFileSync(LEDGER, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
// The free allowance is daily (00:00 UTC): the cap and the budget count today's requests only; the
// answers' numbers run on across the whole ledger.
const today = new Date().toISOString().slice(0, 10);
const spentRows = () => ledger().filter((row) => row.status !== 'refused');
const todays = () => spentRows().filter((row) => String(row.at).startsWith(today));
let n = spentRows().length;
let sent = todays().length;
let neurons = todays().reduce((sum, row) => sum + (row.neurons ?? 0), 0);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
log(`ledger: ${sent} sent today (~${Math.round(neurons)} neurons), cap ${CAP} calls, budget ${BUDGET}`);

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
  const cost = LOCAL ? 0 : callNeurons({ width: guideMeta.width, height: guideMeta.height }, refs.length);
  if (!LOCAL && (sent >= CAP || neurons + cost > BUDGET * 0.9)) {
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
  if (!LOCAL) sent++;
  const number = ++n;
  neurons += cost;
  if (!existsSync(`${OUT}/request-spec.json`)) {
    writeFileSync(`${OUT}/request-spec.json`, JSON.stringify(spec, null, 2));
    for (const [index, ref] of refs.entries())
      writeFileSync(`${OUT}/sent-ref-${index + 1}.png`, Buffer.from(await ref.arrayBuffer()));
  }
  writeFileSync(`${OUT}/sent-guide-${spec.direction}.png`, guideBytes);
  writeFileSync(`${OUT}/prompt-${spec.direction}.txt`, buildDirectionPhotoPrompt(spec, refs.length));
  const started = Date.now();
  const row = {
    at: new Date().toISOString(),
    n: number,
    run: OUT,
    direction: spec.direction,
    seed,
    refs: refs.length,
    guide: [guideMeta.width, guideMeta.height],
    neurons: Number(cost.toFixed(2)),
    engine: LOCAL ? 'local' : 'cloudflare',
  };
  if (LOCAL) {
    // The route's model input, answered here: the dev server and its AI binding are never reached.
    let status, answer;
    try {
      const reply = await fetch(LOCAL_FLUX, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'flux-2-klein-4b',
          image: guideBytes.toString('base64'),
          refs: await Promise.all(
            refs.map(async (ref) => Buffer.from(await ref.arrayBuffer()).toString('base64')),
          ),
          // Checked as the route checks it.
          prompt: buildDirectionPhotoPrompt(directionPhotoSpecSchema.parse(spec), refs.length),
          width: guideMeta.width * 2,
          height: guideMeta.height * 2,
          seed: Number(seed),
        }),
        signal: AbortSignal.timeout(900_000),
      });
      status = reply.status;
      answer = await reply.json();
    } catch (error) {
      status = 'error';
      answer = { error: String(error).slice(0, 300) };
    }
    row.ms = Date.now() - started;
    row.meta = answer.meta;
    if (status === 200 && answer.meta?.engine !== 'local') {
      status = 'not-local';
      answer = { error: 'the answer did not come from the local server' };
    }
    row.status = status === 200 && answer.image ? 200 : status;
    if (row.status !== 200) {
      row.error = String(answer.error).slice(0, 400);
      appendFileSync(LEDGER, JSON.stringify(row) + '\n');
      return route.fulfill({ status: 502, json: { error: `로컬 FLUX: ${row.error}` } });
    }
    const png = Buffer.from(answer.image, 'base64');
    const meta = await sharp(png).metadata();
    row.size = [meta.width, meta.height];
    writeFileSync(`${OUT}/answers/${String(number).padStart(3, '0')}-${spec.direction}-${seed}.png`, png);
    appendFileSync(LEDGER, JSON.stringify(row) + '\n');
    log('local', number, spec.direction, seed, 200, `${(row.ms / 1000).toFixed(1)}s`);
    return route.fulfill({ status: 200, contentType: 'image/png', body: png });
  }
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
    writeFileSync(`${OUT}/answers/${String(number).padStart(3, '0')}-${spec.direction}-${seed}.png`, body);
  } else row.error = body.toString('utf8').slice(0, 400);
  appendFileSync(LEDGER, JSON.stringify(row) + '\n');
  log(
    'call',
    number,
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
  if (shape)
    await generator
      .getByLabel(product.category === 'toilet' ? '변기 몸통' : '가이드 모양', { exact: true })
      .selectOption(shape);
  if (product.lid) await generator.getByLabel('변기 뚜껑', { exact: true }).selectOption(product.lid);
  // The body first: the seat's "몸통과 같음" opens once a body colour is chosen.
  if (product.bodyColor)
    await generator.getByLabel('변기 몸통 색', { exact: true }).selectOption(product.bodyColor);
  if (product.seatColor)
    await generator.getByLabel('변기 시트 색', { exact: true }).selectOption(product.seatColor);
  const symmetric = generator.getByRole('checkbox', { name: /좌우 대칭 제품/ });
  if ((await symmetric.isChecked()) !== product.symmetric) await symmetric.click();
  await generator
    .getByLabel('+ 참고 사진 올리기(1~3장)', { exact: true })
    .setInputFiles(product.photos.map((name) => `${INPUT}/${name}`));
  for (const n of product.photos.keys())
    await generator
      .getByRole('img', { name: `참고 사진 ${n + 1}(배경 지움)`, exact: true })
      .waitFor({ timeout: 180_000 });
  for (const [n, angle] of (product.angles ?? []).entries())
    await generator.getByLabel(`참고 사진 ${n + 1} 찍은 각도`, { exact: true }).selectOption(angle);
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
  // The candidates as the screen shows them: a toilet's sides in order of their overlap with the guide.
  const order = {};
  for (const direction of product.pick) {
    const group = generator.getByRole('group', { name: `${direction} 후보` });
    if (!(await group.count())) continue;
    order[direction] = await group.getByRole('button', { name: /후보 \d$/ }).evaluateAll((buttons) =>
      buttons.map((button) => ({
        overlap: button.getAttribute('data-overlap'),
        image: button.querySelector('img')?.getAttribute('src'),
      })),
    );
    await group.screenshot({ path: `${OUT}/screen-${direction}-candidates.png` });
  }
  writeFileSync(`${OUT}/candidate-order.json`, JSON.stringify(order, null, 2));
  log('candidate order:', JSON.stringify(Object.fromEntries(Object.entries(order).map(([d, list]) => [d, list.map((c) => c.overlap)]))));

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
    // The picture itself: while it loads the slot shows a placeholder with the same name.
    const image = card.locator('img[alt="배치 기준점을 지정할 제품 이미지"]');
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
