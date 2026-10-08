import type { RoomFace } from './room-types';

/**
 * A product photo's angle name is the direction the product faces in that photo, seen from the
 * front of the room (the open side): 정면 towards the viewer (room +z), 오른쪽 to the room's right
 * (+x), 왼쪽 to its left (−x), 뒤 towards the back wall (−z). The list is closed: a name is picked,
 * never typed. 위 and 아래 are not on it (2026-10): the rooms are seen from four sides only, so a
 * picture taken from above or below has no place there. Such a photo saved earlier is *retired*:
 * it stays where it is in a stored material (so the numbers of the photos after it do not move) but
 * is never shown as a direction photo, and it is left out when the material is saved again.
 */
export const PRODUCT_DIRECTIONS = ['정면', '왼쪽', '오른쪽', '뒤'] as const;
export type ProductDirection = (typeof PRODUCT_DIRECTIONS)[number];
/** One photo per direction. */
export const MAX_PRODUCT_VIEWS = PRODUCT_DIRECTIONS.length;

export const isProductDirection = (value: unknown): value is ProductDirection =>
  typeof value === 'string' && (PRODUCT_DIRECTIONS as readonly string[]).includes(value);

/** An angle name is one of the closed list, never typed. */
export function productViewName(name: string) {
  const value = name.trim();
  if (!isProductDirection(value))
    throw new Error(`각도 이름은 목록에서 골라 주세요(${PRODUCT_DIRECTIONS.join(' · ')}).`);
  return value;
}

/** The names a photo of a view from above or below was saved under (older spellings included). */
const RETIRED = new Set(['위', '아래', 'top', 'up', '위에서', 'bottom', 'down', '아래에서']);
/** Whether a stored angle name is one of the retired 위·아래 names. */
export const isRetiredDirection = (raw: unknown): boolean =>
  (typeof raw === 'string' && RETIRED.has(raw.trim())) ||
  (typeof raw === 'string' && RETIRED.has(raw.trim().toLowerCase()));

/** Names saved before the closed list, read as their nearest direction. */
const LEGACY: Record<string, ProductDirection> = {
  front: '정면',
  left: '왼쪽',
  '왼쪽 측면': '왼쪽',
  '왼쪽 사선': '왼쪽',
  right: '오른쪽',
  '오른쪽 측면': '오른쪽',
  '오른쪽 사선': '오른쪽',
  back: '뒤',
  rear: '뒤',
  뒤에서: '뒤',
  뒷면: '뒤',
  후면: '뒤',
};
/**
 * A stored name as the current list reads it. A name that is neither on the list nor a known older
 * one (사선, 원본 사진 방향, anything typed) reads as 정면 with `known: false`, so the editor can
 * ask for it to be chosen again. A retired 위·아래 name reads as `retired: true` (its `name` is
 * then a placeholder 정면: ask `viewDirection` / `viewDirectionAngle` to get none for it).
 */
export function readProductDirection(raw: unknown): {
  name: ProductDirection;
  known: boolean;
  retired: boolean;
} {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (isProductDirection(value)) return { name: value, known: true, retired: false };
  if (isRetiredDirection(value)) return { name: '정면', known: true, retired: true };
  const older = LEGACY[value.toLowerCase()] ?? LEGACY[value];
  return older
    ? { name: older, known: true, retired: false }
    : { name: '정면', known: false, retired: false };
}
/** A photo's direction as a name on the list, or none for a retired 위·아래 photo (not a direction photo). */
export function viewDirection(raw: unknown): ProductDirection | undefined {
  const read = readProductDirection(raw);
  return read.retired ? undefined : read.name;
}

/** The first direction on the list (in the list's order) that is not used yet, for a new photo. */
export function nextProductDirection(used: readonly string[]): ProductDirection | undefined {
  const taken = new Set(used);
  return PRODUCT_DIRECTIONS.find((name) => !taken.has(name));
}

