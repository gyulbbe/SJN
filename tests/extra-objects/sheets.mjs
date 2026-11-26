// Backlog item 8 (objects nobody placed): the saved answers asked with main's prompt, finished by today's
// app refine (a7c250a), next to their design: one tile per answer, design | AI answer | app result, for
// counting the objects the design does not have. No AI call.
//   node tests/extra-objects/sheets.mjs
// Output: test-results/extra-objects-20261126/sheet-NN.png, list.json
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';

export const OUT = join(ROOT, 'test-results', 'extra-objects-20261126');
// [tree, finished folder (today's app refine), engine]
export const SETS = [
  ['big-fixture-20261124/app', 'refined-app45', 'local'],
  ['basin-shape-20261124/app', 'refined-app45', 'local'],
  ['side-tile-ai-20261121/after', 'refined-app45', 'local'],
  ['photo-colour-20261126/cur', 'refined-app45', 'local'],
  ['olive-dark-cf-20261125/cur', 'refined-app45', 'cloudflare'],
  ['room-depth-20261123/cf/app', 'refined-app45', 'cloudflare'],
  ['big-fixture-20261124/cf/app', 'refined-new46', 'cloudflare'],
  ['cutout-held-20261126/app', 'refined-new46', 'cloudflare'],
];
export function answers() {
  const list = [];
  for (const [tree, finished, engine] of SETS) {
    const root = join(ROOT, 'test-results', ...tree.split('/'));
    for (const file of readdirSync(join(root, finished)).filter((f) => f.endsWith('.png'))) {
      const id = file.slice(0, -4);
      list.push({
        key: `${tree}/${id}`,
        engine,
        design: join(root, 'scenes', id.replace(/-\d+$/, ''), 'capture.png'),
        answer: join(root, 'original', file),
        result: join(root, finished, file),
      });
    }
  }
  return list;
}
if (process.argv[1]?.endsWith('sheets.mjs')) {
  mkdirSync(OUT, { recursive: true });
  const list = answers().filter((a) => existsSync(a.answer));
  const T = 420,
    H = Math.round((T * 672) / 992),
    PER = 8;
  const label = (s, w) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="26"><text x="4" y="19" font-family="Malgun Gothic, sans-serif" font-size="17" font-weight="700" fill="#111">${s}</text></svg>`,
    );
  for (let s = 0; s * PER < list.length; s++) {
    const chunk = list.slice(s * PER, (s + 1) * PER);
    const composite = [];
    for (const [i, a] of chunk.entries()) {
      const col = i % 2,
        row = Math.floor(i / 2);
      const left = col * (3 * T + 30),
        top = row * (H + 34);
      composite.push({ input: label(`${s * PER + i + 1}. ${a.key}`, 3 * T), left, top });
      const imgs = await Promise.all(
        [a.design, a.answer, a.result].map((f) =>
          sharp(f).removeAlpha().resize(T, H, { fit: 'fill' }).png().toBuffer(),
        ),
      );
      imgs.forEach((input, k) => composite.push({ input, left: left + k * T, top: top + 26 }));
    }
    const rows = Math.ceil(chunk.length / 2);
    await sharp({
      create: { width: 2 * (3 * T) + 30, height: rows * (H + 34), channels: 3, background: '#ffffff' },
    })
      .composite(composite)
      .png()
      .toFile(join(OUT, `sheet-${String(s + 1).padStart(2, '0')}.png`));
  }
  writeFileSync(
    join(OUT, 'list.json'),
    JSON.stringify(
      list.map((a, i) => ({ n: i + 1, ...a })),
      null,
      1,
    ),
  );
  console.log(list.length, 'answers,', Math.ceil(list.length / PER), 'sheets');
}
