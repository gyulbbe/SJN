// Backlog item 5, step 30: after "olive" (n2) lost the bath front on Cloudflare (wider reflection and
// patchy shading on the bath's front, step 29), local alternatives on today's app captures (the step-29
// Cloudflare inputs, olive-name-cf-20261124/n2/scenes), same input, only the olive wall sentence:
//   cur  main: "grey (#6a6b51)" + "Keep this exact grey …; do not warm, yellow or tint it."
//   n2   step 29: "olive" + "do not change its hue or saturation"
//   a1   "dark olive": the wall is dark (L* 42); the answers came back 10–20 L* lighter
//   a2   "olive" + keep its darkness, no light reflections on it
//   a3   a1 and a2 together
// Usage: node tests/olive-name/alt.mjs
// Output: test-results/olive-alt-20261125/<rev>/scenes/<scene>/
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../side-tile-ai/paths.mjs';
import { SENTENCES } from './prepare.mjs';
import { CF_OUT } from './reuse.mjs';

export const ALT_OUT = join(ROOT, 'test-results', 'olive-alt-20261125');
const OLIVE = '#6a6b51';
const DARK_KEEP =
  'Keep this exact colour and darkness as in image 0; do not change its hue or saturation or lighten it; no broad reflections on these tiles.';
export const ALTERNATIVES = {
  cur: SENTENCES.cur,
  n2: SENTENCES.n2,
  a1: [`dark olive (${OLIVE}) semi-gloss tiles`, SENTENCES.n2[1]],
  a2: [SENTENCES.n2[0], DARK_KEEP],
  a3: [`dark olive (${OLIVE}) semi-gloss tiles`, DARK_KEEP],
};
export const ALT_SCENES = ['bath-olive-0', 'bath-olive-90', 'olive-0', 'olive-90'];
const swap = (text, [fromWords, fromKeep], [toWords, toKeep]) => {
  const at = text.indexOf(fromWords);
  const keepAt = text.indexOf(fromKeep, at);
  if (at < 0 || keepAt < 0 || text.indexOf(fromWords, at + 1) >= 0)
    throw new Error('olive sentence not there once');
  return (
    text.slice(0, at) +
    toWords +
    text.slice(at + fromWords.length, keepAt) +
    toKeep +
    text.slice(keepAt + fromKeep.length)
  );
};
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const scene of ALT_SCENES) {
    const from = join(CF_OUT, 'n2', 'scenes', scene);
    const prompt = readFileSync(join(from, 'prompt.txt'), 'utf8');
    for (const [rev, sentence] of Object.entries(ALTERNATIVES)) {
      const to = join(ALT_OUT, rev, 'scenes', scene);
      if (!existsSync(to)) {
        mkdirSync(to, { recursive: true });
        cpSync(from, to, { recursive: true });
      }
      writeFileSync(join(to, 'prompt.txt'), swap(prompt, SENTENCES.n2, sentence));
    }
    // The main prompt must be the one the step-29 Cloudflare `cur` answer was asked with.
    const main = readFileSync(join(ALT_OUT, 'cur', 'scenes', scene, 'prompt.txt'), 'utf8');
    if (main !== readFileSync(join(CF_OUT, 'cur', 'scenes', scene, 'prompt.txt'), 'utf8'))
      throw new Error(`${scene}: main prompt differs`);
  }
  console.log('prepared', Object.keys(ALTERNATIVES).join(', '), 'for', ALT_SCENES.join(', '));
}
