/**
 * What the tile AI trial adds to the app's prompt in words (docs/tile-ai-trials-20261113.md, T2 and T3),
 * built from numbers and enumerations only: how many tiles each face shows, the smaller rectangles a
 * tile is scored into (found in its texture picture), and what a tile sample picture is. Pure.
 */
export type Units = { cols: number; rows: number };
export type TileLayer = {
  /** One tile as laid: across, up (mm). */
  tileMm: [number, number];
  groutMm: number;
  pattern: 'grid' | 'brick';
  /** The rectangles one tile shows (1 × 1 for a plain tile). */
  units: Units;
};
export type TileFacts = {
  room: { widthMm: number; depthMm: number; heightMm: number };
  wall: TileLayer;
  floor: TileLayer;
};

type Grey = { width: number; height: number; data: ArrayLike<number> };
/** Lines of one direction that cross the whole tile picture: their positions as a share of the side. */
function crossingLines(image: Grey, horizontal: boolean): number[] {
  const along = horizontal ? image.width : image.height,
    across = horizontal ? image.height : image.width;
  const at = (a: number, c: number) =>
    horizontal ? image.data[c * image.width + a] : image.data[a * image.width + c];
  // A line is darker or lighter than what lies a little to both sides of it, nearly all the way along.
  const reach = Math.max(2, Math.round(across * 0.012));
  const margin = Math.max(reach + 1, Math.round(across * 0.03));
  const strength = new Float32Array(across);
  for (let c = margin; c < across - margin; c++) {
    let darker = 0,
      lighter = 0;
    for (let a = 0; a < along; a++) {
      const d = at(a, c) - (at(a, c - reach) + at(a, c + reach)) / 2;
      if (d < -5) darker++;
      else if (d > 5) lighter++;
    }
    strength[c] = Math.max(darker, lighter) / along;
  }
  const lines: number[] = [];
  for (let c = margin; c < across - margin; c++) {
    if (strength[c] < 0.7) continue;
    let end = c;
    while (end + 1 < across - margin && strength[end + 1] >= 0.7) end++;
    lines.push((c + end + 1) / 2 / across);
    c = end;
  }
  // The light rim beside a dark line is found as lines of its own: what lies within 4% is one line.
  const merged: number[][] = [];
  for (const line of lines) {
    const last = merged.at(-1);
    if (last && line - last[last.length - 1] < 0.04) last.push(line);
    else merged.push([line]);
  }
  return merged.map((group) => group.reduce((sum, value) => sum + value, 0) / group.length);
}
/** Whether lines cut a side into equal parts (each within a fifth of the even share). */
const even = (lines: number[]) => {
  const parts = lines.length + 1;
  return [0, ...lines, 1].every(
    (value, i, all) => i === 0 || Math.abs(value - all[i - 1] - 1 / parts) < 0.2 / parts,
  );
};
/**
 * The smaller rectangles a tile's picture is scored into: full-length lines that cut it evenly. A plain
 * or irregularly printed tile is 1 × 1.
 */
export function visibleUnits(image: Grey): Units {
  const rows = crossingLines(image, true),
    cols = crossingLines(image, false);
  return {
    cols: cols.length && cols.length <= 11 && even(cols) ? cols.length + 1 : 1,
    rows: rows.length && rows.length <= 11 && even(rows) ? rows.length + 1 : 1,
  };
}

/** A count to the nearest half, as words for a prompt ("4", "3.5"). */
const count = (length: number, layer: TileLayer, side: 0 | 1) =>
  String(Math.max(1, Math.round((length / (layer.tileMm[side] + layer.groutMm)) * 2) / 2));
const whole = (value: string, times: number) => String(Math.round(Number(value) * times));
const mm = (value: number) => String(Math.round(value));

/** T2: the tile counts of the faces and the rectangles a tile is scored into. */
export function tileCountSentence(facts: TileFacts, compact = false): string {
  const { room, wall, floor } = facts;
  const across = count(room.widthMm, wall, 0),
    up = count(room.heightMm, wall, 1),
    deep = count(room.depthMm, wall, 0),
    floorAcross = count(room.widthMm, floor, 0),
    floorDeep = count(room.depthMm, floor, 1);
  const scored = wall.units.cols * wall.units.rows > 1;
  if (compact)
    return `Back wall about ${across} × ${up} tiles${scored ? `, each scored ${wall.units.cols} × ${wall.units.rows}` : ''}, floor about ${floorAcross} × ${floorDeep}; keep every joint and pattern, do not merge or re-lay tiles.`;
  return [
    `Tile count, to be kept exactly as in image 0: the back wall is about ${across} tiles wide and ${up} courses high; each side wall is about ${deep} tiles deep and ${up} courses high; the floor is about ${floorAcross} by ${floorDeep} tiles.`,
    wall.pattern === 'brick' ? 'Each wall course is offset by half a tile from the course below.' : '',
    scored
      ? `Each ${mm(wall.tileMm[0])} × ${mm(wall.tileMm[1])} mm wall tile is scored with thin lines into ${wall.units.cols} × ${wall.units.rows} smaller rectangles of about ${mm(wall.tileMm[0] / wall.units.cols)} × ${mm(wall.tileMm[1] / wall.units.rows)} mm, so the back wall shows about ${whole(across, wall.units.cols)} columns and ${whole(up, wall.units.rows)} thin rows; keep these thin lines.`
      : '',
    "Do not merge tiles into larger ones, do not re-lay them at another size, and keep each tile's printed pattern.",
  ]
    .filter(Boolean)
    .join(' ');
}

/** T3: what image 1 is, for a sample that shows `shownMm` of wall. */
export const tileSampleSentence = (shownMm: [number, number]) =>
  `Image 1 is a flat close-up of the wall tile: about ${mm(shownMm[0])} × ${mm(shownMm[1])} mm of wall seen straight on. The walls of image 0 are covered with exactly this tile; copy its joints, proportions and printed pattern at the scale of image 0. Take the room, the framing, the light and the fixtures from image 0 only.`;
