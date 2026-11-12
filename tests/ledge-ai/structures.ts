/**
 * The trial's "structure sentences" (S1, docs/ledge-ai-trials-20261111.md): what the editor knows about
 * a scene's ledges and niches as enums and numbers only, and the sentences a server would write from
 * them. Written as the app's code would be (no user text, the same scene always the same sentence), so
 * the method that is adopted can move to src/lib/ai-export as it is.
 */
import { colorWords } from '../../src/lib/ai-export/prompt';
import type { RoomDimensions } from '../../src/lib/room-types';
import {
  joinedLedges,
  ledgeGroups,
  type ResolvedWallFeature,
  type WallFeatureFace,
  type WallFeatureV1,
} from '../../src/lib/wall-features';

export const STRUCTURE_SHAPES = ['straight', 'corner', 'stepped', 'floating'] as const;
export type StructureShape = (typeof STRUCTURE_SHAPES)[number];
/** [left, top, right, bottom] of image 0, 0–1. */
export type StructureBox = [number, number, number, number];
export type FluxStructure =
  | {
      kind: 'ledge';
      shape: StructureShape;
      /** Each run in order: its length along its wall and its height, millimetres. */
      partsMm: [number, number][];
      depthMm: number;
      /** Above the floor; 0 stands on it. */
      bottomMm: number;
      /** Its wall's tile colour (#rrggbb), which its own faces carry. */
      color?: string;
      box: StructureBox;
    }
  | { kind: 'niche'; sizeMm: [number, number, number]; toFloor: boolean; box: StructureBox };
export const STRUCTURE_MAX = 6;
/** A point of a wall (its UV, `outMm` before it) in the picture, or null while that wall is hidden. */
export type WallProjector = (
  face: WallFeatureFace,
  u: number,
  v: number,
  outMm: number,
) => { x: number; y: number } | null;

const MIN_AREA = 0.0004;
function boxOf(members: readonly ResolvedWallFeature[], project: WallProjector): StructureBox | undefined {
  const points: { x: number; y: number }[] = [];
  for (const member of members) {
    const o = member.opening,
      out = member.protrudes ? member.depthMm : 0;
    for (const u of [o.left, o.right])
      for (const v of [o.top, o.bottom])
        for (const depth of member.protrudes ? [0, out] : [0]) {
          const point = project(member.face, u, v, depth);
          if (point) points.push(point);
        }
  }
  if (points.length < 4) return undefined;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const box: StructureBox = [
    clamp(Math.min(...points.map((p) => p.x))),
    clamp(Math.min(...points.map((p) => p.y))),
    clamp(Math.max(...points.map((p) => p.x))),
    clamp(Math.max(...points.map((p) => p.y))),
  ];
  return (box[2] - box[0]) * (box[3] - box[1]) >= MIN_AREA ? box : undefined;
}

/**
 * The structures a view shows, largest first: ledges that touch are one (`joinedLedges`), and one
 * whose wall is hidden is not told. Deterministic for a scene and a view.
 */
export function describeStructures(
  room: RoomDimensions,
  features: readonly WallFeatureV1[] | undefined,
  project: WallProjector,
  /** A wall's tile colour as the picture's facts have it. */
  colorOf?: (face: WallFeatureFace) => string | undefined,
): FluxStructure[] {
  const joined = joinedLedges(room, features);
  const groups = ledgeGroups(room, joined);
  const result: FluxStructure[] = [];
  const round = (value: number) => Math.round(value);
  for (const group of [...new Set(groups.filter((g) => g >= 0))]) {
    const all = joined.filter((_, index) => groups[index] === group);
    // Only what is seen: a hidden wall takes its ledge along.
    const members = all.filter((member) => boxOf([member], project));
    const box = boxOf(members, project);
    if (!members.length || !box) continue;
    const height = (member: ResolvedWallFeature) => round(member.heightMm),
      length = (member: ResolvedWallFeature) => round(member.openingMm.right - member.openingMm.left);
    const bottomMm = round(Math.min(...members.map((m) => m.worldBounds.min[1])));
    const depthMm = round(Math.max(...members.map((m) => m.depthMm)));
    const faces = [...new Set(members.map((m) => m.face))];
    const ordered = [...members].sort(
      (a, b) =>
        ['left', 'back', 'right'].indexOf(a.face) - ['left', 'back', 'right'].indexOf(b.face) ||
        a.openingMm.left - b.openingMm.left,
    );
    const shape: StructureShape =
      faces.length > 1
        ? 'corner'
        : bottomMm > 0
          ? 'floating'
          : new Set(members.map(height)).size > 1
            ? 'stepped'
            : 'straight';
    // Runs of one height along a wall are one run.
    const partsMm: [number, number][] = [];
    let last: ResolvedWallFeature | undefined;
    for (const member of ordered) {
      const previous = partsMm.at(-1);
      if (previous && last?.face === member.face && previous[1] === height(member))
        previous[0] += length(member);
      else partsMm.push([length(member), height(member)]);
      last = member;
    }
    const color = colorOf?.(ordered[0].face);
    result.push({
      kind: 'ledge',
      shape,
      partsMm: partsMm.slice(0, 4),
      depthMm,
      bottomMm,
      ...(color ? { color } : {}),
      box,
    });
  }
  for (const feature of joined) {
    if (feature.protrudes) continue;
    const box = boxOf([feature], project);
    if (!box) continue;
    result.push({
      kind: 'niche',
      sizeMm: [
        round(feature.openingMm.right - feature.openingMm.left),
        round(feature.heightMm),
        round(feature.depthMm),
      ],
      toFloor: feature.kind === 'floor-alcove',
      box,
    });
  }
  const area = (s: FluxStructure) => (s.box[2] - s.box[0]) * (s.box[3] - s.box[1]);
  return result.sort((a, b) => area(b) - area(a)).slice(0, STRUCTURE_MAX);
}

