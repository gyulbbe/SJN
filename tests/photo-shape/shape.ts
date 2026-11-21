/**
 * The photo-shape trial's shape numbers (no AI call, docs/photo-shape-20261121.md): for each fixture of
 * the photo-product results, how far the shape the model drew (its cut-out, after T1) is from the
 * render's fixture, by several numbers, to see whether any tells the changed shapes from the kept ones.
 *
 * - `iou`: overlap of the two (as fixture-outline.ts judges a cut-out)
 * - `out`, `miss`: the cut-out's pixels outside the render's fixture, and the render's not in the
 *   cut-out, each over the render's area
 * - `shape`: the app's outline score (fixture-shape.ts outlineScores): the overlap once each is
 *   stretched to its own box (32 × 32), the outline alone, not its place or size
 * - `aspect`: the cut-out's box width/height over the render's (log, 0 = same)
 * - `edge`: the mean distance between the two outlines (both ways), over √(render area)
 */
import {
  FIXTURE_REGION,
  framing,
  projectCapture,
  projectMask,
  shiftMask,
} from '../../src/lib/ai-export/color';
import { fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { outlineScores, trimProtrusions } from '../../src/lib/ai-export/fixture-shape';
import { FLUX_FIXTURE_KINDS } from '../../src/lib/ai-export/scene-contract';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';

export type ShapeRow = {
  id: string;
  fixture: number;
  kind: string;
  iou: number;
  out: number;
  miss: number;
  shape: number;
  aspect: number;
  edge: number;
};

/** Chamfer distance (3-4) to the nearest set pixel, in pixels. */
function distanceTo(set: Uint8Array, width: number, height: number) {
  const d = new Float32Array(width * height).fill(1e9);
  for (let i = 0; i < d.length; i++) if (set[i]) d[i] = 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 1e9 : d[y * width + x]);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}
const boundary = (m: Uint8Array, width: number, height: number) => {
  const b = new Uint8Array(m.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!m[i]) continue;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) b[i] = 1;
      else if (!m[i - 1] || !m[i + 1] || !m[i - width] || !m[i + width]) b[i] = 1;
    }
  return b;
};
function boxOf(m: Uint8Array, width: number) {
  let l = Infinity,
    t = Infinity,
    r = -1,
    b = -1;
  for (let i = 0; i < m.length; i++)
    if (m[i]) {
      const x = i % width,
        y = Math.floor(i / width);
      l = Math.min(l, x);
      r = Math.max(r, x);
      t = Math.min(t, y);
      b = Math.max(b, y);
    }
  return { l, t, r, b };
}

export async function shapeRows(set: HazeSet, only?: string[]): Promise<ShapeRow[]> {
  const rows: ShapeRow[] = [];
  for (const source of haze(set)) {
    if (only && !only.some((o) => source.id.startsWith(o))) continue;
    const loaded = await loadInput(source);
    if (!loaded?.input.cuts?.length) continue;
    const { input } = loaded;
    const { width, height } = input.raw;
    const n = width * height;
    const frame = framing(projectCapture(input.capture, input.layout, { width, height }), input.raw);
    const renderMask = shiftMask(
      projectMask(input.mask, input.layout, { width, height }),
      frame.dx,
      frame.dy,
    );
    const { cuts } = trimProtrusions({ cuts: input.cuts, renderMask, fixtures: input.fixtures });
    const own = fixtureMask(renderMask, input.fixtures, FLUX_FIXTURE_KINDS).mask.data;
    const chosen = input.fixtures.filter((f) => f.box && FLUX_FIXTURE_KINDS.includes(f.kind));
    const outline = outlineScores({ cuts, renderMask, fixtures: input.fixtures });
    for (const cut of cuts) {
      const label = chosen.indexOf(input.fixtures[cut.fixture]) + 1;
      if (!label) continue;
      const render = new Uint8Array(n),
        drawn = new Uint8Array(n);
      for (let i = 0; i < n; i++)
        if (own[i] === label && renderMask.data[i] === FIXTURE_REGION) render[i] = 1;
      for (let y = 0; y < cut.height; y++)
        for (let x = 0; x < cut.width; x++)
          if (cut.alpha[y * cut.width + x] >= 128) drawn[(cut.top + y) * width + cut.left + x] = 1;
      let both = 0,
        out = 0,
        miss = 0,
        area = 0;
      for (let i = 0; i < n; i++) {
        if (render[i]) area++;
        if (render[i] && drawn[i]) both++;
        else if (drawn[i]) out++;
        else if (render[i]) miss++;
      }
      if (area < 100) continue;
      const ba = boxOf(drawn, width),
        bb = boxOf(render, width);
      const aspect = Math.log(
        (ba.r - ba.l + 1) / (ba.b - ba.t + 1) / ((bb.r - bb.l + 1) / (bb.b - bb.t + 1)),
      );
      const edgeA = boundary(drawn, width, height),
        edgeB = boundary(render, width, height);
      const toA = distanceTo(edgeA, width, height),
        toB = distanceTo(edgeB, width, height);
      let sum = 0,
        count = 0;
      for (let i = 0; i < n; i++) {
        if (edgeA[i]) {
          sum += toB[i];
          count++;
        }
        if (edgeB[i]) {
          sum += toA[i];
          count++;
        }
      }
      rows.push({
        id: source.id,
        fixture: cut.fixture,
        kind: input.fixtures[cut.fixture].kind,
        iou: +(both / (both + out + miss)).toFixed(3),
        out: +(out / area).toFixed(3),
        miss: +(miss / area).toFixed(3),
        shape: outline.find((o) => o.fixture === cut.fixture)?.shape ?? 0,
        aspect: +aspect.toFixed(3),
        edge: +(sum / Math.max(1, count) / Math.sqrt(area)).toFixed(4),
      });
    }
  }
  return rows;
}
