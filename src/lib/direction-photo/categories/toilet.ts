import { productFrontSentence } from '../../product-photo-prompt';
import type { DirectionPhotoSpec } from '../contract';

/**
 * The toilet's own part of "AI로 방향 사진 만들기": its bodies and their finer choices, the guide
 * options each draws, the sentences the server writes for each body and view, the views it makes and
 * the form's labels. The 2026-10-17·18 trial (docs/toilet-direction-photo-results-20261018.md) split
 * the bodies: a tankless toilet's sentences no longer speak of a tank, a two-piece toilet may be
 * skirted, and the person may say the colours the photos lose.
 */

/** A toilet's body: a cistern on the bowl, one piece with it, or none (a bidet seat unit instead). */
export const TOILET_FORMS = ['two-piece', 'one-piece', 'tankless'] as const;
export type ToiletForm = (typeof TOILET_FORMS)[number];

/** A toilet's lid: closed, open, or a seat alone (no lid). */
export const TOILET_LIDS = ['closed', 'open', 'seat'] as const;
export type ToiletLid = (typeof TOILET_LIDS)[number];
/** The lids a toilet body can show: a tankless toilet's open lid would stand above its seat unit. */
export const toiletLids = (form: string): readonly ToiletLid[] =>
  form === 'tankless' ? ['closed', 'seat'] : TOILET_LIDS;

/**
 * A two-piece toilet's lower part: the foot and the trap in the open, or a smooth skirt down to the
 * floor. The guide only (the prompt is the same): with the open foot the model drew a skirted
 * two-piece on a pedestal (6 of 6); with the skirted guide, skirted (6 of 6).
 */
export const TOILET_SKIRTS = ['exposed', 'skirted'] as const;
export type ToiletSkirt = (typeof TOILET_SKIRTS)[number];

/**
 * The colours a person may say, when the photos alone lose them (a black body came out white or grey
 * in 5 of 6 and dark grey in the sixth, a blue seat white in 1 of 2; said, 8 of 8 kept). Absent: as
 * the photos show.
 */
export const TOILET_BODY_COLORS = ['white', 'ivory', 'grey', 'black'] as const;
export type ToiletBodyColor = (typeof TOILET_BODY_COLORS)[number];
/** A seat's (and its lid's): the body's colours, and the seats' own. */
export const TOILET_SEAT_COLORS = [...TOILET_BODY_COLORS, 'blue', 'pink'] as const;
export type ToiletSeatColor = (typeof TOILET_SEAT_COLORS)[number];

/** The form's words for each choice. */
export const TOILET_LABELS = {
  form: {
    'two-piece': '투피스(물탱크가 따로 올라감)',
    'one-piece': '일체형(물탱크와 몸통이 한 덩어리)',
    tankless: '비데 일체형(물탱크 없음)',
  } satisfies Record<ToiletForm, string>,
  lid: {
    closed: '뚜껑 닫힘',
    open: '뚜껑 열림',
    seat: '시트만(뚜껑 없음)',
  } satisfies Record<ToiletLid, string>,
  skirt: {
    exposed: '받침이 드러남(아래가 잘록함)',
    skirted: '치마형(아래가 매끈하게 바닥까지)',
  } satisfies Record<ToiletSkirt, string>,
  color: {
    white: '흰색',
    ivory: '아이보리',
    grey: '회색',
    black: '검정',
    blue: '파랑',
    pink: '분홍',
  } satisfies Record<ToiletSeatColor, string>,
};

/**
 * The views whose candidates the form puts in order of their outline's overlap with the guide
 * (candidate-order.ts): the sides, where a candidate turned toward the camera shows; on Cloudflare
 * the larger overlap was the more side-on candidate in 15 of 15 pairs (2026-10-21,
 * docs/toilet-side-view-results-20261021.md). The front was not tried.
 */
export const TOILET_ORDERED_VIEWS = ['left', 'right'] as const;

/** The views a toilet makes: no 뒤 (it stands against the wall, and 17 of 19 backs came out as its front). */
export const TOILET_NO_BACK = '변기는 벽에 붙여 설치해서 뒤 사진을 만들지 않아요';

