// Backlog item 5, step 31: the Cloudflare tree for "dark olive" (the app's prompt after 3208c5a). Today's app
// captures (capture.ts --rev app, SIDE_TILE_OUT=test-results/olive-dark-cf-20261125) are the step-29 inputs
// byte for byte. main's "grey" answers and the rejected "olive" answers of step 29 are reused only where
// the saved answer's input and prompt hashes equal today's input and that sentence's prompt (same model,
// seed 424242, twice the input's size: cloud.ts asked them so).
//   a1   the app's prompt as captured ("dark olive")
//   cur  the same prompt with main's grey sentence, answer from olive-name-cf-20261124/cur
//   n2   the same prompt with the step-29 "olive" sentence, answer from olive-name-cf-20261124/n2
// Usage: node tests/olive-name/dark-setup.mjs
// Output: test-results/olive-dark-cf-20261125/{a1,cur,n2}/scenes/<scene>/, {cur,n2}/raw/ and a table
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../side-tile-ai/paths.mjs';
import { ALTERNATIVES } from './alt.mjs';
import { CF_OUT } from './reuse.mjs';

export const DARK_OUT = join(ROOT, 'test-results', 'olive-dark-cf-20261125');
export const DARK_SCENES = ['olive-0', 'olive-90', 'bath-olive-0', 'bath-olive-90'];
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
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
if (import.meta.url === pathToFileURL(process.argv[1]).href)
  for (const scene of DARK_SCENES) {
    const app = join(DARK_OUT, 'app', 'scenes', scene);
    const input = readFileSync(join(app, 'input.png'));
    const prompt = readFileSync(join(app, 'prompt.txt'), 'utf8');
    // The app's sentence must be step 30's a1, word for word, on the same scene.
    const local = readFileSync(
      join(ROOT, 'test-results', 'olive-alt-20261125', 'a1', 'scenes', scene, 'prompt.txt'),
      'utf8',
    );
    if (prompt !== local) throw new Error(`${scene}: app prompt is not step 30's a1`);
    const row = [scene.padEnd(14), 'input', sha(input)];
    for (const rev of ['a1', 'cur', 'n2']) {
      const text = rev === 'a1' ? prompt : swap(prompt, ALTERNATIVES.a1, ALTERNATIVES[rev]);
      const to = join(DARK_OUT, rev, 'scenes', scene);
      if (!existsSync(to)) {
        mkdirSync(to, { recursive: true });
        cpSync(app, to, { recursive: true });
      }
      writeFileSync(join(to, 'prompt.txt'), text);
      if (rev === 'a1') continue;
      const saved = join(CF_OUT, rev, 'raw', `${scene}-424242.json`);
      if (!existsSync(saved)) {
        row.push(`${rev}: none saved`);
        continue;
      }
      const j = JSON.parse(readFileSync(saved, 'utf8'));
      const same = j.input === sha(input) && j.prompt === sha(text) && j.seed === 424242;
      row.push(
        `${rev}: input ${j.input === sha(input) ? '=' : '≠'} prompt ${j.prompt === sha(text) ? '=' : '≠'}`,
      );
      if (!same) continue;
      mkdirSync(join(DARK_OUT, rev, 'raw'), { recursive: true });
      for (const ext of ['png', 'json'])
        cpSync(saved.replace(/\.json$/, `.${ext}`), join(DARK_OUT, rev, 'raw', `${scene}-424242.${ext}`));
      row.push('reused');
    }
    console.log(row.join(' '));
  }
