/**
 * B1 of the direction-photo methods trial (no AI): which guide shape fits a product's photo. Every
 * candidate (the app's four basin forms and the trial's shapes, shapes.ts) at the product's registered
 * size is projected as a silhouette from the cameras a front-left photo from above can have (azimuth
 * 15–65°, elevation 15–45°, orthographic), and compared with the photo's outline (both cut to their box
 * and scaled to 128 × 128, as measure.mjs does, the photo's from BiRefNet's cut-out; the overlap times
 * the closeness of the box aspects).
 * The best candidate is the shape the photo suggests. Node only (three, sharp).
 *
 *   node tests/run-browser-test.mjs tests/direction-photo-methods/fit.ts [--holdout]
 * → fit/basins.json and a printed table: the best shape, its score, the one this trial assigned.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Mesh, Vector3, type BufferGeometry, type Group } from 'three';
import { createTemplateModel } from '../../src/lib/reconstruction/templates';
import { iou } from '../direction-photo-real/measure.mjs';
import { OUT } from './paths.mjs';
import { PRODUCTS, type B2Shape } from './products';
import { B2_NOUNS } from './methods';
import { createTrialShape } from './shapes';

const HOLDOUT = process.argv.includes('--holdout');
const SIZE = 128;
const B0_FORMS = ['wall-round', 'wall-rectangular', 'pedestal-round', 'pedestal-rectangular'] as const;
type Candidate = { name: string; build: (size: [number, number, number]) => Group };
const candidates: Candidate[] = [
  ...B0_FORMS.map((form) => ({
    name: `B0:${form}`,
    build: ([w, h, d]: [number, number, number]) => {
      const [variant, shape] = form.split('-') as ['wall' | 'pedestal', 'round' | 'rectangular'];
      return createTemplateModel({
        kind: 'basin',
        color: '#d6d6d6',
        widthMm: w,
        heightMm: h,
        depthMm: d,
        version: 2,
        face: variant === 'pedestal' ? 'floor' : 'back',
        basinVariant: variant,
        basinShape: shape,
        bowlCount: 1,
      });
    },
  })),
  ...(Object.keys(B2_NOUNS) as B2Shape[]).map((shape) => ({
    name: `B2:${shape}`,
    build: (size: [number, number, number]) => createTrialShape(shape, size),
  })),
];

/** The silhouette from a camera (orthographic), as a mask cut to its box and scaled to SIZE², and its box aspect. */
async function silhouette(model: Group, azimuth: number, elevation: number) {
  const a = (azimuth * Math.PI) / 180,
    e = (elevation * Math.PI) / 180;
  const toCamera = new Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
  const forward = toCamera.clone().negate();
  const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, forward);
  const triangles: number[][] = [];
  model.updateMatrixWorld(true);
  model.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    let geometry = mesh.geometry as BufferGeometry;
    if (geometry.index) geometry = geometry.toNonIndexed();
    const p = geometry.getAttribute('position');
    const v = new Vector3();
    for (let i = 0; i + 2 < p.count; i += 3) {
      const tri: number[] = [];
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(p, i + k).applyMatrix4(mesh.matrixWorld);
        tri.push(v.dot(right), -v.dot(up));
      }
      triangles.push(tri);
    }
  });
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const t of triangles)
    for (let k = 0; k < 6; k += 2) {
      x0 = Math.min(x0, t[k]);
      x1 = Math.max(x1, t[k]);
      y0 = Math.min(y0, t[k + 1]);
      y1 = Math.max(y1, t[k + 1]);
    }
  const sx = SIZE / (x1 - x0),
    sy = SIZE / (y1 - y0);
  const polygons = triangles
    .map(
      (t) =>
        `<polygon points="${[0, 2, 4].map((k) => `${((t[k] - x0) * sx).toFixed(2)},${((t[k + 1] - y0) * sy).toFixed(2)}`).join(' ')}"/>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000" stroke="#000" stroke-width="0.6">${polygons}</g></svg>`;
  // One channel (sharp writes three after a resize or from an SVG unless told).
  const mask = await sharp(Buffer.from(svg)).greyscale().negate().extractChannel(0).raw().toBuffer();
  return { mask, aspect: (x1 - x0) / (y1 - y0) };
}

