import type { ProductDirection } from './product-direction';
import type { MaterialCategory, MaterialInput } from './types';

/**
 * The text a person copies, with their own product photo, into an outside image generator to make
 * the 정면·왼쪽·오른쪽·뒤 photos this app wants (docs/material-images.md, "AI로 방향별 사진 만들기").
 * The app never calls the generator: it only writes the words. The words follow the app's rules:
 *
 * - A photo's name is the way the product faces in it (product-direction.ts): 정면 its front to the
 *   camera, 왼쪽 its front to the image's left (the camera sees its left side), 오른쪽 to the right,
 *   뒤 its back to the camera.
 * - The room draws 정면·뒤 photos width × height and 왼쪽·오른쪽 ones depth × height (photoPlaneSize),
 *   so the product's shape in the picture is asked for in that ratio.
 * - The room is seen from about eye height: the space viewer and the editor's 3D room look down on a
 *   product standing on the floor by about 10° (9–13° for a toilet, a bath or a vanity in the
 *   default room, camera 1,200 mm high and about 5.3 m away) and at a wall product almost straight
 *   (within 5°), so a floor product is shot from slightly above and a wall product level.
 *
 * Same input, same text: nothing here depends on the time or on chance.
 */

/** How far down the camera looks at a product that stands on the floor (degrees, see above). */
export const FLOOR_CAMERA_DOWN_DEGREES = 10;

export type DirectionPhotoPromptInput = {
  category: MaterialCategory;
  direction: ProductDirection;
  widthMm?: number;
  heightMm?: number;
  depthMm?: number;
  install: MaterialInput['installation'];
  /** What must stay the same (optional, typed by the person; never stored). */
  details?: string;
  /** For 왼쪽·오른쪽·뒤: the 정면 result made first is attached as image 2. */
  withFrontResult?: boolean;
};

const NAMES: Record<MaterialCategory, string> = {
  tile: 'tile',
  toilet: 'toilet',
  basin: 'washbasin',
  vanity: 'bathroom vanity cabinet',
  bath: 'bathtub',
  shower: 'shower fixture',
  faucet: 'faucet',
  mirror: 'bathroom mirror',
  door: 'door',
  window: 'window',
  glassPartition: 'glass shower partition',
  mirrorCabinet: 'mirror cabinet',
  wallShelf: 'wall shelf',
  wallCabinet: 'wall cabinet',
  lowPartition: 'low partition wall',
  showerCurtain: 'shower curtain',
};

/** Which side of each kind of product is its front (the side the 정면 photo shows). */
const DEFAULT_FRONT = 'Its front is the side that faces a person using it.';
const FRONTS: Partial<Record<MaterialCategory, string>> = {
  toilet: "Its front is the bowl end, where a seated person's legs go; the tank or rear housing is its back.",
  bath: 'Its front is the long side facing the room; its back is the long side placed along the wall.',
  basin: 'Its front is the side a person stands at; its back mounts to the wall.',
  vanity:
    'Its front is the side with the doors or drawers, where a person stands; its back goes against the wall.',
  mirror: 'Its front is the mirror face; its back mounts to the wall.',
  mirrorCabinet: 'Its front is the mirror door face; its back mounts to the wall.',
  faucet: 'Its front is the side the spout points to, where a person stands; its back is the mounting side.',
  shower: 'Its front is the side a person stands at under the shower; its back mounts to the wall.',
  wallShelf: 'Its front is the open edge where things are put on it; its back mounts to the wall.',
  wallCabinet:
    'Its front is the door side, where things are put in and taken out; its back mounts to the wall.',
  door: 'Its front is the face seen from inside the bathroom.',
  window: 'Its front is the face seen from inside the bathroom.',
  glassPartition: 'Its front is the face seen from the open side of the bathroom.',
  lowPartition: 'Its front is the face seen from the open side of the bathroom.',
  showerCurtain: 'Its front is the side facing the room, away from the shower.',
};
export const productFrontSentence = (category: MaterialCategory) => FRONTS[category] ?? DEFAULT_FRONT;

const known = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const mm = (value: number) => String(Math.round(value));
/** "3.0 : 1": one decimal, the second side as 1. */
const ratio = (across: number, high: number) => `${(across / high).toFixed(1)} : 1`;
/** A frame that fits the product's shape in the picture. */
function frame(across: number, high: number) {
  const shape = across / high;
  return shape >= 1.3 ? '16:9 landscape' : shape <= 0.77 ? '3:4 portrait' : '1:1 square';
}
/** A product standing on the floor (or built into it) is seen from slightly above; one on a wall level. */
const onFloor = (install: MaterialInput['installation']) => install === 'floor' || install === 'embedded';

