// One AI conversion from the export dialog for one project / method / view, with a fixed seed. Real,
// billed Workers AI calls: every /api/export/photoreal* request is counted in a ledger and refused
// beyond the approved caps (default FLUX 20, Gemma 10; AI_CAP_FLUX / AI_CAP_GEMMA / AI_LEDGER per task). Saves the dialog's images and text, and every request
// image and answer of the run, under test-results/product-representation/ai/<label>/.
// Usage: node tests/product-representation/ai-run.mjs <label> <project id> <지금 방식|실험 C · 제품별 다듬기> <정면|오른쪽|뒤|왼쪽> [seed]
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { session, BASE, ROOT } from './lib.mjs';
const [label, id, method = '지금 방식', view = '정면', seedArg = '424242'] = process.argv.slice(2);
const SEED = Number(seedArg);
// The approved caps and their ledger can be set per task (AI_CAP_FLUX, AI_CAP_GEMMA, AI_LEDGER).
const CAP = {
  flux: Number(process.env.AI_CAP_FLUX ?? 20),
  gemma: Number(process.env.AI_CAP_GEMMA ?? 10),
};
const out = `${ROOT}/ai/${label}`;
mkdirSync(out, { recursive: true });
const ledgerFile = process.env.AI_LEDGER ?? `${ROOT}/ai/ledger.jsonl`;
const ledger = () =>
  existsSync(ledgerFile)
    ? readFileSync(ledgerFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const count = () => {
  const rows = ledger();
  return {
    flux: rows.filter((r) => r.kind === 'flux').length,
    gemma: rows.filter((r) => r.kind === 'gemma').length,
  };
};
const kindOf = (url) => (/\/photoreal\/check/.test(url) ? 'gemma' : 'flux');
const tag = `${method.replace(/[^가-힣A-Za-z0-9]+/g, '_')}-${view}`;
const TURNS = {
  정면: [],
  오른쪽: ['오른쪽으로 90° 돌리기'],
  뒤: ['오른쪽으로 90° 돌리기', '오른쪽으로 90° 돌리기'],
  왼쪽: ['왼쪽으로 90° 돌리기'],
};
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const before = count();
log('ledger before', JSON.stringify(before));
const s = await session();
const { page, context } = s;
// The seed of every conversion is random per click; fix it so the representations share one seed.
await context.addInitScript((seed) => {
  const original = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (array) =>
    array instanceof Uint32Array && array.length === 1 ? ((array[0] = seed), array) : original(array);
}, SEED);
// Experiment C cuts every answer out with the app's own background model (BiRefNet in a worker). Keep the
// worker's inputs and results (listening from outside; the app is untouched) to measure the outlines.
await context.addInitScript(() => {
  const Original = window.Worker;
  const save = (kind, id, blob) =>
    blob.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      window.__sjnSave?.(kind, id, btoa(text));
    });
  window.Worker = function (url, options) {
    const worker = new Original(url, options);
    if (options?.name === 'sjn-background-removal') {
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message, ...rest) => {
        if (message?.type === 'run' && message.blob) save('in', message.id, message.blob);
        return post(message, ...rest);
      };
      worker.addEventListener('message', (event) => {
        const data = event.data;
        if (data?.type === 'result' && data.result?.blob) save('out', data.id, data.result.blob);
      });
    }
    return worker;
  };
  window.Worker.prototype = Original.prototype;
});
await page.exposeFunction('__sjnSave', (kind, id, text) =>
  writeFileSync(`${out}/${tag}-bg${id}-${kind}.png`, Buffer.from(text, 'base64')),
);
let n = 0;
const answered = [];
const calls = [];
// REPLAY=<label of an earlier run>: serve that run's saved answers (same product, same seed) instead of
// calling the model again, so a run that broke half-way is not paid for twice. Only what it lacks is sent.
const replay = new Map();
if (process.env.REPLAY) {
  const dir = `${ROOT}/ai/${process.env.REPLAY}`;
  const names = existsSync(dir) ? readdirSync(dir) : [];
  // The kind of each saved call (room / product / check) comes from that run's calls.json when it has one.
  const urls = new Map();
  for (const name of names.filter((f) => f.endsWith('-calls.json')))
    for (const c of JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')).calls)
      urls.set(`${name.replace(/-calls\.json$/, '')}-call${c.index}`, c.url);
  for (const name of names) {
    const m = name.match(/^(.*)-call(\d+)-answer\.(jpg|png|webp|json)$/);
    if (!m) continue;
    const base = `${m[1]}-call${m[2]}`;
    const productFile = `${dir}/${base}-product.json`;
    const url = urls.get(base) ?? '';
    const key = /\/check$/.test(url)
      ? 'check'
      : existsSync(productFile)
        ? readFileSync(productFile, 'utf8')
        : existsSync(`${dir}/${base}-scene.json`)
          ? 'room'
          : undefined;
    const wanted = (process.env.REPLAY_ONLY ?? 'room,check,product').split(',');
    const kindOfKey = key === 'room' || key === 'check' ? key : 'product';
    if (key && wanted.includes(kindOfKey)) replay.set(key, { file: `${dir}/${name}`, ext: m[3] });
  }
  log('replay answers:', replay.size);
}
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', json: 'application/json' };
await page.route('**/api/export/photoreal**', async (route) => {
  const request = route.request();
  if (request.method() !== 'POST') return route.continue();
  const kind = kindOf(request.url());
  const index = ++n;
  const buf = request.postDataBuffer();
  let productKey;
  // Keep the request images (the model's input) and the answer.
  try {
    const form = await new Response(buf, {
      headers: { 'content-type': request.headers()['content-type'] },
    }).formData();
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') {
        writeFileSync(`${out}/${tag}-call${index}-${key}.json`, value);
        if (key === 'product') productKey = value;
      } else writeFileSync(`${out}/${tag}-call${index}-${key}.png`, Buffer.from(await value.arrayBuffer()));
    }
  } catch (e) {
    log('request parse failed', String(e).slice(0, 100));
  }
  const key = kind === 'gemma' ? 'check' : (productKey ?? 'room');
  const saved = key ? replay.get(key) : undefined;
  if (saved) {
    const body = readFileSync(saved.file);
    writeFileSync(`${out}/${tag}-call${index}-answer.${saved.ext}`, body);
    calls.push({
      index,
      kind,
      url: request.url().replace(BASE, ''),
      status: 200,
      replayed: true,
      bytes: body.length,
    });
    answered.push(index);
    log('REPLAY', kind, request.url().replace(BASE, ''), `call${index}`);
    return route.fulfill({ status: 200, body, contentType: MIME[saved.ext] });
  }
  const now = count();
  if (now[kind] >= CAP[kind]) {
    log('CAP REACHED, refusing', kind, JSON.stringify(now));
    return route.abort();
  }
  appendFileSync(
    ledgerFile,
    JSON.stringify({
      at: new Date().toISOString(),
      label,
      method,
      view,
      kind,
      url: request.url().replace(BASE, ''),
      index,
    }) + '\n',
  );
  const started = Date.now();
  try {
    const response = await route.fetch({ timeout: 300000 });
    const body = await response.body();
    const type = response.headers()['content-type'] ?? '';
    const ext = /json/.test(type)
      ? 'json'
      : /jpeg/.test(type)
        ? 'jpg'
        : /webp/.test(type)
          ? 'webp'
          : /png/.test(type)
            ? 'png'
            : 'bin';
    writeFileSync(`${out}/${tag}-call${index}-answer.${ext}`, body);
    calls.push({
      index,
      kind,
      url: request.url().replace(BASE, ''),
      status: response.status(),
      ms: Date.now() - started,
      bytes: body.length,
    });
    answered.push(index);
    log('API', kind, request.url().replace(BASE, ''), response.status(), `${Date.now() - started}ms`);
    return route.fulfill({ response, body });
  } catch (error) {
    calls.push({
      index,
      kind,
      url: request.url().replace(BASE, ''),
      error: String(error).slice(0, 200),
      ms: Date.now() - started,
    });
    log('API FAILED', kind, String(error).slice(0, 120));
    return route.abort();
  }
});
try {
  await page.goto(`${BASE}/projects/${id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await page.waitForTimeout(3000);
  const dialog = page.getByRole('dialog').last();
  for (const t of TURNS[view] ?? []) {
    await dialog.getByRole('button', { name: t, exact: true }).click();
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(1500);
  log(
    'view readout:',
    await dialog
      .getByTestId('flux-view-readout')
      .innerText()
      .catch(() => '?'),
  );
  const pill = dialog.getByRole('button', { name: method, exact: true });
  if (await pill.count()) await pill.first().click();
  else await dialog.getByText(method, { exact: true }).first().click();
  await page.waitForTimeout(800);
  const plan = (await dialog.innerText())
    .split('\n')
    .filter((l) => /다듬을 제품|AI 요청|뉴런/.test(l))
    .join(' / ');
  log('plan:', plan);
  await dialog.screenshot({ path: `${out}/${tag}-0-before.png` });
  await dialog.getByRole('button', { name: /AI 변환/ }).click();
  log('AI conversion started');
  let done = false;
  for (let i = 0; i < 140; i++) {
    await page.waitForTimeout(3000);
    if (i % 5 === 0) log('...', (await dialog.getByRole('alert').allInnerTexts()).join(' | ').slice(0, 160));
    if (await dialog.getByRole('button', { name: /다시 만들기/ }).count()) {
      done = true;
      break;
    }
  }
  log('done:', done);
  await page.waitForTimeout(4000);
  await dialog.screenshot({ path: `${out}/${tag}-1-result.png` });
  const imgs = await dialog.locator('img').evaluateAll(async (els) => {
    const res = [];
    for (const e of els) {
      if (e.naturalWidth < 200) continue;
      const c = document.createElement('canvas');
      c.width = e.naturalWidth;
      c.height = e.naturalHeight;
      c.getContext('2d').drawImage(e, 0, 0);
      res.push({
        alt: e.alt,
        w: e.naturalWidth,
        h: e.naturalHeight,
        data: c.toDataURL('image/png').split(',')[1],
      });
    }
    return res;
  });
  imgs.forEach((im, i) => {
    writeFileSync(`${out}/${tag}-img${i}.png`, Buffer.from(im.data, 'base64'));
    log('saved img', i, im.alt, `${im.w}x${im.h}`);
  });
  const text = await dialog.innerText();
  writeFileSync(`${out}/${tag}-text.txt`, text);
  // Experiment C's per-product outcomes (refined / kept, the reason, outline overlap, height ratio) live
  // only in the dialog's React state: read them from the fibre tree (nothing in the app is changed).
  const outcomes = await (
    await dialog.elementHandle()
  ).evaluate((root) => {
    const key = Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
    const found = [];
    const seen = new Set();
    const isOutcome = (o) =>
      o &&
      typeof o === 'object' &&
      typeof o.label === 'string' &&
      (o.status === 'refined' || o.status === 'kept');
    const visit = (value, depth) => {
      if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) return;
      seen.add(value);
      if (Array.isArray(value)) {
        if (value.length && value.every(isOutcome)) found.push(value);
        else for (const item of value.slice(0, 40)) visit(item, depth + 1);
        return;
      }
      if (value instanceof Node || value instanceof Blob || ArrayBuffer.isView(value)) return;
      for (const k of Object.keys(value).slice(0, 60)) visit(value[k], depth + 1);
    };
    for (let f = root[key], hops = 0; f && hops < 80; f = f.return, hops++) {
      for (let h = f.memoizedState, i = 0; h && typeof h === 'object' && i < 120; h = h.next, i++)
        visit(h.memoizedState, 0);
      visit(f.memoizedProps, 0);
    }
    const pick = ({ id, label, status, reason, message, detail, iou, plainIou, ratio }) => ({
      id,
      label,
      status,
      reason,
      message,
      detail,
      iou,
      plainIou,
      ratio,
    });
    return found.length ? found[0].map(pick) : [];
  });
  writeFileSync(`${out}/${tag}-outcomes.json`, JSON.stringify(outcomes, null, 1));
  if (outcomes.length) console.log('OUTCOMES', JSON.stringify(outcomes));
  writeFileSync(
    `${out}/${tag}-calls.json`,
    JSON.stringify({ label, method, view, seed: SEED, calls, answered, plan }, null, 1),
  );
  console.log(
    text
      .split('\n')
      .filter((l) => /변환 시간|확인|제품|경고|바뀌|생겼|색|구도|다듬|3D|유지|요청/.test(l))
      .slice(0, 30)
      .join('\n'),
  );
} finally {
  log('ledger after', JSON.stringify(count()));
  await s.close();
}
