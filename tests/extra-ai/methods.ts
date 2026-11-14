/**
 * What each method of the added-objects trial sends (node, docs/extra-ai-trials-20261114.md):
 *   cur        the app's request as it is (O0)
 *   names      a sentence naming the common bathroom objects this design does not have, right after
 *              the cutaway sentence (O1)
 *   names-end  the same sentence at the very end, after the fixture count (O1e)
 * O2 (check, then another seed) and O3 (erasing) work on results: check.ts, post.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLUX_PROMPT } from '../../src/lib/ai-export/contract';
import { FLUX_CUTAWAY_SENTENCE, FLUX_PROMPT_MAX_CHARS } from '../../src/lib/ai-export/prompt';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { fluxNeurons } from '../export-photoreal/budget';
import { pngSize } from '../ledge-ai/methods';

export { FLUX_4B, SEEDS } from '../ledge-ai/methods';
export const METHODS = ['cur', 'names', 'names-end'] as const;
export type Method = (typeof METHODS)[number];

type Kind = FluxScene['fixtures'][number]['kind'];
/**
 * The objects the model added in earlier trials (11-04, 11-11, 11-13), as words, each with the placed
 * kinds that make it part of the design (then it is not named).
 */
const ADDED: { words: string; short: string; unless: readonly Kind[] }[] = [
  { words: 'toilet-paper holder', short: 'toilet-paper holder', unless: [] },
  { words: 'towel bar', short: 'towel bar', unless: [] },
  { words: 'hook', short: '', unless: [] },
  { words: 'shelf', short: 'shelf', unless: ['wallShelf'] },
  { words: 'mirror', short: 'mirror', unless: ['mirror', 'mirrorCabinet'] },
  { words: 'wall cabinet', short: '', unless: ['wallCabinet', 'mirrorCabinet', 'vanity'] },
  { words: 'glass shower screen', short: 'glass screen', unless: ['glassPartition', 'showerCurtain'] },
  { words: 'window', short: 'window', unless: ['window'] },
  { words: 'door', short: 'door', unless: ['door'] },
  { words: 'door handle', short: 'handle', unless: ['door'] },
];
/** The added-objects sentence for a scene's placed fixtures: full, and a compact form for long prompts. */
export function addedObjectsSentence(placed: readonly Kind[]): { full: string; compact: string } {
  const named = ADDED.filter((item) => !item.unless.some((kind) => placed.includes(kind)));
  const list = (words: string[]) =>
    words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : (words[0] ?? '');
  const second = [placed.includes('toilet') ? 'toilet' : '', placed.includes('basin') ? 'washbasin' : '']
    .filter(Boolean)
    .join(' or ');
  return {
    full: `These objects are not in this design and must not appear anywhere in the picture: no ${list(named.map((item) => item.words))}${second ? `, and no second ${second}` : ''}.`,
    compact: `No ${list(named.map((item) => item.short).filter(Boolean))} anywhere${second ? `; no second ${second}` : ''}.`,
  };
}

/**
 * The prompt with a sentence added after the cutaway sentence (`front`) or at the end. When the whole
 * is too long the sentence takes its compact form first (so the fixtures keep the current method's
 * words where it can), then the last fixtures lose their detail (as the app's prompt does), then they
 * are no longer listed (the count summary stays).
 */
export function withSentence(prompt: string, full: string, compact: string, at: 'front' | 'end'): string {
  const anchor = prompt.includes(FLUX_CUTAWAY_SENTENCE) ? FLUX_CUTAWAY_SENTENCE : FLUX_PROMPT;
  const end = prompt.indexOf(anchor) + anchor.length;
  if (end < anchor.length) throw new Error('the prompt does not start with the app instruction');
  const compose = (base: string, added: string) =>
    at === 'front' ? `${base.slice(0, end)} ${added}${base.slice(end)}` : `${base} ${added}`;
  const detail =
    / \(x \d+–\d+%, y \d+–\d+%\), on the (?:floor|back wall|left wall|right wall)(, about [\d ×]+ mm \(W × H × D\))?(?=\. It must remain)/g;
  const listed = / \d+\. A [^.]*\. It must remain [^.]*\./g;
  let base = prompt,
    added = full;
  const cut = (pattern: RegExp) => {
    const last = [...base.matchAll(pattern)].at(-1);
    if (last) base = base.slice(0, last.index) + base.slice(last.index + last[0].length);
    return !!last;
  };
  while (compose(base, added).length > FLUX_PROMPT_MAX_CHARS) {
    if (added !== compact) added = compact;
    else if (!cut(detail) && !cut(listed))
      throw new Error(`the prompt stays over ${FLUX_PROMPT_MAX_CHARS} characters`);
  }
  return compose(base, added);
}

export type FluxRequest = {
  method: string;
  images: Buffer[];
  prompt: string;
  width: number;
  height: number;
  out: { width: number; height: number };
  estimate: number;
};
/** The FLUX request of one method for a scene folder (written by scenes.ts). */
export function fluxRequest(method: string, dir: string): FluxRequest {
  if (!(METHODS as readonly string[]).includes(method)) throw new Error(`unknown method ${method}`);
  const current = readFileSync(join(dir, 'prompt-current.txt'), 'utf8');
  const { scene } = JSON.parse(readFileSync(join(dir, 'grounding.json'), 'utf8')) as { scene: FluxScene };
  const sentence = addedObjectsSentence(scene.fixtures.map((fixture) => fixture.kind));
  const prompt =
    method === 'cur'
      ? current
      : withSentence(current, sentence.full, sentence.compact, method === 'names' ? 'front' : 'end');
  const image = readFileSync(join(dir, 'input.png'));
  const size = pngSize(image);
  const out = { width: size.width * 2, height: size.height * 2 };
  return { method, images: [image], prompt, ...size, out, estimate: fluxNeurons([size], out) };
}
