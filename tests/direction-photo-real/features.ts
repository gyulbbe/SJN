/**
 * Trial (G2, docs/direction-photo-results-20261013.md section 5): per-direction sentences the server
 * would write from Gemma's enum answers, short, one thing each, mostly what this direction shows and
 * what it does not. Fixed templates only: nothing from the photo is written into them.
 *
 * Usage: node tests/run-browser-test.mjs tests/direction-photo-real/features.ts <analysis answer json> <out json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { DirectionPhotoView } from '../../src/lib/direction-photo/contract';

export type ToiletFeatures = {
  toiletBody?: string;
  topFeature?: string;
  printLocation?: string;
  printKind?: string;
  controlSide?: string;
  bidetUnit?: string;
};

const PRINT_NOUN: Record<string, string> = { face: 'face', logo: 'logo', pattern: 'pattern' };

/** The sentences for one direction, in a fixed order. */
export function featureSentences(features: ToiletFeatures, view: DirectionPhotoView): string[] {
  const lines: string[] = [];
  const tankless = features.toiletBody === 'tankless-bidet';
  if (tankless)
    lines.push(
      'There is no water tank: the low housing at the back is an electronic bidet unit, no taller than the back of the closed lid.',
    );
  if (features.topFeature === 'ears' && !tankless)
    lines.push('Two small rounded ears stick up from the top corners of the tank.');
  const print = PRINT_NOUN[features.printKind ?? ''];
  if (print && features.printLocation === 'tank-front' && !tankless)
    lines.push(
      view === 'front'
        ? `The printed ${print} on the front of the tank is visible; keep it exactly where image 1 shows it.`
        : `The ${print} printed on the front of the tank is not visible in this view.`,
    );
  const side =
    features.controlSide === 'right-side' ? 'right' : features.controlSide === 'left-side' ? 'left' : '';
  if (side && view !== 'front' && view !== 'back') {
    const [thing, part] = tankless ? ['The control buttons are', 'housing'] : ['A flush lever is', 'tank'];
    lines.push(
      view === side
        ? `${thing} on the side of the ${part} facing the camera.`
        : `${thing.replace(/^A /, 'The ')} on the other side of the ${part}, not visible in this view.`,
    );
  }
  return lines;
}

// After the runner and this file: write the sentences of an analysis answer for front, left and right.
const [answerFile, out] = process.argv.slice(3);
if (answerFile && out) {
  const { answer } = JSON.parse(readFileSync(answerFile, 'utf8')) as { answer: ToiletFeatures };
  const sentences = Object.fromEntries(
    (['front', 'left', 'right'] as const).map((view) => [view, featureSentences(answer, view).join(' ')]),
  );
  writeFileSync(out, JSON.stringify(sentences, null, 2));
  console.log(sentences);
}
