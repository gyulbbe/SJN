import { MIXED } from './mixed-color';
import { shadingNormalSteps } from './mesh-cleanup';
import {
  MIN_PHOTO_IOU,
  SOURCE_CAMERA,
  cameraBasis,
  fitPhotoCamera,
  outlineIou,
  projectVertices,
  validPhotoCamera,
  type PhotoCamera,
  type Projected,
} from './photo-camera';
import { photoGradient, refineByPhoto } from './photo-refine';
import type { PhotoColors } from './painted';
import type { ProductMesh } from './state-types';

/**
 * The input photo's colours put directly on the mesh.
 *
 * The colours TripoSR predicts per vertex are a soft copy of the photo (a face drawn in thin lines
 * comes out as dots). The photo itself is sharper, and the mesh seen from the photo's camera lies
 * over it, so each vertex that camera sees can read its colour straight from the photo. A vertex
 * counts as seen when it is the nearest surface in its pixel (a depth comparison, so the back and the
 * inside of a bowl are never painted), faces the camera, and is not at the cut-out's edge (where the
 * photo's colour is a blend with the removed background).
 */

/** The 512 picture the model was given, before its grey backdrop: RGBA, straight alpha, y down. */
export interface ProductPhoto {
  size: number;
  data: Uint8ClampedArray;
}

/** The result of looking for the photo's camera and reading colours from the photo through it. */
export type PhotoPaint =
  | { status: 'ok'; camera: PhotoCamera; iou: number; mesh: ProductMesh; photo: PhotoColors; added: number }
  | { status: 'failed'; reason: 'outline' | 'empty'; camera: PhotoCamera; iou: number };

/** The outline match below which the photo's camera is not trusted, and a plain-language reason. */
export const PHOTO_PAINT_LIMITS = {
  iou: MIN_PHOTO_IOU,
  /** The cut-out's edge: no colour inside this many pixels, fully trusted beyond the second. */
  edge: [2, 5] as [number, number],
};

const smoothstep = (from: number, to: number, x: number) => {
  const t = to > from ? Math.min(1, Math.max(0, (x - from) / (to - from))) : x > to ? 1 : 0;
  return t * t * (3 - 2 * t);
};

/** Distance in pixels to the nearest background pixel (alpha under 128), by a 3-4 chamfer sweep. */
export function edgeDistance(photo: ProductPhoto): Float32Array {
  const { size, data } = photo;
  const distance = new Float32Array(size * size);
  const far = 1e9;
  for (let i = 0; i < distance.length; i++) distance[i] = data[i * 4 + 3] >= 128 ? far : 0;
  const relax = (x: number, y: number, dx: number, dy: number, cost: number) => {
    const nx = x + dx,
      ny = y + dy;
    const neighbour = nx < 0 || ny < 0 || nx >= size || ny >= size ? 0 : distance[ny * size + nx];
    // Outside the picture counts as background, so a product cut by the frame has an edge there.
    const at = y * size + x;
    if (neighbour + cost < distance[at]) distance[at] = neighbour + cost;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      relax(x, y, -1, 0, 1);
      relax(x, y, 0, -1, 1);
      relax(x, y, -1, -1, 1.4142);
      relax(x, y, 1, -1, 1.4142);
    }
  for (let y = size - 1; y >= 0; y--)
    for (let x = size - 1; x >= 0; x--) {
      relax(x, y, 1, 0, 1);
      relax(x, y, 0, 1, 1);
      relax(x, y, 1, 1, 1.4142);
      relax(x, y, -1, 1, 1.4142);
    }
  return distance;
}

export interface Raster {
  /** Nearest depth per pixel (Infinity where nothing is drawn). */
  depth: Float32Array;
  /** The drawn colours, three per pixel, when colours were given. */
  rgb?: Float32Array;
}

/**
 * Draws the triangles with a depth test (both sides, a vertex's colour blended across the
 * triangle when `colors` is given). Pixel centres are at +0.5.
 */
