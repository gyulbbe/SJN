/**
 * T1 (no AI call, docs/fixture-shape-20261120.md): an invented fitting the model drew sticking up out of
 * a fixture (a tap over a basin) is not the fixture. Of each used cut-out's pixels outside the render's
 * fixture, the 4-connected pieces that reach more than `far` px from it, above its top, and stay thin
 * (their far part at most `thin` × the render fixture's width, and at least `far` px tall: a flush button
 * is a few px) are taken out of the cut-out, so the
 * finishing steps put the wall back there.
 */
import { FIXTURE_REGION, projectMask, shiftMask } from '../../src/lib/ai-export/color';
import { fixtureMask } from '../../src/lib/ai-export/fixture-light';
import type { Cut } from '../../src/lib/ai-export/fixture-outline';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import type { FluxFixture } from '../../src/lib/ai-export/scene-contract';
import { FLUX_FIXTURE_KINDS } from '../../src/lib/ai-export/scene-contract';
import type { RegionMask } from '../../src/lib/ai-export/color';

export type Trimmed = { fixture: number; pixels: number; height: number; width: number };

export function trimProtrusions(input: {
  cuts: readonly Cut[];
  mask: RegionMask;
  layout: FluxInputLayout;
  fixtures: readonly FluxFixture[];
  size: { width: number; height: number };
  dx: number;
  dy: number;
  far?: number;
  thin?: number;
}): { cuts: Cut[]; trimmed: Trimmed[] } {
  const { width, height } = input.size;
  const n = width * height;
  const far = input.far ?? Math.max(4, Math.round(width * 0.01));
  const thin = input.thin ?? 0.15;
  const render = shiftMask(projectMask(input.mask, input.layout, input.size), input.dx, input.dy);
  const own = fixtureMask(render, input.fixtures, FLUX_FIXTURE_KINDS).mask.data;
  const chosen = input.fixtures.filter((f) => f.box && FLUX_FIXTURE_KINDS.includes(f.kind));
  const trimmed: Trimmed[] = [];
  const cuts = input.cuts.map((cut) => {
    const label = chosen.indexOf(input.fixtures[cut.fixture]) + 1;
    if (!label) return cut;
    // The render's fixture: its pixels, top row and width.
    let top = height,
      minX = width,
      maxX = -1;
    const mine = new Uint8Array(n);
    for (let i = 0; i < n; i++)
      if (own[i] === label && render.data[i] === FIXTURE_REGION) {
        mine[i] = 1;
        top = Math.min(top, Math.floor(i / width));
        minX = Math.min(minX, i % width);
        maxX = Math.max(maxX, i % width);
      }
    if (maxX < 0) return cut;
    const fixtureWidth = maxX - minX + 1;
    // The cut-out's pixels outside the render's fixture.
    const outside = new Uint8Array(n);
    for (let y = 0; y < cut.height; y++)
      for (let x = 0; x < cut.width; x++) {
        const i = (cut.top + y) * width + cut.left + x;
        if (cut.alpha[y * cut.width + x] >= 128 && !mine[i]) outside[i] = 1;
      }
    // Steps from the render's fixture through those pixels.
    const dist = new Uint16Array(n).fill(65535);
    let front: number[] = [];
    for (let i = 0; i < n; i++)
      if (mine[i]) {
        dist[i] = 0;
        front.push(i);
      }
    for (let step = 1; front.length; step++) {
      const next: number[] = [];
      for (const i of front)
        for (const j of [i - 1, i + 1, i - width, i + width]) {
          if (j < 0 || j >= n || !outside[j] || dist[j] !== 65535) continue;
          dist[j] = step;
          next.push(j);
        }
      front = next;
    }
    // Pieces of the outside pixels farther than `far`, with what joins them to the fixture.
    const seen = new Uint8Array(n);
    const alpha = Uint8Array.from(cut.alpha);
    let changed = false;
    for (let s = 0; s < n; s++) {
      if (!outside[s] || seen[s] || dist[s] === 65535 || dist[s] <= far) continue;
      const piece: number[] = [];
      const stack = [s];
      seen[s] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        piece.push(i);
        for (const j of [i - 1, i + 1, i - width, i + width])
          if (j >= 0 && j < n && outside[j] && !seen[j] && dist[j] > far) {
            seen[j] = 1;
            stack.push(j);
          }
      }
      let pMinX = width,
        pMaxX = -1,
        pMinY = height,
        pMaxY = -1;
      for (const i of piece) {
        pMinX = Math.min(pMinX, i % width);
        pMaxX = Math.max(pMaxX, i % width);
        pMinY = Math.min(pMinY, Math.floor(i / width));
        pMaxY = Math.max(pMaxY, Math.floor(i / width));
      }
      const pieceWidth = pMaxX - pMinX + 1;
      if (pMinY >= top || pieceWidth > thin * fixtureWidth || pMaxY - pMinY + 1 < far) continue;
      // Taken out with the outside pixels below it that lead down to the fixture (its stem).
      const stem = new Set(piece);
      for (let i = 0; i < n; i++)
        if (outside[i] && dist[i] <= far && dist[i] > 0) {
          const x = i % width,
            y = Math.floor(i / width);
          if (x >= pMinX - 1 && x <= pMaxX + 1 && y >= pMaxY && y < top + far) stem.add(i);
        }
      for (const i of stem) {
        const x = (i % width) - cut.left,
          y = Math.floor(i / width) - cut.top;
        if (x >= 0 && y >= 0 && x < cut.width && y < cut.height) alpha[y * cut.width + x] = 0;
      }
      changed = true;
      trimmed.push({ fixture: cut.fixture, pixels: stem.size, height: pMaxY - pMinY + 1, width: pieceWidth });
    }
    return changed ? { ...cut, alpha } : cut;
  });
  return { cuts, trimmed };
}
