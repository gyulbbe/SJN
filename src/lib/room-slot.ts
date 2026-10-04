import { roomFacePoint } from './room-geometry';
import type { ProductBounds, RoomDimensions, RoomFace, RoomPlacement } from './room-types';
import type { FixtureInstance, MaterialVersion, Point, Scene } from './types';

/**
 * Where a new product goes on a face of the room so it does not stand on another product.
 *
 * A product is measured as a box on its face, in millimetres: width × depth on the floor (the
 * floor's two axes), width × height on a wall. Its position (u, v) is its anchor's place on the
 * face, as everywhere else (see roomFacePoint), and the anchor's place inside the picture decides
 * how the box sits around it. Products on other faces never count: a wall-hung basin and a
 * floor-standing toilet are not compared.
 */

/** The default place of a new product on its face (room-fixtures.ts used to write it). */
export const DEFAULT_SLOT = { u: 0.5, v: 0.55 };
/** Free space kept between two products (mm). */
export const SLOT_GAP_MM = 50;
/** The search walks the face in steps of this many millimetres. */
export const SLOT_STEP_MM = 50;

export type SlotBox = {
  /** Visible width and height on the face, with the product's scale applied (mm). */
  widthMm: number;
  heightMm: number;
  /** Front-to-back depth with the scale applied (mm); only a floor product uses it. */
  depthMm: number;
  /** The anchor in the picture and the visible area of the picture, as a fixture stores them. */
  anchor: Point;
  contentBounds: ProductBounds;
};
export type FreeSlot = {
  u: number;
  v: number;
  /**
   * 'default': the default place is free (or nothing better exists and nothing stands there);
   * 'moved': the default place was taken and a free place was found;
   * 'crowded': the default place is taken and no free place exists, so the product goes there anyway.
   */
  status: 'default' | 'moved' | 'crowded';
};

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5);
/** Where the anchor sits inside the visible area of the picture (0–1 across, 0–1 down). */
function anchorShare(anchor: Point, bounds: ProductBounds) {
  const w = bounds.right - bounds.left,
    h = bounds.bottom - bounds.top;
  return {
    x: w > 0 ? clamp01((anchor.x - bounds.left) / w) : 0.5,
    y: h > 0 ? clamp01((anchor.y - bounds.top) / h) : 0.5,
  };
}

/** The face's length along u and along v (mm), from the same points the rest of the room uses. */
function faceLengths(room: RoomDimensions, face: RoomFace) {
  const origin = roomFacePoint(room, face, 0, 0);
  return {
    u: roomFacePoint(room, face, 1, 0).distanceTo(origin),
    v: roomFacePoint(room, face, 0, 1).distanceTo(origin),
  };
}

/** The box around the anchor, as offsets (mm) along u and v: left/right of it and above/below it. */
function extent(face: RoomFace, box: SlotBox) {
  const share = anchorShare(box.anchor, box.contentBounds);
  const left = -share.x * box.widthMm,
    right = (1 - share.x) * box.widthMm;
  // Wall v runs top to bottom; the floor's v runs back to front and its box is centred on the anchor.
  if (face === 'floor') return { left, right, near: -box.depthMm / 2, far: box.depthMm / 2 };
  return { left, right, near: -share.y * box.heightMm, far: (1 - share.y) * box.heightMm };
}

/** The box of a product that stands on a face: its placement and anchor, and the depth of its material. */
export function slotBox(placement: RoomPlacement, anchor: Point, depthMm: number): SlotBox {
  const scale = Number.isFinite(placement.scale) && placement.scale > 0 ? placement.scale : 1;
  const widthMm = placement.widthMm * scale;
  return {
    widthMm,
    heightMm: placement.heightMm * scale,
    depthMm: (Number.isFinite(depthMm) && depthMm > 0 ? depthMm : widthMm / 2) * scale,
    anchor,
    contentBounds: placement.contentBounds,
  };
}

/** A product's depth for the floor: its standard model's, else its material's. */
export function fixtureDepthMm(
  fixture: Pick<FixtureInstance, 'reconstruction' | 'materialVersionId'>,
  materials: Record<string, Pick<MaterialVersion, 'depthMm'> | undefined>,
): number {
  return fixture.reconstruction?.depthMm ?? materials[fixture.materialVersionId]?.depthMm ?? 0;
}

/**
 * The box of a fixture on its face. A photo product is boxed by its placement and the anchor in its
 * picture. A standard model (the switch "표준 모형으로 보기" on, or one a photo reconstruction made) is
 * not placed by a picture: on the floor its centre is at (u, v) and a quarter turn swaps its width
 * and depth; on a wall (u, v) is its lower edge, so the box stands on it.
 */
