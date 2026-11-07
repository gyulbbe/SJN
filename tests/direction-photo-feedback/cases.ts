/**
 * The "고칠 점" trial (docs/direction-photo-feedback-20261107.md): five answers that failed on Cloudflare
 * in the 2026-11-07 sanitary-ware trial, sent back with what to change. No I/O here (checked by
 * tests/direction-photo-feedback.test.ts).
 *
 * Two ways to send the earlier answer, within the model's four images:
 * - A: the guide stays image 0, the product photo is image 1 and the earlier answer image 2; the
 *   app's prompt, then the app's feedback paragraph (src/lib/direction-photo/prompt.ts).
 * - B: the earlier answer is image 0 ("change this photo"), the product photo image 1, the guide
 *   image 2; a prompt of its own.
 * Two kinds of words: the quick fix (an English sentence the server writes) or the person's own words
 * in Korean, as typed.
 *
 * The trial ran with five quick fixes; the app kept three (colour, background, extras) and dropped the
 * view and the shape after the Cloudflare check (the user's decision, 11-07). Their sentences stay here
 * as they were sent, so the trial runs as it ran.
 */
import { tidyFeedbackText, type DirectionPhotoFix } from '../../src/lib/direction-photo/contract';
import { feedbackSentence } from '../../src/lib/direction-photo/prompt';

/** The trial's quick fixes: the app's three and the two it dropped. */
export type TrialFix = DirectionPhotoFix | 'straight' | 'shape';
const TRIAL_FIXES: readonly TrialFix[] = ['straight', 'colour', 'background', 'extras', 'shape'];
type TrialFeedback = { fixes: TrialFix[]; text: string };
/** The dropped fixes' sentences as the trial sent them in way A (image k: the earlier answer). */
const DROPPED: Record<'straight' | 'shape', (k: number) => string> = {
  straight: (k) =>
    `Image ${k} is turned toward the camera or seen at a slant; make the view exactly that of image 0, straight on, with no perspective and no turn.`,
  shape: (k) =>
    `The shape or proportions in image ${k} differ from image 0; keep the outline, proportions and size exactly as in image 0.`,
};
/**
 * Way A's paragraph as sent on 11-07: the app's (`feedbackSentence`), and for a dropped fix (always
 * alone in this trial) its sentence right after the paragraph's first one, as the app put it then.
 */
export function trialParagraph(feedback: TrialFeedback, k: number): string {
  const dropped = feedback.fixes.find((fix) => fix === 'straight' || fix === 'shape');
  if (!dropped)
    return feedbackSentence({ fixes: feedback.fixes as DirectionPhotoFix[], text: feedback.text }, k);
  if (feedback.fixes.length !== 1) throw new Error('a dropped fix goes alone in this trial');
  const frame = feedbackSentence({ fixes: [], text: feedback.text }, k);
  const head = `Image ${k} is an earlier attempt at this photo that the person wants changed.`;
  if (!frame.startsWith(`${head} `)) throw new Error('the app paragraph changed its first sentence');
  return `${head} ${DROPPED[dropped](k)} ${frame.slice(head.length + 1)}`;
}

export type FeedbackCase = {
  id: string;
  view: 'front' | 'left' | 'right' | 'back';
  /** The method of the earlier answer (its prompt is that method's). */
  method: 'G' | 'G2';
  fix: TrialFix;
  ko: string;
  /** What was wrong with it, in plain words. */
  fault: string;
};
export const CASES: FeedbackCase[] = [
  {
    id: 'B1',
    view: 'left',
    method: 'G',
    fix: 'straight',
    ko: '옆에서 똑바로 본 모습으로 그려 주세요',
    fault: '사선으로 돎',
  },
  { id: 'B6', view: 'left', method: 'G', fix: 'colour', ko: '사진처럼 흰색으로 해 주세요', fault: '회색' },
  {
    id: 'B15',
    view: 'left',
    method: 'G',
    fix: 'background',
    ko: '벽과 그림자를 없애 주세요',
    fault: '벽 그림자',
  },
  {
    id: 'U2',
    view: 'left',
    method: 'G2',
    fix: 'extras',
    ko: '위에 있는 큰 상자를 빼 주세요',
    fault: '큰 상자가 생김',
  },
  {
    id: 'B12',
    view: 'left',
    method: 'G2',
    fix: 'shape',
    ko: '가이드 모양대로 실제 사진처럼 그려 주세요',
    fault: '선 그림',
  },
];
export const FRAMES = ['A', 'B'] as const;
export type Frame = (typeof FRAMES)[number];
/** `none`: the control, way A with the earlier answer and the paragraph but nothing asked. */
export const WORDS = ['fix', 'ko', 'none'] as const;
export type Words = (typeof WORDS)[number];

export const feedbackOf = (c: FeedbackCase, words: Words): TrialFeedback =>
  words === 'fix'
    ? { fixes: [c.fix], text: '' }
    : { fixes: [], text: words === 'ko' ? tidyFeedbackText(c.ko) : '' };

/** B's quick fixes: the earlier answer is image 0 and the guide image 2. */
const B_FIXES: Record<TrialFix, string> = {
  straight:
    'Image 0 is turned toward the camera or seen at a slant; make the view exactly that of image 2, straight on, with no perspective and no turn.',
  colour:
    "The colour or material in image 0 is not the real product's; take the colour, material and finish from image 1.",
  background:
    'Image 0 shows a wall, a floor or a shadow; draw the product alone on pure white, with no wall, no floor and no cast shadow.',
  extras:
    'Image 0 has parts the real product does not have; leave out everything that is not on the real product in image 1.',
  shape:
    'The shape or proportions in image 0 differ from image 2; keep the outline, proportions and size exactly as in image 2.',
};

/**
 * The prompt of a case: A is the earlier answer's own prompt (`base`, one product photo) and the app's
 * feedback paragraph about image 2; B tells the model to change image 0.
 */
export function promptOf(base: string, c: FeedbackCase, frame: Frame, words: Words): string {
  const feedback = feedbackOf(c, words);
  if (frame === 'A') return `${base} ${trialParagraph(feedback, 2)}`;
  const fixes = TRIAL_FIXES.filter((fix) => feedback.fixes.includes(fix)).map((fix) => B_FIXES[fix]);
  return [
    'Image 0 is an earlier attempt at a studio product photograph of this product from this view, and the person wants it changed.',
    'Image 2 is a plain grey 3D render of the same view: it fixes the exact shape, outline, proportions, camera angle and position in the frame.',
    'Image 1 is a photo of the real product taken from another angle: use it only for the material, colour and small details, never for the shape, the camera angle or the position.',
    ...fixes,
    feedback.text
      ? `The person's request about image 0, in their own words: "${feedback.text.replaceAll('"', "'")}".`
      : '',
    'Change image 0 only as asked and keep everything else as it is: a photorealistic studio product photograph on a pure white seamless background (#FFFFFF), soft even studio lighting, no props, no floor texture, no text, no watermark.',
  ]
    .filter(Boolean)
    .join(' ');
}
