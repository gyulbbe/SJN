/**
 * Node-only measurement of the photo colours on the saved real meshes (no browser, no AI):
 * for each product, the cut-out is placed in the 512 picture the way the model was given it
 * (worker.ts: the foreground at 0.85 of the frame), the camera is searched from the outline, and the
 * mesh seen from that camera is compared with the photo - outline overlap (IoU) and colour error
 * inside the outline, with the mesh's own colours and with the photo colours.
 *
 * Usage: npx esbuild tests/product3d-photo-metrics.ts --bundle --platform=node --outfile=<tmp>.cjs && node <tmp>.cjs
 *   MESH_ROOT=test-results/product3d-batch  OUT=test-results/product3d-photo
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';
import { foregroundBounds, defringeAlpha } from '../src/lib/product3d/pixels';
import { paintFromPhoto, rasterize, type ProductPhoto } from '../src/lib/product3d/photo-color';
import { projectVertices } from '../src/lib/product3d/photo-camera';

const root = process.env.MESH_ROOT ?? 'test-results/product3d-batch';
const output = process.env.OUT ?? 'test-results/product3d-photo';
mkdirSync(output, { recursive: true });
const SIZE = 512;

const products: { name: string; mesh: string; photo: string }[] = [
  {
    name: 'cat-toilet-a',
    mesh: `${root}/bear-a-original-500`,
    photo: 'test-results/diag/cat-toilet/cat-toilet-source-500.png',
  },
  { name: 'bear-b', mesh: `${root}/bear-b-upscaled-1000`, photo: `${root}/bear-b-upscaled-1000/cutout.png` },
  { name: 'bear-c', mesh: `${root}/bear-c-crop-1000`, photo: `${root}/bear-c-crop-1000/cutout.png` },
  ...[
    '01-shelf',
    '02-smart-toilet',
    '03-bathtub-rect',
    '04-bathtub-scene',
    '05-bathtub-top',
    '06-paper-holder',
    '07-stool',
    '08-mirror',
  ].map((name) => ({ name, mesh: `${root}/${name}`, photo: `${root}/${name}/cutout.png` })),
  // A photo that is not this product's: the outline cannot fit, so nothing is painted.
  {
    name: 'mismatch-toilet-with-stool-photo',
    mesh: `${root}/02-smart-toilet`,
    photo: `${root}/07-stool/cutout.png`,
  },
].filter((p) => existsSync(`${p.mesh}/mesh-positions.bin`) && existsSync(p.photo));

const floats = (path: string) => {
  const b = readFileSync(path);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
};
const words = (path: string) => {
  const b = readFileSync(path);
  return new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
};

/** The picture the model was given, without its grey backdrop (the same layout as worker.ts prepare). */
async function cutout512(path: string): Promise<ProductPhoto> {
  const raw = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bounds = foregroundBounds(new Uint8ClampedArray(raw.data), raw.info.width, raw.info.height);
  const extent = Math.max(bounds.width, bounds.height) / 0.85;
  const width = Math.round((bounds.width / extent) * SIZE),
    height = Math.round((bounds.height / extent) * SIZE);
  const piece = await sharp(raw.data, {
    raw: { width: raw.info.width, height: raw.info.height, channels: 4 },
  })
    .extract({ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height })
    .resize(width, height, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const placed = await sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: piece, left: Math.round((SIZE - width) / 2), top: Math.round((SIZE - height) / 2) }])
    .raw()
    .toBuffer();
  const data = new Uint8ClampedArray(placed);
  data.set(defringeAlpha(data, SIZE, SIZE, 1));
  return { size: SIZE, data };
}

const srgb = (c: number) => c;
/** Mean colour distance (0–255 per channel, RGB Euclidean / sqrt(3)) inside both outlines. */
function colourError(photo: ProductPhoto, render: Float32Array, depth: Float32Array) {
  let sum = 0,
    count = 0,
    edges = 0,
    edgeSum = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (photo.data[i * 4 + 3] < 250 || !Number.isFinite(depth[i])) continue;
    let d = 0;
    for (let k = 0; k < 3; k++) d += (photo.data[i * 4 + k] - srgb(render[i * 3 + k]) * 255) ** 2;
    const error = Math.sqrt(d / 3);
    sum += error;
    count++;
    // Pixels with a strong local gradient in the photo (lines, outlines).
    const x = i % SIZE,
      y = (i / SIZE) | 0;
    if (x > 0 && y > 0 && x < SIZE - 1 && y < SIZE - 1) {
      const l = (j: number) =>
        0.299 * photo.data[j * 4] + 0.587 * photo.data[j * 4 + 1] + 0.114 * photo.data[j * 4 + 2];
      const g = Math.abs(l(i + 1) - l(i - 1)) + Math.abs(l(i + SIZE) - l(i - SIZE));
      if (g > 40) {
        edges++;
        edgeSum += error;
      }
    }
  }
  return {
    mean: count ? sum / count : 0,
    strongEdgeMean: edges ? edgeSum / edges : 0,
    pixels: count,
    edgePixels: edges,
  };
}

