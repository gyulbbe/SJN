import {
  directionAngle,
  nearestHorizontalDirection,
  readProductDirection,
  type ProductDirection,
} from '../product-direction';
import { snapQuarter, type RoomQuarter } from './view-state';

/**
 * Which photo of a product the space viewer and the AI input show from each of the four sides. A
 * photo's name is the direction its product faces in it (seen from the room's front), and the
 * selected photo's name says which way the product stands in the room (`base`). A camera on the side
 * θ (the front 0, the right 90, the back 180, the left −90) sees that product facing `base − θ`
 * relative to itself, so it is shown the photo of that name: a product facing right, seen from the
 * right, faces the camera and shows its 정면 photo.
 *
 *   selected photo / camera   front   right   back    left
 *   정면 (0°)             정면    왼쪽    뒤      오른쪽
 *   오른쪽 (90°)          오른쪽  정면    왼쪽    뒤
 *   왼쪽 (−90°)           왼쪽    뒤      오른쪽  정면
 *   뒤 (180°)             뒤      오른쪽  정면    왼쪽
 *
 * A direction with no photo is shown by the registered photo nearest to it (a photo is never mirrored
 * for another side: a logo or a print would read backwards). 위 and 아래 name no horizontal direction
 * and are not used from the four sides.
 */

/** The side a camera looks from, in plain words: 정면 · 오른쪽 · 뒤 · 왼쪽. */
export function roomSideName(azimuth: number): '정면' | '오른쪽' | '뒤' | '왼쪽' {
  const quarter = snapQuarter(azimuth);
  return quarter === 0 ? '정면' : quarter === 90 ? '오른쪽' : quarter === 180 ? '뒤' : '왼쪽';
}

export type ViewPhoto = {
  /** The photo to show. */
  index: number;
  /** The direction the camera should see (undefined when the selected photo names none: 위, 아래). */
  wanted?: ProductDirection;
  /** The shown photo's direction name. */
  used: ProductDirection;
  /** Whether the shown photo is the one wanted (or none was asked for). */
  exact: boolean;
};

const wrap = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180;
const distance = (a: number, b: number) => Math.abs(wrap(a - b));

/**
 * The photo to show for a camera. `directions` are the photos' names in the material's order,
 * `selected` the photo the fixture uses, `azimuth` the camera's side (snapped to the four), and
 * `available` the photos that can be shown (all of them when absent; the selected one always can).
 * When no direction is named by the selected photo, it stays. A direction with no photo takes the
 * nearest registered one, equally near the selected photo, else the first.
 */
export function choosePhotoForView(
  directions: readonly string[],
  selected: number,
  azimuth: number,
  available?: ReadonlySet<number>,
): ViewPhoto {
  const names = directions.map((value) => readProductDirection(value).name);
  const own = names[selected] ?? '정면';
  const base = directionAngle(own);
  if (base === undefined) return { index: selected, used: own, exact: true };
  const wanted = nearestHorizontalDirection(base - snapQuarter(azimuth)).name;
  const target = directionAngle(wanted)!;
  let index = selected,
    best = distance(base, target);
  names.forEach((name, i) => {
    const angle = directionAngle(name);
    if (angle === undefined || i === selected || (available && !available.has(i))) return;
    const delta = distance(angle, target);
    // Strictly nearer wins; a tie keeps the selected photo, then the first of the equals.
    if (delta < best) {
      index = i;
      best = delta;
    }
  });
  return { index, wanted, used: names[index] ?? own, exact: best === 0 };
}

/**
 * What to tell the person when a direction has no photo of its own and another stands in:
 * "뒤 화면: 변기의 ‘뒤’ 사진이 없어 ‘정면’ 사진을 썼어요. …". Empty when the wanted photo is shown.
 */
export function viewPhotoNote(name: string, azimuth: number, photo: ViewPhoto): string {
  if (photo.exact || !photo.wanted) return '';
  return `${roomSideName(azimuth)} 화면: ${name}의 ‘${photo.wanted}’ 사진이 없어 ‘${photo.used}’ 사진을 썼어요. 방향별 사진을 더 등록하면 더 자연스러워요.`;
}

export type { RoomQuarter };
