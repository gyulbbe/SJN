// Real, billed run of the material form's "AI로 방향 사진 만들기" for one bathtub
// (docs/direction-photo-results-20261013.md). Drives the real screen: the real guides, the real
// background removal (BiRefNet, served from tmp/background-model by lib.mjs), the real route
// POST /api/materials/direction-photo and FLUX.2 klein 4B.
//
// Needs, for the run only (never committed): the local dev server (npm run dev) with a remote AI
// binding added to wrangler.dev.jsonc ("ai": { "binding": "AI", "remote": true }), and a signed-in
// admin session (test-results/e2e-flow/state.json; tmp/relogin.mjs signs the local test account in).
// Every request to the route is written to the ledger and refused beyond the cap (AI_CAP_FLUX,
// default 8, counted across runs in the same ledger). Nothing is saved to the material: the dialog is
// left without "자재 등록".
//
// Usage: node tests/direction-photo-real/run.mjs
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { session, BASE } from '../product-representation/lib.mjs';

const OUT = 'test-results/direction-photo-real';
const CAP = Number(process.env.AI_CAP_FLUX ?? 8);
const LEDGER = process.env.AI_LEDGER ?? `${OUT}/ledger.jsonl`;
const INPUT = 'test-results/product-representation/real/input';
mkdirSync(`${OUT}/answers`, { recursive: true });
const ledger = () =>
  existsSync(LEDGER)
    ? readFileSync(LEDGER, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
let sent = ledger().filter((row) => row.status !== 'refused').length;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
log(`ledger: ${sent} sent before, cap ${CAP}`);

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
  if (sent >= CAP) {
    appendFileSync(
      LEDGER,
      JSON.stringify({ at: new Date().toISOString(), status: 'refused', direction: spec.direction, seed }) +
        '\n',
    );
    return route.fulfill({ status: 429, json: { error: `시험 상한 ${CAP}회에 걸려 보내지 않았어요.` } });
  }
  const n = ++sent;
  if (n === 1) {
    writeFileSync(`${OUT}/request-spec.json`, JSON.stringify(spec, null, 2));
    for (const [index, ref] of form.getAll('refs').entries())
      writeFileSync(`${OUT}/sent-ref-${index + 1}.png`, Buffer.from(await ref.arrayBuffer()));
  }
  writeFileSync(
    `${OUT}/sent-guide-${spec.direction}.png`,
    Buffer.from(await form.get('guide').arrayBuffer()),
  );
  const started = Date.now();
  let response, body;
  try {
    response = await route.fetch({ timeout: 200_000 });
    body = await response.body();
  } catch (error) {
    appendFileSync(
      LEDGER,
      JSON.stringify({
        at: new Date().toISOString(),
        n,
        direction: spec.direction,
        seed,
        status: 'error',
        error: String(error).slice(0, 300),
      }) + '\n',
    );
    return route.abort();
  }
  const ms = Date.now() - started;
  const row = {
    at: new Date().toISOString(),
    n,
    direction: spec.direction,
    seed,
    status: response.status(),
    ms,
    refs: form.getAll('refs').length,
  };
  if (response.ok()) {
    const meta = await sharp(body).metadata();
    row.size = [meta.width, meta.height];
    writeFileSync(`${OUT}/answers/${String(n).padStart(2, '0')}-${spec.direction}-${seed}.png`, body);
  } else row.error = body.toString('utf8').slice(0, 400);
  appendFileSync(LEDGER, JSON.stringify(row) + '\n');
  log('call', n, spec.direction, seed, response.status(), `${(ms / 1000).toFixed(1)}s`);
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

try {
  await page.goto(`${BASE}/admin/materials`);
  await page.getByRole('button', { name: '자재 등록', exact: true }).click();
  const form = page.getByRole('dialog', { name: '자재 등록', exact: true });
  await form.getByLabel('상품명').fill('실제 AI 방향 욕조(저장 안 함)');
  await form.getByLabel('카테고리', { exact: true }).selectOption('bath');
  await form.getByLabel('가로 (mm)', { exact: true }).fill('1700');
  await form.getByLabel('높이 (mm)', { exact: true }).fill('560');
  await form.getByLabel('깊이 (mm)', { exact: true }).fill('750');
  await form.getByLabel('설치 방식', { exact: true }).selectOption('floor');
  const generator = form.getByTestId('ai-direction-photos');
  await generator.getByText('AI로 방향 사진 만들기', { exact: true }).click();
  // The white catalogue photo and the staged one (blue floor, props): both go through the real cut-out.
  await generator
    .getByLabel('+ 참고 사진 올리기(1~3장)', { exact: true })
    .setInputFiles([`${INPUT}/61-bathtub-3q-white.png`, `${INPUT}/55-bathtub-3q-top.webp`]);
  for (const n of [1, 2])
    await generator
      .getByRole('img', { name: `참고 사진 ${n}(배경 지움)`, exact: true })
      .waitFor({ timeout: 180_000 });
  for (const n of [1, 2])
    writeFileSync(
      `${OUT}/ref-${n}-cutout-on-white.png`,
      Buffer.from(
        await dataOf(generator.getByRole('img', { name: `참고 사진 ${n}(배경 지움)`, exact: true })),
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
  await generator.getByRole('button', { name: '고른 사진 넣기', exact: true }).waitFor({ timeout: 600_000 });
  await page.waitForFunction(() => !document.body.innerText.includes('만드는 중'), null, {
    timeout: 600_000,
  });
  log('first run done');
  // As a person would: one more try for the hardest view, the narrow end.
  await generator.getByRole('button', { name: '왼쪽 다시 만들기', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => !document.body.innerText.includes('만드는 중'), null, {
    timeout: 600_000,
  });
  log('왼쪽 again done');
  const notice = generator.getByTestId('ai-notice');
  if (await notice.count()) log('notice:', await notice.textContent());
  await generator.screenshot({ path: `${OUT}/screen-candidates.png` });

  // Pick the first answer of each direction, put them in (real cut-out, anchor from the outline).
  for (const direction of ['정면', '왼쪽', '뒤']) {
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
