/**
 * Where the model drew the fixtures (no AI call; docs/photo-products-20261115.md, on trial). Every
 * finishing step knew a fixture by the render's silhouette, but the model draws a toilet or a
 * washbasin a little larger, smaller or of another shape. Where the render has a fixture and the model
 * drew wall, the steps left the model's wall as it came (a ghost of the render's fixture); where the
 * model's fixture reached past the render's, they painted wall over it and its white spread into the
 * wall's light (a haze around every fixture).
 *
 * Near each render fixture this tells the model's fixture from its wall by colour: its own fixture
 * colour deep inside the render's silhouette against its own wall colour well outside. A pixel nearer
 * the fixture colour is a fixture; one nearer the wall colour is the face the render has behind its
 * fixtures (a capture with the fixtures hidden, RoomViewerRenderer.regionMask). Where the two colours
 * are alike (white on white) the render's silhouette stands.
 */
import { FIXTURE_REGION, type Pixels, type RegionMask } from './color';
import { blurInside, chessboardDistance } from './joints';

/** The ring around the render's silhouette that is looked at, as a share of the picture's width. */
export const MODEL_FIXTURE_REACH = 0.03;
/** Colours closer than this (sRGB distance) cannot tell fixture from wall: the render stands. */
const CONTRAST = 40;
/**
 * A render fixture pixel becomes wall only this close to the model's wall colour (a share of how far
 * its fixture and wall colours are apart): a fixture's glossy highlight is near white, like a white
 * wall, but rarely this near the wall's own colour.
 */
const WALL_MATCH = 0.35;
/** And a pixel past the render's fixture becomes fixture only this close to the model's fixture colour. */
const FIXTURE_MATCH = 0.6;

/**
 * The regions of the model's picture: `renderMask` with the fixture pixels following the model's
 * fixtures near the render's. `model` is the model's picture (backdrop restored), `renderMask` and
 * `behindMask` the render's regions with and without its fixtures, at the picture's size and moved
 * by the model's shift (the same labels: the faces are numbered alike).
 */
export function modelFixtureMask(input: {
  model: Pixels;
  renderMask: RegionMask;
  behindMask: RegionMask;
}): { mask: RegionMask; added: number; removed: number } {
  const { model, renderMask, behindMask } = input;
  const { width, height } = model;
  const n = width * height;
  const reach = Math.max(4, Math.round(width * MODEL_FIXTURE_REACH));
  const render = new Uint8Array(n),
    room = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (renderMask.data[i] === FIXTURE_REGION) render[i] = 1;
    else if (renderMask.data[i]) room[i] = 1;
  }
  const data = Uint8Array.from(renderMask.data);
  const mask = { ...renderMask, data };
  if (!render.some(Boolean)) return { mask, added: 0, removed: 0 };
  const fromFixture = chessboardDistance(render, width, height, reach * 2 + 1);
  const fromRoom = chessboardDistance(room, width, height, reach * 2 + 1);
  // The model's own colours: its fixture deep inside the render's silhouette, its wall well outside.
  const core = new Float32Array(n),
    wall = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (render[i] && fromRoom[i] > reach / 2) core[i] = 1;
    else if (room[i] && fromFixture[i] > reach) wall[i] = 1;
  }
  const planes = [0, 1, 2].map((c) => {
    const plane = new Float32Array(n);
    for (let i = 0; i < n; i++) plane[i] = model.data[i * 4 + c];
    return plane;
  });
  const fixtureColour = planes.map((p) => blurInside(p, core, width, height, reach * 2));
  const wallColour = planes.map((p) => blurInside(p, wall, width, height, reach * 2));
  // How much each pixel near the silhouette is the model's fixture (0–1).
  const ring = new Float32Array(n),
    score = new Float32Array(n),
    wallMatch = new Float32Array(n),
    fixtureMatch = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const near = render[i] ? fromRoom[i] <= reach : room[i] && fromFixture[i] <= reach;
    score[i] = render[i];
    if (!near || !behindMask.data[i] || behindMask.data[i] === FIXTURE_REGION) continue;
    ring[i] = 1;
    if (!fixtureColour[0].cover[i] || !wallColour[0].cover[i]) continue;
    let toFixture = 0,
      toWall = 0,
      apart = 0;
    for (let c = 0; c < 3; c++) {
      const v = planes[c][i],
        f = fixtureColour[c].mean[i],
        w = wallColour[c].mean[i];
      toFixture += (v - f) ** 2;
      toWall += (v - w) ** 2;
      apart += (f - w) ** 2;
    }
    toFixture = Math.sqrt(toFixture);
    toWall = Math.sqrt(toWall);
    const fixtureLike = Math.max(
      0,
      Math.min(1, ((toWall - toFixture) / Math.max(10, toWall + toFixture)) * 3 + 0.5),
    );
    const sure = Math.max(0, Math.min(1, Math.sqrt(apart) / CONTRAST - 0.5));
    score[i] = fixtureLike * sure + render[i] * (1 - sure);
    if (sure > 0) {
      wallMatch[i] = toWall < WALL_MATCH * Math.sqrt(apart) ? 1 : 0;
      fixtureMatch[i] = toFixture < FIXTURE_MATCH * Math.sqrt(apart) ? 1 : 0;
    }
  }
  // A pixel's verdict is its neighbourhood's (speckles of tile texture do not count).
  const smooth = blurInside(score, ring, width, height, 1).mean;
  const smoothWall = blurInside(wallMatch, ring, width, height, 1).mean,
    smoothFixture = blurInside(fixtureMatch, ring, width, height, 1).mean;
  // Wall grows into the render's fixture only from the room, through pixels that are wall; the
  // model's fixture grows out of the render's only from it, through pixels that are fixture.
  const removable = new Uint8Array(n),
    addable = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!ring[i]) continue;
    if (render[i] && smooth[i] < 0.5 && smoothWall[i] >= 0.5) removable[i] = 1;
    if (!render[i] && smooth[i] >= 0.5 && smoothFixture[i] >= 0.5) addable[i] = 1;
  }
  const grow = (seed: Uint8Array, through: Uint8Array) => {
    const reached = new Uint8Array(n);
    const queue: number[] = [];
    for (let i = 0; i < n; i++)
      if (through[i]) {
        const x = i % width;
        const touches = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width].some(
          (j) => j >= 0 && j < n && seed[j],
        );
        if (touches) {
          reached[i] = 1;
          queue.push(i);
        }
      }
    for (let k = 0; k < queue.length; k++) {
      const i = queue[k],
        x = i % width;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width])
        if (j >= 0 && j < n && through[j] && !reached[j]) {
          reached[j] = 1;
          queue.push(j);
        }
    }
    return reached;
  };
  const toWall = grow(room, removable),
    toFixture = grow(render, addable);
  let added = 0,
    removed = 0;
  for (let i = 0; i < n; i++) {
    if (toFixture[i]) {
      data[i] = FIXTURE_REGION;
      added++;
    } else if (toWall[i]) {
      data[i] = behindMask.data[i];
      removed++;
    }
  }
  return { mask, added, removed };
}