export function rasterize(
  projected: Projected,
  indices: Uint32Array,
  size: number,
  colors?: Float32Array,
): Raster {
  const { x, y, depth: z } = projected;
  const depth = new Float32Array(size * size).fill(Infinity);
  const rgb = colors ? new Float32Array(size * size * 3) : undefined;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t],
      b = indices[t + 1],
      c = indices[t + 2];
    const ax = x[a],
      ay = y[a],
      bx = x[b],
      by = y[b],
      cx = x[c],
      cy = y[c];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))),
      x1 = Math.min(size - 1, Math.floor(Math.max(ax, bx, cx))),
      y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))),
      y1 = Math.min(size - 1, Math.floor(Math.max(ay, by, cy)));
    for (let py = y0; py <= y1; py++)
      for (let px = x0; px <= x1; px++) {
        const qx = px + 0.5,
          qy = py + 0.5;
        const wa = ((bx - qx) * (cy - qy) - (cx - qx) * (by - qy)) / area,
          wb = ((cx - qx) * (ay - qy) - (ax - qx) * (cy - qy)) / area,
          wc = 1 - wa - wb;
        if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
        const d = wa * z[a] + wb * z[b] + wc * z[c];
        const at = py * size + px;
        if (d >= depth[at]) continue;
        depth[at] = d;
        if (rgb && colors) {
          for (let k = 0; k < 3; k++)
            rgb[at * 3 + k] = wa * colors[a * 3 + k] + wb * colors[b * 3 + k] + wc * colors[c * 3 + k];
        }
      }
  }
  return { depth, rgb };
}

/** The photo's colour at a point (bilinear, sRGB 0–1), the point in pixels with centres at +0.5. */
function sampleColour(photo: ProductPhoto, x: number, y: number, into: Float32Array, at: number) {
  const { size, data } = photo;
  const fx = Math.min(size - 1.001, Math.max(0, x - 0.5)),
    fy = Math.min(size - 1.001, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx),
    y0 = Math.floor(fy),
    tx = fx - x0,
    ty = fy - y0;
  for (let k = 0; k < 3; k++) {
    const p00 = data[(y0 * size + x0) * 4 + k],
      p10 = data[(y0 * size + x0 + 1) * 4 + k],
      p01 = data[((y0 + 1) * size + x0) * 4 + k],
      p11 = data[((y0 + 1) * size + x0 + 1) * 4 + k];
    into[at + k] = ((p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty) / 255;
  }
}

function sampleValue(values: Float32Array, size: number, x: number, y: number) {
  const fx = Math.min(size - 1.001, Math.max(0, x - 0.5)),
    fy = Math.min(size - 1.001, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx),
    y0 = Math.floor(fy),
    tx = fx - x0,
    ty = fy - y0;
  return (
    (values[y0 * size + x0] * (1 - tx) + values[y0 * size + x0 + 1] * tx) * (1 - ty) +
    (values[(y0 + 1) * size + x0] * (1 - tx) + values[(y0 + 1) * size + x0 + 1] * tx) * ty
  );
}

/**
 * Reads each vertex's colour from the photo through `camera`. A vertex gets weight 0 unless it is
 * the nearest surface in its pixel, faces the camera (the same curve as the mixed colours use for
 * "shown by the photo"), and lies clear of the cut-out's edge.
 */
export function samplePhotoColors(
  mesh: ProductMesh,
  photo: ProductPhoto,
  camera: PhotoCamera,
  { edge = PHOTO_PAINT_LIMITS.edge, facing = MIXED.visible } = {},
): PhotoColors {
  const { positions, indices } = mesh;
  const vertices = positions.length / 3;
  const { size } = photo;
  const projected = projectVertices(positions, camera, size);
  const { depth } = rasterize(projected, indices, size);
  const far = edgeDistance(photo);
  const [normals] = shadingNormalSteps(positions, indices, [12]);
  const { position } = cameraBasis(camera);
  const colors = new Float32Array(vertices * 3),
    weight = new Float32Array(vertices);
  const pixelWorld = 2 / (camera.focal * size); // world length of a pixel per unit of depth
  for (let v = 0; v < vertices; v++) {
    const px = projected.x[v],
      py = projected.y[v];
    if (!(px >= 0 && py >= 0 && px < size && py < size)) continue;
    const dx = position[0] - positions[v * 3],
      dy = position[1] - positions[v * 3 + 1],
      dz = position[2] - positions[v * 3 + 2];
    const toCamera = Math.hypot(dx, dy, dz) || 1;
    const cosine = (normals[v * 3] * dx + normals[v * 3 + 1] * dy + normals[v * 3 + 2] * dz) / toCamera;
    const shown = smoothstep(facing.none, facing.full, cosine);
    if (shown <= 0) continue;
    // Depth test: nothing nearer in this pixel or its neighbours, beyond what a slanted surface
    // accounts for within one pixel.
    const tangent = Math.sqrt(1 - Math.min(1, cosine * cosine)) / Math.max(cosine, 0.2);
    const tolerance = projected.depth[v] * pixelWorld * (2 + 1.5 * tangent);
    let nearest = Infinity;
    const cx = Math.floor(px),
      cy = Math.floor(py);
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const qx = cx + ox,
          qy = cy + oy;
        if (qx >= 0 && qy >= 0 && qx < size && qy < size) nearest = Math.min(nearest, depth[qy * size + qx]);
      }
    if (projected.depth[v] > nearest + tolerance) continue;
    const trust = smoothstep(edge[0], edge[1], sampleValue(far, size, px, py));
    if (trust <= 0) continue;
    sampleColour(photo, px, py, colors, v * 3);
    weight[v] = shown * trust;
  }
  return { colors, weight };
}