export function fixtureSlotBox(
  fixture: FixtureInstance,
  materials: Record<string, Pick<MaterialVersion, 'depthMm'> | undefined>,
): SlotBox | undefined {
  const placement = fixture.roomPlacement;
  if (!placement) return undefined;
  const model = fixture.reconstruction;
  if (model?.version !== 2) return slotBox(placement, fixture.anchor, fixtureDepthMm(fixture, materials));
  const scale = Number.isFinite(placement.scale) && placement.scale > 0 ? placement.scale : 1;
  const floor = placement.face === 'floor';
  const turned = floor && Math.abs(Math.sin(((model.yawDegrees ?? 0) * Math.PI) / 180)) > Math.SQRT1_2;
  return {
    widthMm: (turned ? model.depthMm : model.widthMm) * scale,
    heightMm: model.heightMm * scale,
    depthMm: (turned ? model.widthMm : model.depthMm) * scale,
    anchor: { x: 0.5, y: floor ? 0.5 : 1 },
    contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
  };
}

/** A box and where its anchor stands on the face. */
export type PlacedBox = SlotBox & { u: number; v: number };

/** The boxes of the products already on `face` (the ones in `except` are left out, a locked one is not). */
export function slotObstacles(
  scene: Pick<Scene, 'fixtures'>,
  face: RoomFace,
  materials: Record<string, Pick<MaterialVersion, 'depthMm'> | undefined>,
  except: readonly string[] = [],
): PlacedBox[] {
  return scene.fixtures.flatMap((fixture) => {
    const placement = fixture.roomPlacement;
    if (!placement || placement.face !== face || except.includes(fixture.id)) return [];
    const box = fixtureSlotBox(fixture, materials);
    return box ? [{ ...box, u: placement.u, v: placement.v }] : [];
  });
}

type Rect = { s0: number; s1: number; t0: number; t1: number };
const rectAt = (face: RoomFace, box: SlotBox, s: number, t: number): Rect => {
  const e = extent(face, box);
  return { s0: s + e.left, s1: s + e.right, t0: t + e.near, t1: t + e.far };
};
const overlaps = (a: Rect, b: Rect, gap: number) =>
  a.s0 < b.s1 + gap && b.s0 < a.s1 + gap && a.t0 < b.t1 + gap && b.t0 < a.t1 + gap;
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * The free place nearest the default one. The default place wins when the whole box is on the face
 * and keeps 50 mm from every other box; else the face is walked in 50 mm steps around it, nearest
 * first, for such a place. With none, the product goes to the default place and the result says
 * whether another product stands there (`crowded`) or not (`default`, e.g. a product bigger than
 * the face).
 */
export function findFreeSlot(
  room: RoomDimensions,
  face: RoomFace,
  item: SlotBox,
  obstacles: readonly PlacedBox[],
  options: { defaultSlot?: { u: number; v: number }; stepMm?: number; gapMm?: number } = {},
): FreeSlot {
  const start = options.defaultSlot ?? DEFAULT_SLOT,
    step = Math.max(1, options.stepMm ?? SLOT_STEP_MM),
    gap = options.gapMm ?? SLOT_GAP_MM;
  const length = faceLengths(room, face);
  if (!(length.u > 0 && length.v > 0)) return { ...start, status: 'default' };
  const others = obstacles.map((other) => rectAt(face, other, other.u * length.u, other.v * length.v));
  const free = (s: number, t: number) => {
    const rect = rectAt(face, item, s, t);
    return others.every((other) => !overlaps(rect, other, gap));
  };
  const inside = (s: number, t: number) => {
    const rect = rectAt(face, item, s, t);
    return rect.s0 >= -0.5 && rect.s1 <= length.u + 0.5 && rect.t0 >= -0.5 && rect.t1 <= length.v + 0.5;
  };
  const s0 = start.u * length.u,
    t0 = start.v * length.v;
  if (free(s0, t0) && inside(s0, t0)) return { ...start, status: 'default' };
  // The face in steps that include the default place; the nearest to it that fits is the answer.
  const steps = (origin: number, size: number) => {
    const out: number[] = [];
    for (let k = -Math.floor(origin / step); origin + k * step <= size + 1e-6; k++)
      out.push(origin + k * step);
    return out;
  };
  const candidates: { s: number; t: number; distance: number }[] = [];
  for (const s of steps(s0, length.u))
    for (const t of steps(t0, length.v)) candidates.push({ s, t, distance: Math.hypot(s - s0, t - t0) });
  candidates.sort((a, b) => a.distance - b.distance || a.t - b.t || a.s - b.s);
  for (const { s, t } of candidates)
    if (inside(s, t) && free(s, t))
      return { u: round4(s / length.u), v: round4(t / length.v), status: 'moved' };
  return { ...start, status: free(s0, t0) ? 'default' : 'crowded' };
}
