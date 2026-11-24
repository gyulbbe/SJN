// Backlog item 5 (the AI draws the olive wall as grey stone): the olive scenes captured today with the
// app's prompt, copied as they are (input, masks, regions) into one results tree under three wall
// sentences. Only the olive wall's colour sentence changes; the picture, every other sentence and the
// seed stay the same, so an answer's difference is the sentence's.
//   cur  today: "grey (#6a6b51)" + "Keep this exact grey …; do not warm, yellow or tint it."
//   n1   "olive grey (#6a6b51)" + "Keep this exact olive grey …; do not turn it plain grey or change its hue."
//   n2   "olive (#6a6b51)" + "Keep this exact colour …; do not change its hue or saturation." (the
//        11-21 Cloudflare `ol` sentence, docs/glossy-tile-20261121.md)
//   n3   "olive green (#6a6b51)" + the n2 keep sentence: does a stronger name overshoot?
// Usage: node tests/olive-name/prepare.mjs
// Output: test-results/olive-name-20261124/{cur,n1,n2,n3}/scenes/<scene>/
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../side-tile-ai/paths.mjs';

export const OUT = join(ROOT, 'test-results', 'olive-name-20261124');
const SOURCES = [
  ['side-tile-ai-20261121', ['olive-0', 'olive-90']],
  ['big-fixture-20261124', ['bath-olive-0', 'bath-olive-90']],
  ['basin-shape-20261124', ['basin-ped-olive-0', 'basin-thin-olive-0']],
];
const OLIVE = '#6a6b51';
const TODAY = `grey (${OLIVE}) semi-gloss tiles`;
const TODAY_KEEP = 'Keep this exact grey as it appears in image 0; do not warm, yellow or tint it.';
export const SENTENCES = {
  cur: [TODAY, TODAY_KEEP],
  n1: [
    `olive grey (${OLIVE}) semi-gloss tiles`,
    'Keep this exact olive grey as it appears in image 0; do not turn it plain grey or change its hue.',
  ],
  n2: [
    `olive (${OLIVE}) semi-gloss tiles`,
    'Keep this exact colour as it appears in image 0; do not change its hue or saturation.',
  ],
  n3: [
    `olive green (${OLIVE}) semi-gloss tiles`,
    'Keep this exact colour as it appears in image 0; do not change its hue or saturation.',
  ],
};
const main = import.meta.url === pathToFileURL(process.argv[1]).href;
if (main)
  for (const [tree, scenes] of SOURCES)
    for (const scene of scenes) {
      const from = join(ROOT, 'test-results', tree, 'app', 'scenes', scene);
      const prompt = readFileSync(join(from, 'prompt.txt'), 'utf8');
      const at = prompt.indexOf(TODAY);
      const keepAt = prompt.indexOf(TODAY_KEEP, at);
      if (at < 0 || keepAt < 0 || prompt.indexOf(TODAY, at + 1) >= 0)
        throw new Error(`${scene}: the olive sentence is not there exactly once`);
      for (const [rev, [words, keep]] of Object.entries(SENTENCES)) {
        const to = join(OUT, rev, 'scenes', scene);
        if (!existsSync(to)) {
          mkdirSync(to, { recursive: true });
          cpSync(from, to, { recursive: true });
        }
        const text =
          prompt.slice(0, at) +
          words +
          prompt.slice(at + TODAY.length, keepAt) +
          keep +
          prompt.slice(keepAt + TODAY_KEEP.length);
        writeFileSync(join(to, 'prompt.txt'), text);
        writeFileSync(join(to, 'source.txt'), `${tree}/app/scenes/${scene}\n`);
      }
    }
if (main) console.log('prepared', SOURCES.flatMap((s) => s[1]).join(', '));