/** Degrees the product faces, measured from the room's +z (towards the viewer) to +x (right). */
const ANGLES: Record<ProductDirection, number> = { 정면: 0, 오른쪽: 90, 왼쪽: -90, 뒤: 180 };
export const directionAngle = (name: ProductDirection): number => ANGLES[name];
/** The degrees a stored photo's name stands for, or none for a retired 위·아래 photo. */
export function viewDirectionAngle(raw: unknown): number | undefined {
  const name = viewDirection(raw);
  return name === undefined ? undefined : ANGLES[name];
}
/** The nearest of the four horizontal names to an angle (degrees, any range). */
export function nearestHorizontalDirection(angle: number): { name: ProductDirection; distance: number } {
  let best: { name: ProductDirection; distance: number } = { name: '정면', distance: Infinity };
  for (const [name, at] of Object.entries(ANGLES) as [ProductDirection, number][]) {
    const distance = Math.abs(((angle - at + 540) % 360) - 180);
    if (distance < best.distance) best = { name, distance };
  }
  return best;
}

/** Where a product faces in the room (a unit direction on the floor plane). */
export type ProductFacing = 'front' | 'right' | 'left' | 'back';
const FACINGS: Record<ProductDirection, ProductFacing> = {
  정면: 'front',
  오른쪽: 'right',
  왼쪽: 'left',
  뒤: 'back',
};
export const facingOfDirection = (name: ProductDirection): ProductFacing => FACINGS[name];

/**
 * The direction that suits a face: a product on the left wall looks into the room, to the right; on
 * the right wall to the left; on the back wall and the floor to the front. The floor takes any.
 */
const SUITS: Record<RoomFace, ProductDirection | undefined> = {
  left: '오른쪽',
  right: '왼쪽',
  back: '정면',
  floor: undefined,
};
export function suitingDirection(face: RoomFace): ProductDirection | undefined {
  return SUITS[face];
}
/** Whether a photo's direction suits the face it stands on (never blocks: only warns). */
export function directionSuitsFace(face: RoomFace, name: ProductDirection): boolean {
  return face === 'floor' || SUITS[face] === name;
}

const FACE_WORD: Record<RoomFace, string> = {
  floor: '바닥',
  back: '정면 벽',
  left: '왼쪽 벽',
  right: '오른쪽 벽',
};
const FACING_WORD: Record<ProductFacing, string> = {
  front: '정면(열린 쪽)',
  right: '오른쪽 벽 쪽',
  left: '왼쪽 벽 쪽',
  back: '뒤 벽 쪽',
};
/** Where a product looks, in words for the inspector ("방 안쪽을 봐요", "정면을 봐요"). */
export function describeProductFacing(face: RoomFace, name: ProductDirection): string {
  const facing = facingOfDirection(name);
  if (face === 'left' && facing === 'right') return '방 안쪽을 봐요.';
  if (face === 'right' && facing === 'left') return '방 안쪽을 봐요.';
  if (face === 'back' && facing === 'front') return '정면(방 안쪽)을 봐요.';
  return `${FACING_WORD[facing]}을 봐요.`;
}
/** The warning for a direction that does not suit its face (empty when it suits). */
export function mismatchMessage(face: RoomFace, name: ProductDirection): string {
  if (directionSuitsFace(face, name)) return '';
  const suited = SUITS[face];
  return `${FACE_WORD[face]}에는 ‘${suited}’ 각도가 어울려요. 지금은 ‘${name}’ 각도라 ${describeProductFacing(face, name)}`;
}

/** The shape every material version has: the views are read through the current list. */
type ViewsOf = {
  views: { direction: string; directionWas?: string }[];
  reconstruction?: unknown;
};
/**
 * A stored material version as the current list reads it: every view's name is on the list, in
 * place (a retired 위·아래 photo stays as stored). A name that could not be read carries `directionWas` (what was stored) until the material
 * is edited and saved again; reconstruction materials (internal, disposable) are not flagged.
 * Returns the same object when nothing changes. Reading is lenient; writing stays strict.
 */
export function readMaterialViews<T extends ViewsOf>(version: T): T {
  if (!Array.isArray(version.views) || !version.views.length) return version;
  let changed = false;
  const views = version.views.map((view) => {
    // A retired 위·아래 photo keeps its place and its stored name (the photos after it keep their numbers).
    if (isRetiredDirection(view.direction)) return view;
    const { name, known } = readProductDirection(view.direction);
    const flag = !known && !version.reconstruction;
    if (view.direction === name && !flag && !('directionWas' in view)) return view;
    changed = true;
    const next = { ...view, direction: name };
    if (flag) next.directionWas = String(view.direction ?? '');
    else delete next.directionWas;
    return next;
  });
  return changed ? { ...version, views } : version;
}