const rows: Record<string, unknown>[] = [];
for (const product of products) {
  const positions = floats(`${product.mesh}/mesh-positions.bin`),
    indices = words(`${product.mesh}/mesh-indices.bin`),
    colors = floats(`${product.mesh}/mesh-colors.bin`);
  const photo = await cutout512(product.photo);
  const base = { positions, indices, colors };
  const row: Record<string, unknown> = { name: product.name, vertices: positions.length / 3 };
  const outcomes: Record<string, ReturnType<typeof paintFromPhoto>> = {};
  for (const refine of [false, true]) {
    const label = refine ? 'refined' : 'vertex';
    const started = performance.now();
    const paint = paintFromPhoto(base, photo, undefined, { refine });
    const ms = Math.round(performance.now() - started);
    outcomes[label] = paint;
    if (paint.status !== 'ok') {
      row.status = paint.status;
      row.iou = +paint.iou.toFixed(3);
      break;
    }
    row.status = 'ok';
    row.iou = +paint.iou.toFixed(3);
    row.camera = {
      azimuth: +paint.camera.azimuth.toFixed(1),
      elevation: +paint.camera.elevation.toFixed(1),
      distance: +paint.camera.distance.toFixed(2),
      focal: +paint.camera.focal.toFixed(2),
      shift: paint.camera.shift.map((v) => +v.toFixed(3)),
    };
    const mesh = paint.mesh;
    const projected = projectVertices(mesh.positions, paint.camera, SIZE);
    const blended = new Float32Array(mesh.colors);
    let painted = 0;
    for (let v = 0; v < paint.photo.weight.length; v++) {
      const w = paint.photo.weight[v];
      if (w > 0.5) painted++;
      for (let k = 0; k < 3; k++)
        blended[v * 3 + k] = mesh.colors[v * 3 + k] * (1 - w) + paint.photo.colors[v * 3 + k] * w;
    }
    const render = rasterize(projected, mesh.indices, SIZE, blended);
    row[label] = {
      ms,
      added: paint.added,
      vertices: mesh.positions.length / 3,
      paintedShare: +(painted / (mesh.positions.length / 3)).toFixed(3),
      error: colourError(photo, render.rgb!, render.depth),
    };
    if (label === 'vertex') {
      const own = rasterize(projectVertices(positions, paint.camera, SIZE), indices, SIZE, colors);
      row.modelColours = colourError(photo, own.rgb!, own.depth);
    }
    (row as Record<string, unknown>)['_' + label] = { rgb: render.rgb, depth: render.depth };
  }
  const tileOf = (rgb: Float32Array, depth: Float32Array) => {
    const out = Buffer.alloc(SIZE * SIZE * 3);
    for (let i = 0; i < SIZE * SIZE; i++)
      for (let k = 0; k < 3; k++)
        out[i * 3 + k] = Number.isFinite(depth[i]) ? Math.round(rgb[i * 3 + k] * 255) : 255;
    return out;
  };
  const vertexView = row._vertex as { rgb: Float32Array; depth: Float32Array } | undefined;
  const refinedView = row._refined as { rgb: Float32Array; depth: Float32Array } | undefined;
  delete row._vertex;
  delete row._refined;
  if (vertexView && refinedView) {
    const photoTile = Buffer.alloc(SIZE * SIZE * 3);
    for (let i = 0; i < SIZE * SIZE; i++)
      for (let k = 0; k < 3; k++) {
        const alpha = photo.data[i * 4 + 3] / 255;
        photoTile[i * 3 + k] = Math.round(photo.data[i * 4 + k] * alpha + 255 * (1 - alpha));
      }
    const sheet = Buffer.alloc(SIZE * 3 * SIZE * 3);
    const parts = [
      photoTile,
      tileOf(vertexView.rgb, vertexView.depth),
      tileOf(refinedView.rgb, refinedView.depth),
    ];
    for (let y = 0; y < SIZE; y++)
      parts.forEach((part, p) =>
        part.copy(sheet, (y * SIZE * 3 + p * SIZE) * 3, y * SIZE * 3, (y + 1) * SIZE * 3),
      );
    await sharp(sheet, { raw: { width: SIZE * 3, height: SIZE, channels: 3 } })
      .png()
      .toFile(`${output}/${product.name}-source-view.png`);
  }
  console.log(JSON.stringify(row));
  rows.push(row);
}
writeFileSync(`${output}/metrics.json`, JSON.stringify(rows, null, 2));