/** The photo's outline from BiRefNet's cut-out (alpha over half), cut to its box and scaled to SIZE². */
async function photoOutline(file: string) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width,
    right = -1,
    top = info.height,
    bottom = -1;
  for (let i = 0; i < data.length; i++)
    if (data[i] > 128) {
      const x = i % info.width,
        y = Math.floor(i / info.width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  const mask = await sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } })
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .resize(SIZE, SIZE, { fit: 'fill' })
    .extractChannel(0)
    .raw()
    .toBuffer();
  return { mask, aspect: (right - left + 1) / (bottom - top + 1) };
}

const AZIMUTHS = [15, 25, 35, 45, 55, 65];
const ELEVATIONS = [15, 25, 35, 45];
const out: Record<string, unknown> = {};
const basins = PRODUCTS.filter(
  (p) => p.category === 'basin' && (HOLDOUT ? p.set === 'holdout' : p.set === 'dev'),
);
let hits = 0;
for (const product of basins) {
  const photo = await photoOutline(path.join(OUT, 'prep', product.id, 'refs', 'cutout-1.png'));
  const scores: { name: string; score: number; azimuth: number; elevation: number }[] = [];
  for (const candidate of candidates) {
    const model = candidate.build(product.spec.sizeMm as [number, number, number]);
    let best = { score: -1, azimuth: 0, elevation: 0 };
    for (const azimuth of AZIMUTHS)
      for (const elevation of ELEVATIONS) {
        const s = await silhouette(model, azimuth, elevation);
        const closeness = Math.min(s.aspect / photo.aspect, photo.aspect / s.aspect);
        const score = iou(s.mask, photo.mask) * closeness;
        if (score > best.score) best = { score, azimuth, elevation };
      }
    scores.push({ name: candidate.name, ...best, score: Number(best.score.toFixed(3)) });
  }
  scores.sort((a, b) => b.score - a.score);
  if (process.env.FIT_DEBUG) {
    // The photo's mask and the best silhouettes of the winner and the assigned shape, side by side.
    const dir = path.join(OUT, 'fit', 'debug');
    mkdirSync(dir, { recursive: true });
    const tiles = [
      {
        input: await sharp(photo.mask, { raw: { width: SIZE, height: SIZE, channels: 1 } })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      },
    ];
    for (const [i, name] of [scores[0].name, `B2:${product.b2}`].entries()) {
      const s = scores.find((x) => x.name === name)!;
      const shape = await silhouette(
        candidates.find((c) => c.name === name)!.build(product.spec.sizeMm as [number, number, number]),
        s.azimuth,
        s.elevation,
      );
      tiles.push({
        input: await sharp(shape.mask, { raw: { width: SIZE, height: SIZE, channels: 1 } })
          .png()
          .toBuffer(),
        left: (i + 1) * (SIZE + 4),
        top: 0,
      });
    }
    await sharp({ create: { width: 3 * (SIZE + 4), height: SIZE, channels: 3, background: '#888' } })
      .composite(tiles)
      .png()
      .toFile(path.join(dir, `${product.id}.png`));
  }
  const assigned = `B2:${product.b2}`;
  const hit = scores[0].name === assigned;
  if (hit) hits++;
  out[product.id] = {
    assigned,
    best: scores[0],
    rankOfAssigned: scores.findIndex((s) => s.name === assigned) + 1,
    scores,
  };
  console.log(
    product.id.padEnd(4),
    (hit ? 'same ' : 'DIFF ') + scores[0].name.padEnd(26),
    scores[0].score,
    `assigned ${assigned} rank ${scores.findIndex((s) => s.name === assigned) + 1}`,
    `best B0 ${scores.find((s) => s.name.startsWith('B0'))!.name} ${scores.find((s) => s.name.startsWith('B0'))!.score}`,
  );
}
console.log(`the photo picks the assigned shape for ${hits}/${basins.length}`);
mkdirSync(path.join(OUT, 'fit'), { recursive: true });
writeFileSync(
  path.join(OUT, 'fit', HOLDOUT ? 'basins-holdout.json' : 'basins.json'),
  JSON.stringify(out, null, 1),
);
