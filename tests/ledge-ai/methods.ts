/**
 * What each method of the ledge AI trial sends (node, docs/ledge-ai-trials-20261111.md). A method is a
 * `+`-joined list of parts, each changing one thing of the app's request:
 *   cur            the app's request as it is (S0)
 *   w-ledge | w-step | w-plinth   the structure sentences in one wording (S1)
 *   emph           the capture with the ledge's faces shaded further apart (S2)
 *   elev           the capture from 12° above, with its own facts and prompt (S3)
 *   ref            a colour-coded diagram of the built shape as image 1 (S4)
 * S5 (putting the ledge back) and S6 (check, then one more try) work on results: post.ts, check.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLUX_PROMPT } from '../../src/lib/ai-export/contract';
import { FLUX_CUTAWAY_SENTENCE, FLUX_PROMPT_MAX_CHARS } from '../../src/lib/ai-export/prompt';
import { fluxNeurons } from '../export-photoreal/budget';
import {
  STRUCTURE_WORDINGS,
  structureSentences,
  type FluxStructure,
  type StructureWording,
} from './structures';

export const FLUX_4B = '@cf/black-forest-labs/flux-2-klein-4b';
export const SEEDS = [424242, 777001] as const;
export const REFERENCE_SENTENCE =
  'Image 1 is a colour-coded diagram of the same view: orange marks a tiled ledge standing out from the wall (pale orange its flat top), blue a niche set into the wall. Use it only to keep those shapes where they are; take the tiles, light and fixtures from image 0, never the diagram’s colours.';

export type MethodParts = { wording?: StructureWording; emph: boolean; elev: boolean; ref: boolean };
export function parseMethod(method: string): MethodParts {
  const parts: MethodParts = { emph: false, elev: false, ref: false };
  const tokens = method.split('+');
  if (new Set(tokens).size !== tokens.length) throw new Error(`method ${method}: a part twice`);
  for (const token of tokens) {
    if (token === 'cur') {
      if (tokens.length > 1) throw new Error(`method ${method}: cur stands alone`);
    } else if (token === 'emph') parts.emph = true;
    else if (token === 'elev') parts.elev = true;
    else if (token === 'ref') parts.ref = true;
    else if (token.startsWith('w-') && (STRUCTURE_WORDINGS as readonly string[]).includes(token.slice(2))) {
      if (parts.wording) throw new Error(`method ${method}: two wordings`);
      parts.wording = token.slice(2) as StructureWording;
    } else throw new Error(`method ${method}: unknown part ${token}`);
  }
  // Each capture variant was rendered on its own.
  if (parts.emph && parts.elev) throw new Error(`method ${method}: emph and elev are separate captures`);
  return parts;
}
export const methodLabel = (method: string) =>
  method === 'cur'
    ? '지금 방식'
    : method
        .split('+')
        .map(
          (token) =>
            ({
              'w-ledge': '구조 문장(ledge)',
              'w-step': '구조 문장(wall step)',
              'w-plinth': '구조 문장(false wall)',
              emph: '면 강조',
              elev: '12° 위에서',
              ref: '구조 참고 그림',
            })[token] ?? token,
        )
        .join(' + ');

/**
 * The added sentences right after the cutaway sentence, inside the app's 2,400 characters. When the
 * whole is too long: the last fixtures lose their detail first (as in the app's own prompt), then the
 * added sentences take their compact form, then the last fixtures are no longer listed (the count
 * summary stays).
 */
export function withSentences(prompt: string, full: string, compact = full): string {
  const anchor = prompt.includes(FLUX_CUTAWAY_SENTENCE) ? FLUX_CUTAWAY_SENTENCE : FLUX_PROMPT;
  const at = prompt.indexOf(anchor);
  if (at < 0) throw new Error('the prompt does not start with the app instruction');
  const end = at + anchor.length;
  const compose = (base: string, added: string) => `${base.slice(0, end)} ${added}${base.slice(end)}`;
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
    if (cut(detail)) continue;
    if (added !== compact) added = compact;
    else if (!cut(listed)) throw new Error(`the prompt stays over ${FLUX_PROMPT_MAX_CHARS} characters`);
  }
  return compose(base, added);
}

export type PngSize = { width: number; height: number };
export const pngSize = (bytes: Buffer): PngSize => ({
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});
export type FluxRequest = {
  method: string;
  /** Image 0 and the references after it. */
  images: Buffer[];
  prompt: string;
  /** The input's size; the answer is twice it, as the app asks. */
  width: number;
  height: number;
  estimate: number;
};
/** The FLUX request of one method for a scene folder (written by scenes.ts). */
export function fluxRequest(method: string, dir: string): FluxRequest {
  const parts = parseMethod(method);
  const from = parts.elev ? join(dir, 'elev') : dir;
  const current = readFileSync(join(from, 'prompt-current.txt'), 'utf8');
  const structures = JSON.parse(readFileSync(join(from, 'structures.json'), 'utf8')) as FluxStructure[];
  const added = (compact: boolean) =>
    [
      parts.wording ? structureSentences(structures, parts.wording, compact) : '',
      parts.ref ? REFERENCE_SENTENCE : '',
    ]
      .filter(Boolean)
      .join(' ');
  const images = [
    readFileSync(join(from, parts.emph ? 'input-emph.png' : 'input.png')),
    ...(parts.ref ? [readFileSync(join(dir, 'ref-structure.png'))] : []),
  ];
  const size = pngSize(images[0]);
  return {
    method,
    images,
    prompt: added(false) ? withSentences(current, added(false), added(true)) : current,
    ...size,
    estimate: fluxNeurons(images.map(pngSize), { width: size.width * 2, height: size.height * 2 }),
  };
}