/** The prompt for one direction (English; generators follow English more steadily). */
export function buildDirectionPhotoPrompt(input: DirectionPhotoPromptInput): string {
  const { category, direction, widthMm: w, heightMm: h, depthMm: d, install } = input;
  const side = direction === '왼쪽' || direction === '오른쪽';
  const across = side ? d : w;
  const sized = known(across) && known(h);
  const details = input.details?.replace(/\s+/g, ' ').trim();
  const lines: string[] = [];
  if (input.withFrontResult && direction !== '정면')
    lines.push(
      'Attached image 1 is the original product photo and image 2 is the front view already made from it. Match image 2 exactly in design, color, lighting, scale and camera height.',
    );
  lines.push(
    'Use the attached image(s) only to learn the exact product design. The photo may be taken from any angle or show a room; ignore the room. Keep the same product: same shape, proportions, details, material and color. Do not redesign it and do not add or remove parts.',
  );
  if (details) lines.push(`Details that must stay the same: ${details}.`);
  lines.push(
    known(w) && known(h) && known(d)
      ? `Product: ${NAMES[category]}, ${mm(w)} × ${mm(h)} × ${mm(d)} mm (width × height × depth).`
      : `Product: ${NAMES[category]}.`,
  );
  lines.push(productFrontSentence(category));
  lines.push(
    'Studio product photo of this product only, centered, on a pure white seamless background (#FFFFFF). No floor texture, no walls, no props, no text, no watermark, no people. At most a very faint soft contact shadow under it; no long cast shadow. Soft even studio lighting, accurate white balance.',
  );
  lines.push(
    [
      'Telephoto lens look (about 85mm equivalent), almost no perspective distortion.',
      onFloor(install)
        ? `The camera is slightly above the product, looking down about ${FLOOR_CAMERA_DOWN_DEGREES} degrees.`
        : "The camera is at the product's center height, looking straight at it.",
      'The whole product is inside the frame with an even margin of about 5%; its bottom edge is clean and fully visible.',
      `Output at least 2048 px on the long side${sized ? `, ${frame(across, h)}` : ''}.`,
    ].join(' '),
  );
  const shape = sized
    ? ` The product's visible width : height in the image is about ${ratio(across, h)} (${mm(across)} : ${mm(h)} mm).`
    : '';
  lines.push(
    direction === '정면'
      ? `View: the product's front faces the camera straight on.${shape}`
      : direction === '뒤'
        ? `View: the product's back faces the camera straight on; its front faces away.${shape}`
        : direction === '왼쪽'
          ? `View: a straight side view. The product's front points toward the LEFT edge of the image and its back toward the RIGHT edge; the camera looks straight at the product's left side.${shape}`
          : `View: a straight side view. The product's front points toward the RIGHT edge of the image and its back toward the LEFT edge; the camera looks straight at the product's right side.${shape}`,
  );
  return lines.join('\n');
}

/** What the screen says about one direction, in Korean (the prompt itself stays English). */
export const DIRECTION_PROMPT_SUMMARY: Record<ProductDirection, string> = {
  정면: '제품의 앞이 카메라를 보는 사진이에요. 사진 속 제품은 가로 : 높이 비율로 그려져요.',
  왼쪽: '제품의 앞이 사진의 왼쪽을 보고, 카메라가 제품의 왼쪽 옆면을 보는 사진이에요. 깊이 : 높이 비율로 그려져요.',
  오른쪽:
    '제품의 앞이 사진의 오른쪽을 보고, 카메라가 제품의 오른쪽 옆면을 보는 사진이에요. 깊이 : 높이 비율로 그려져요.',
  뒤: '제품의 뒤가 카메라를 보는 사진이에요. 가로 : 높이 비율로 그려져요.',
};

/** The notes the screen shows next to a direction's prompt (missing sizes, a wall product's back). */
export function directionPromptNotices(input: DirectionPhotoPromptInput): string[] {
  const side = input.direction === '왼쪽' || input.direction === '오른쪽';
  const notes: string[] = [];
  if (!known(side ? input.depthMm : input.widthMm) || !known(input.heightMm))
    notes.push('가로·높이·깊이를 먼저 넣으면 비율이 프롬프트에 들어가요.');
  if (input.direction === '뒤' && !onFloor(input.install))
    notes.push('벽에 거는 제품은 뒤 사진이 거의 필요 없어요.');
  return notes;
}

/** How many directions are worth making for each kind of product (Korean, for the guide). */
export function recommendedDirections(category: MaterialCategory): string {
  switch (category) {
    case 'toilet':
      return '정면·왼쪽·오른쪽(필요하면 뒤)';
    case 'bath':
      return '정면·왼쪽(좌우가 같은 욕조는 왼쪽 사진을 좌우 반전해 오른쪽으로 써도 돼요)';
    case 'basin':
    case 'mirror':
    case 'mirrorCabinet':
      return '정면';
    default:
      return '정면(옆·뒤 화면을 자주 보면 왼쪽·오른쪽도)';
  }
}