/**
 * Finds the photo's camera (or checks the one given) and reads the colours through it. A match
 * below the limit is a failure: the outline of the model and the photo do not agree, so the photo
 * does not lie over the mesh and its colours would land in the wrong place.
 */
export function paintFromPhoto(
  mesh: ProductMesh,
  photo: ProductPhoto,
  known?: PhotoCamera,
  { refine = true } = {},
): PhotoPaint {
  const alpha = new Uint8Array(photo.size * photo.size);
  let covered = 0;
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = photo.data[i * 4 + 3];
    if (alpha[i] >= 128) covered++;
  }
  if (!mesh.positions.length || covered < photo.size * photo.size * 0.01)
    return { status: 'failed', reason: 'empty', camera: SOURCE_CAMERA, iou: 0 };
  let camera: PhotoCamera, iou: number;
  if (known && validPhotoCamera(known)) {
    // A saved camera is not searched for again; its match is measured to show it.
    camera = known;
    iou = outlineIou(mesh.positions, alpha, photo.size, camera);
  } else {
    ({ camera, iou } = fitPhotoCamera(mesh.positions, alpha, photo.size));
  }
  if (iou < PHOTO_PAINT_LIMITS.iou) return { status: 'failed', reason: 'outline', camera, iou };
  let colors = samplePhotoColors(mesh, photo, camera);
  let shown = mesh,
    added = 0;
  if (refine) {
    // Fine detail is read at about one pixel: split the photographed triangles on it first.
    ({ mesh: shown, added } = refineByPhoto(
      mesh,
      projectVertices(mesh.positions, camera, photo.size),
      colors.weight,
      photoGradient(photo),
      photo.size,
    ));
    if (added) colors = samplePhotoColors(shown, photo, camera);
  }
  return { status: 'ok', camera, iou, mesh: shown, photo: colors, added };
}

export type { PhotoColors };

/** Why the photo's colours were not put on the mesh, in plain words for the editor. */
export function paintFailureMessage(reason: 'outline' | 'empty' | 'photo', iou: number) {
  if (reason === 'outline')
    return `사진과 입체 형상의 윤곽이 잘 겹치지 않아(${Math.round(iou * 100)}%) 사진 색을 입히지 않고 지금 색을 그대로 써요. 사진이 많이 잘렸거나 제품 모양이 단순하면 그럴 수 있어요.`;
  if (reason === 'empty') return '사진에서 제품 영역을 찾지 못해 사진 색을 입히지 않았어요.';
  return '제품 사진을 읽지 못해 사진 색을 입히지 않았어요. 사진을 다시 불러온 뒤 켜 주세요.';
}

/** What the worker answers to a paint job; the mesh arrays are there only when the photo made the mesh finer. */
export type PaintReply =
  | { status: 'failed'; reason: 'outline' | 'empty'; camera: PhotoCamera; iou: number }
  | {
      status: 'ok';
      camera: PhotoCamera;
      iou: number;
      photo: PhotoColors;
      mesh?: ProductMesh;
    };

/** What a finished paint sends back: the refined mesh only when it differs from the one asked about. */
export function paintReply(found: ReturnType<typeof paintFromPhoto>, source?: ProductMesh): PaintReply {
  if (found.status === 'failed')
    return { status: 'failed', reason: found.reason, camera: found.camera, iou: found.iou };
  return {
    status: 'ok',
    camera: found.camera,
    iou: found.iou,
    photo: found.photo,
    ...(found.added > 0 && found.mesh !== source ? { mesh: found.mesh } : {}),
  };
}