/** The words tried for a ledge: the model may read one of them better than the others. */
export const STRUCTURE_WORDINGS = ['ledge', 'step', 'plinth'] as const;
export type StructureWording = (typeof STRUCTURE_WORDINGS)[number];
const percent = (value: number) => Math.round(value * 100);
const where = ([left, top, right, bottom]: StructureBox) =>
  `x ${percent(left)}–${percent(right)}%, y ${percent(top)}–${percent(bottom)}% of image 0`;

/**
 * One structure, said plainly with where it is in image 0. `compact` keeps what it is, its measures
 * and its place only, for a prompt that would be too long.
 */
export function structureSentence(
  structure: FluxStructure,
  index: number,
  wording: StructureWording,
  compact = false,
): string {
  if (structure.kind === 'niche') {
    const [width, height, depth] = structure.sizeMm;
    const what = `Built structure ${index}: a rectangular niche set ${depth} mm back into the wall, ${width} × ${height} mm${structure.toFloor ? ', open down to the floor' : ''}, at ${where(structure.box)}`;
    return compact
      ? `${what}; a recess, not a window. Keep it exactly.`
      : `${what}, lined with the wall tiles. It is a recess in a solid wall, not a window or a mirror: no glass, no view outside. Keep it exactly as in image 0.`;
  }
  const { partsMm, depthMm, bottomMm, shape } = structure;
  const head = {
    ledge: `a tiled masonry ledge standing ${depthMm} mm out from the wall`,
    step: `the wall is built out by ${depthMm} mm here, a tiled wall step with a flat top`,
    plinth: `a low tiled false wall ${depthMm} mm thick built against the wall`,
  }[wording];
  const [length, height] = partsMm[0];
  const form =
    shape === 'straight'
      ? `${height} mm high from the floor and ${length} mm long`
      : shape === 'floating'
        ? `a band ${height} mm tall and ${length} mm long hanging ${bottomMm} mm above the floor, bare wall above and below it`
        : shape === 'stepped'
          ? `stepped: ${partsMm.map(([l, h]) => `${h} mm high for ${l} mm`).join(', then ')}, one piece`
          : `L-shaped seen from above: ${partsMm.map(([l]) => `${l} mm`).join(' along one wall, then round the inside corner ')} along the next, ${Math.max(...partsMm.map(([, h]) => h))} mm high from the floor, one piece`;
  const what = `Built structure ${index}: ${head}, ${form}, at ${where(structure.box)}`;
  return compact
    ? `${what}. Keep its shape, height and depth exactly.`
    : `${what}. Its front and flat top are the same ${structure.color ? `${colorWords(structure.color)} ` : ''}tiles as the wall behind it, with no separate slab on top. Keep its shape, height, depth and edges exactly as in image 0; it is not a bench, shelf, cabinet or countertop.`;
}

/** The structures' sentences and their count, to stand right after the frame of the prompt. */
export function structureSentences(
  structures: readonly FluxStructure[],
  wording: StructureWording,
  compact = false,
): string {
  if (!structures.length) return '';
  const count = structures.length;
  return [
    ...structures.map((structure, index) => structureSentence(structure, index + 1, wording, compact)),
    `Image 0 has exactly ${count === 1 ? 'this one built structure' : `these ${count} built structures`}; add no other ledge, niche or window.`,
  ].join(' ');
}