/** Where a toilet's spec does not hold together (the contract's check, for a toilet only). */
export function toiletIssues(
  spec: Pick<DirectionPhotoSpec, 'form' | 'lid' | 'direction' | 'skirt'> & { wall: boolean },
): { message: string; path: string }[] {
  const issues: { message: string; path: string }[] = [];
  if (spec.lid && !toiletLids(spec.form).includes(spec.lid))
    issues.push({ message: '이 몸통에 없는 뚜껑이에요.', path: 'lid' });
  if (spec.direction === 'back')
    issues.push({ message: '변기는 뒤 사진을 만들지 않아요.', path: 'direction' });
  // The toilet model stands on a foot: a wall-hung toilet has no guide yet.
  if (spec.wall) issues.push({ message: '벽걸이 변기는 아직 만들 수 없어요.', path: 'installation' });
  if (spec.skirt && spec.form !== 'two-piece')
    issues.push({ message: '아래 모양은 투피스 변기에만 정해요.', path: 'skirt' });
  return issues;
}

/** The standard model's options that draw a toilet's guide (its body, lid or none, and skirt). */
export const toiletGuideOptions = (form: ToiletForm, lid: ToiletLid, skirt?: ToiletSkirt) => ({
  ...(form !== 'two-piece' && { toiletBody: form }),
  ...(lid !== 'seat' && { toiletLidState: lid }),
  ...(form === 'two-piece' && skirt === 'skirted' && { toiletSkirt: skirt }),
});

const LID_WORDS: Record<ToiletLid, string> = {
  closed: 'its lid closed',
  open: 'its lid open',
  seat: 'a seat and no lid',
};
/** The toilet as image 0 shows it, in the words the 2026-10-15 trial sent. */
export function toiletInImageZero({ form, lid = 'closed' }: Pick<DirectionPhotoSpec, 'form' | 'lid'>) {
  if (form === 'tankless')
    return `a tankless floor-standing toilet with its seat unit at the back and ${LID_WORDS[lid]}`;
  if (form === 'one-piece') return `a one-piece floor-standing toilet with ${LID_WORDS[lid]}`;
  return `a floor-standing toilet with ${LID_WORDS[lid]}`;
}

/**
 * Which end is its front. A tankless toilet has no tank to be its back: told it had one, the model
 * drew a cistern in 10 of 18; its seat unit named instead and the tank denied, in 1 of 22.
 */
export const toiletFrontSentence = ({ form }: Pick<DirectionPhotoSpec, 'form'>) =>
  form === 'tankless'
    ? "Its front is the bowl end, where a seated person's legs go; the seat unit at the back is its back. It has no water tank."
    : productFrontSentence('toilet');

/** What the view shows, said from the camera: the tank, or a tankless toilet's seat unit. */
export function toiletViewSentence({ form, direction }: Pick<DirectionPhotoSpec, 'form' | 'direction'>) {
  const tankless = form === 'tankless';
  const back = tankless ? 'the seat unit' : 'the tank';
  return {
    front: `The view shows the toilet from the front: the bowl faces the camera and ${tankless ? 'the low seat unit' : 'the tank'} is behind it.`,
    left: `The view shows the toilet from its left side: the bowl points to the left of the picture and ${back} is on the right.`,
    right: `The view shows the toilet from its right side: the bowl points to the right of the picture and ${back} is on the left.`,
    back: `The view shows the back of the toilet: ${back} faces the camera and the bowl is behind it.`,
  }[direction];
}

/** What this view cannot show: the back of a tank, the pipes and the water low in the bowl. */
export const toiletHiddenParts = ({ form, direction }: Pick<DirectionPhotoSpec, 'form' | 'direction'>) => [
  ...{
    // A tankless toilet has no tank to hide behind its seat unit.
    front: form === 'tankless' ? ['the waste pipe'] : ['the back of the tank', 'the waste pipe'],
    left: ['the waste pipe'],
    right: ['the waste pipe'],
    back: ['the front of the bowl'],
  }[direction],
  // From 10° above the rim hides the water, lid open or closed.
  'the water in the bowl',
];

/** The colours the person said, in the trial's words; none said, none written. */
export function toiletColorSentence({
  lid = 'closed',
  bodyColor,
  seatColor,
}: Pick<DirectionPhotoSpec, 'lid' | 'bodyColor' | 'seatColor'>): string {
  const seat = lid === 'seat' ? 'the seat' : 'the seat and the lid';
  const seatVerb = lid === 'seat' ? 'is' : 'are';
  if (bodyColor && seatColor === bodyColor)
    return lid === 'seat'
      ? `The body and the seat are ${bodyColor}.`
      : `The body, the seat and the lid are ${bodyColor}.`;
  if (bodyColor && seatColor) return `The body is ${bodyColor}; ${seat} ${seatVerb} ${seatColor}.`;
  if (bodyColor) return `The body is ${bodyColor}.`;
  if (seatColor) return `${seat[0].toUpperCase()}${seat.slice(1)} ${seatVerb} ${seatColor}.`;
  return '';
}
