/** Same procedural geometry/camera/light, actual observed material colours before and after; no AI inference. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { ProductColorEvidence } from '../src/lib/reconstruction/product-color';
import type { ReconstructionKind } from '../src/lib/reconstruction/types';
const root = 'test-results/reconstruction-product-color-20260914';
const output = root + '/final-colour-render';
await mkdir(output, { recursive: true });
const summary = JSON.parse(await readFile(root + '/final-observation-replay/summary.json', 'utf8')) as {
  cases: {
    id: string;
    entries: {
      id: string;
      kind: ReconstructionKind;
      pixels: number;
      before: string;
      after: ProductColorEvidence;
    }[];
  }[];
};
const selected = summary.cases.flatMap((item) =>
  ['basin', 'toilet', ...(item.id === 'user-04' ? ['vanity'] : [])].flatMap((kind) => {
    const candidate = item.entries
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => b.pixels - a.pixels)[0];
    return candidate ? [{ caseId: item.id, ...candidate }] : [];
  }),
);
const bundle = await build({
  stdin: {
    contents: `export {renderReconstructionTemplate} from './src/lib/reconstruction/templates';export {reconstructionDefaults} from './src/lib/reconstruction/types';export {DEFAULT_ROOM} from './src/lib/room-geometry';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const server = createServer((req, res) => {
  if (req.url === '/index.js')
    res.setHeader('Content-Type', 'text/javascript').end(bundle.outputFiles[0].text);
  else
    res
      .setHeader('Content-Type', 'text/html')
      .end('<html><link rel="icon" href="data:,"><body></body></html>');
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors: string[] = [],
  external: string[] = [];
const results = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.goto(origin);
  for (const item of selected) {
    const images = await page.evaluate(
      async ({ origin, item }) => {
        const api = await import(origin + '/index.js');
        const variant = item.kind === 'basin' ? 'wall' : undefined;
        const params = {
          ...api.reconstructionDefaults(item.kind, variant),
          kind: item.kind,
          basinVariant: variant,
          version: 2,
          room: api.DEFAULT_ROOM,
          face: item.kind === 'basin' ? 'back' : 'floor',
          u: 0.5,
          v: 0.5,
          aspect: 1.5,
          orientation: 'back',
          ...(item.kind === 'vanity' ? { bowlCount: 2 } : {}),
        };
        const images: Record<string, { data: string; hash: string }> = {};
        const to64 = (blob: Blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        for (const [label, color] of [
          ['before', item.before],
          ['after', item.after.color],
        ]) {
          const rendered = await api.renderReconstructionTemplate({ ...params, color });
          images[label] = {
            data: await to64(rendered.blob),
            hash: Array.from(
              new Uint8Array(await crypto.subtle.digest('SHA-256', await rendered.blob.arrayBuffer())),
              (n) => n.toString(16).padStart(2, '0'),
            ).join(''),
          };
        }
        return images;
      },
      { origin, item },
    );
    const stem = item.caseId + '-' + item.kind;
    for (const label of ['before', 'after'])
      await writeFile(output + '/' + stem + '-' + label + '.png', Buffer.from(images[label].data, 'base64'));
    results.push({
      ...item,
      files: { before: stem + '-before.png', after: stem + '-after.png' },
      beforeHash: images.before.hash,
      afterHash: images.after.hash,
    });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(
    output + '/verification.json',
    JSON.stringify(
      {
        scope:
          'Browser standard-model render, same geometry/camera/light per pair, real saved primary observation colours, no model execution or user-selected colour. Shape/placement here are deliberate default render fixtures, not detection success.',
        browser: browser.version(),
        rendering: 'Chrome headless / SwiftShader',
        bundleHash: createHash('sha256').update(bundle.outputFiles[0].text).digest('hex'),
        errors,
        external,
        results,
      },
      null,
      2,
    ),
  );
  const cards = results
    .map(
      (r) =>
        `<article><h2>${r.caseId} · ${r.kind}</h2><div class="pair"><figure><img src="${r.files.before}"><figcaption>이전 관측색 ${r.before}</figcaption></figure><figure><img src="${r.files.after}"><figcaption>새 표면색 ${r.after.color} · ${r.after.source}${r.after.requiresReview ? ' · 확인 필요' : ''}</figcaption></figure></div><p>${r.after.reasons.join(' ')}</p></article>`,
    )
    .join('');
  await writeFile(
    output + '/comparison.html',
    `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>실제 관측색의 표준 모형 비교</title><style>body{font:16px system-ui;max-width:1200px;margin:32px auto;padding:0 16px;color:#243534}article{border-top:1px solid #ccd5d3;padding:16px 0}.pair{display:flex;gap:20px}figure{width:50%;margin:0;background:#dde3e1}img{width:100%;height:330px;object-fit:contain}figcaption{padding:12px}p{line-height:1.6}@media(max-width:550px){img{height:230px}.pair{gap:6px}}</style><h1>같은 표준 모형의 색상 비교</h1><p>실제 저장된 DeepLab 내부 픽셀 관측을 재생했다. 양쪽 모형·카메라·조명은 같고 색 정책만 다르다. 여기의 형태·배치는 색 검증용 기본값이며 AI 형태·배치 성공을 의미하지 않는다. 어두운 따뜻한 도기는 원관측을 보존하고 확인 가능한 중립 기본색으로 표시한다. 사진 조명을 정확히 제거하거나 흰색 제품임을 인식했다고 주장하지 않는다.</p>${cards}</html>`,
  );
  console.log(JSON.stringify({ renderedPairs: results.length, errors, external, output }));
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
