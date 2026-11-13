/**
 * What each method of the tile AI trial sends (node, docs/tile-ai-trials-20261113.md). A method is a
 * `+`-joined list of parts, each changing one thing of the app's request:
 *   cur      the app's request as it is (T0)
 *   grout    image 0 with the joints at least 1.25 input pixels wide, in the catalogue's colour (T1)
 *   groutc   the same in a colour that stands out from the tile (T1)
 *   groutu   grout, and a tile scored into a grid of rectangles is laid as those rectangles (T1)
 *   units    the tile counts of the faces and the rectangles a tile is scored into, in words (T2)
 *   sample   the wall tile laid flat and close as image 1 (T3)
 *   bigout   the answer at three times the model input instead of twice (T4)
 *   bigin    image 0 at twice the model input, 992 px (T5; Cloudflare's guide says under 512)
 * T6 (putting the joints back) works on results: post.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fluxNeurons } from '../export-photoreal/budget';
import { pngSize, withSentences, type PngSize } from '../ledge-ai/methods';
import { tileCountSentence, tileSampleSentence, type TileFacts } from './sentences';

export { FLUX_4B, SEEDS } from '../ledge-ai/methods';
export const PARTS = ['grout', 'groutc', 'groutu', 'units', 'sample', 'bigout', 'bigin'] as const;
export type Part = (typeof PARTS)[number];
/** The parts that are their own picture of image 0, and its file. */
const CAPTURES = ['grout', 'groutc', 'groutu', 'bigin'] as const;
const CAPTURE_FILE: Record<(typeof CAPTURES)[number], string> = {
  grout: 'input-grout.png',
  groutc: 'input-groutc.png',
  groutu: 'input-groutu.png',
  bigin: 'input-992.png',
};

export function parseMethod(method: string): Set<Part> {
  const tokens = method.split('+');
  if (new Set(tokens).size !== tokens.length) throw new Error(`method ${method}: a part twice`);
  if (tokens.includes('cur')) {
    if (tokens.length > 1) throw new Error(`method ${method}: cur stands alone`);
    return new Set();
  }
  for (const token of tokens)
    if (!(PARTS as readonly string[]).includes(token))
      throw new Error(`method ${method}: unknown part ${token}`);
  const parts = new Set(tokens as Part[]);
  // Each of these is its own picture of image 0.
  if (CAPTURES.filter((part) => parts.has(part)).length > 1)
    throw new Error(`method ${method}: ${CAPTURES.join(', ')} are separate captures`);
  return parts;
}
const LABELS: Record<Part, string> = {
  grout: '줄눈 굵게',
  groutc: '줄눈 굵고 진하게',
  groutu: '줄눈 굵게(타일 안의 칸까지)',
  units: '타일 수 문장',
  sample: '타일 견본 그림',
  bigout: '큰 출력',
  bigin: '큰 입력',
};
export const methodLabel = (method: string) =>
  method === 'cur'
    ? '지금 방식'
    : method
        .split('+')
        .map((token) => LABELS[token as Part] ?? token)
        .join(' + ');

export type FluxRequest = {
  method: string;
  /** Image 0 and the references after it. */
  images: Buffer[];
  prompt: string;
  /** Image 0's size. */
  width: number;
  height: number;
  /** The answer's size. */
  out: PngSize;
  estimate: number;
};
/** The FLUX request of one method for a scene folder (written by scenes.ts). */
export function fluxRequest(method: string, dir: string): FluxRequest {
  const parts = parseMethod(method);
  const current = readFileSync(join(dir, 'prompt-current.txt'), 'utf8');
  const tiles = JSON.parse(readFileSync(join(dir, 'tiles.json'), 'utf8')) as {
    facts: TileFacts;
    sampleMm: [number, number];
  };
  const added = (compact: boolean) =>
    [
      parts.has('units') ? tileCountSentence(tiles.facts, compact) : '',
      parts.has('sample') ? tileSampleSentence(tiles.sampleMm) : '',
    ]
      .filter(Boolean)
      .join(' ');
  const capture = CAPTURES.find((part) => parts.has(part));
  const image0 = capture ? CAPTURE_FILE[capture] : 'input.png';
  const images = [
    readFileSync(join(dir, image0)),
    ...(parts.has('sample') ? [readFileSync(join(dir, 'sample-wall.png'))] : []),
  ];
  const size = pngSize(images[0]);
  // The app asks for twice the 496 px input whatever image 0's own size is.
  const base = pngSize(readFileSync(join(dir, 'input.png')));
  const times = parts.has('bigout') ? 3 : 2;
  const out = { width: base.width * times, height: base.height * times };
  return {
    method,
    images,
    prompt: added(false) ? withSentences(current, added(false), added(true)) : current,
    ...size,
    out,
    estimate: fluxNeurons(images.map(pngSize), out),
  };
}
