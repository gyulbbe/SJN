import { estimateFront, estimateSymmetry, symmetrize, type MirrorPlane } from './symmetry';
import { shadingNormals } from './mesh-cleanup';
import type { ProductMesh } from './state-types';

/**
 * Fitting a one-photo product model to the product: its proportions from the real size, its mirror
 * symmetry, and which way its front points. Saved with a view as `product3d.fit`, and applied each
 * time the mesh is loaded (the saved mesh stays as it was made), so a material whose size is
 * corrected later follows. The editor, the PNG capture, the 3D room and the AI input all draw
 * the mesh `fitProductMesh` returns.
 *
 * The standing frame is the model turned by `upright` (the pose's own standing correction): +z up.
 * There the front points along `front` (degrees about +z, 0 along the model's +x), the left-right
 * axis is across it, and the mirror plane has its normal across the front.
 */
export type Quaternion4 = [number, number, number, number];

export interface ProductFit {
  /** Model → standing frame (the pose's object quaternion when the fit was made). */
  upright: Quaternion4;
  /** Turn of the product's front about +z in the standing frame, degrees. */
  front: number;
  /** Where the mirror plane is (along the normal turned a quarter from the front); absent: not evened out. */
  mirror?: number;
  /** Use the material's real width, depth and height for the proportions. */
  size: boolean;
}

export interface ProductSize {
  widthMm: number;
  depthMm: number;
  heightMm: number;
}

/** Sizes outside these (mm) are not a product's size: a tile's default 9 mm depth, a typo. */
export const MIN_PRODUCT_SIZE_MM = 10;
export const MAX_PRODUCT_SIZE_MM = 5000;
/** Beyond this change in an axis the photo and the typed size disagree, and the person is asked. */
export const SIZE_MISMATCH = 0.4;

export const validProductSize = (size: Partial<ProductSize> | undefined): size is ProductSize =>
  !!size &&
  [size.widthMm, size.depthMm, size.heightMm].every(
    (value) =>
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= MIN_PRODUCT_SIZE_MM &&
      value <= MAX_PRODUCT_SIZE_MM,
  );

type Vec = [number, number, number];
type Matrix = number[]; // row-major 3 × 3

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const normalized = (q: Quaternion4): Quaternion4 => {
  const length = Math.hypot(...q) || 1;
  return q.map((n) => n / length) as Quaternion4;
};
function rotationMatrix([x, y, z, w]: Quaternion4): Matrix {
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}
const multiply = (a: Matrix, b: Matrix): Matrix => {
  const out: number[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  return out;
};
const transpose = (m: Matrix): Matrix => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const turnAboutZ = (degrees: number): Matrix => {
  const c = Math.cos(radians(degrees)),
    s = Math.sin(radians(degrees));
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
const apply = (m: Matrix, x: number, y: number, z: number): Vec => [
  m[0] * x + m[1] * y + m[2] * z,
  m[3] * x + m[4] * y + m[5] * z,
  m[6] * x + m[7] * y + m[8] * z,
];
function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) || 1;
  return [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
}
const rotated = (positions: Float32Array, m: Matrix): Float32Array<ArrayBuffer> => {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = apply(m, positions[i], positions[i + 1], positions[i + 2]);
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = z;
  }
  return out;
};

/** The lowest and highest coordinate on each axis, leaving out the outermost 0.1% (stray bits). */
function trimmedExtents(positions: Float32Array): { low: Vec; high: Vec } {
  const count = positions.length / 3;
  const trim = Math.floor(count * 0.001);
  const low: Vec = [0, 0, 0],
    high: Vec = [0, 0, 0];
  const column = new Float32Array(count);
  for (let k = 0; k < 3; k++) {
    for (let v = 0; v < count; v++) column[v] = positions[v * 3 + k];
    column.sort();
    low[k] = column[trim];
    high[k] = column[count - 1 - trim];
  }
  return { low, high };
}

/** How the mesh must stretch along the product's axes (depth, width, height) to meet `size`; mean 1. */
function stretch(front: Vec, extent: Vec, size: ProductSize): Vec {
  void front;
  const wanted = [size.depthMm / extent[0], size.widthMm / extent[1], size.heightMm / extent[2]];
  const mean = Math.cbrt(wanted[0] * wanted[1] * wanted[2]);
  return wanted.map((s) => s / mean) as Vec;
}

/** The standing frame's axes of a fit, and the model's trimmed size along them (without evening out). */
function standingExtent(positions: Float32Array, fit: ProductFit) {
  const standing = rotated(positions, rotationMatrix(normalized(fit.upright)));
  const turned = rotated(standing, turnAboutZ(-fit.front));
  const { low, high } = trimmedExtents(turned);
  return [high[0] - low[0], high[1] - low[1], high[2] - low[2]] as Vec;
}

/**
 * How far the typed size is from the photo's proportions: the change each axis would get (depth,
 * width, height, as a share, 0 = none). More than SIZE_MISMATCH on any axis is a warning.
 */
export function sizeMismatch(mesh: ProductMesh, fit: ProductFit, size: ProductSize) {
  const [depth, width, height] = stretch([0, 0, 0], standingExtent(mesh.positions, fit), size).map(
    (s) => s - 1,
  );
  return { depth, width, height, worst: Math.max(Math.abs(depth), Math.abs(width), Math.abs(height)) };
}

/** Where a fitted mesh came from and the linear map between them (for its normals). */
const origin = new WeakMap<ProductMesh, { source: ProductMesh; normalMatrix: Matrix }>();
export const fittedFrom = (mesh: ProductMesh) => origin.get(mesh);
export const registerFitted = (fitted: ProductMesh, source: ProductMesh, normalMatrix: Matrix) =>
  origin.set(fitted, { source, normalMatrix });

/** Whether `fit` changes the mesh at all, with `size` as it stands. */
export function fitChangesMesh(fit: ProductFit | undefined, size: Partial<ProductSize> | undefined) {
  return !!fit && (fit.mirror !== undefined || fit.front !== 0 || (fit.size && validProductSize(size)));
}

/**
 * The mesh as the product is: evened out about its mirror plane, turned so its front is +x of the
 * standing frame, and stretched to the real size (when the fit asks and `size` is a size). Positions
 * come back in the model's own frame, so the pose still applies; indices and colours are shared.
 */
export function fitProductMesh(mesh: ProductMesh, fit: ProductFit, size?: Partial<ProductSize>): ProductMesh {
  const { positions, normalMatrix } = computeFit(mesh, fit, size);
  const fitted: ProductMesh = { positions, indices: mesh.indices, colors: mesh.colors };
  registerFitted(fitted, mesh, normalMatrix);
  return fitted;
}

/** What `fitProductMesh` makes, as plain numbers (a worker can send them): new positions and the normal map. */
export function computeFit(
  mesh: ProductMesh,
  fit: ProductFit,
  size?: Partial<ProductSize>,
): { positions: Float32Array; normalMatrix: number[] } {
  const upright = rotationMatrix(normalized(fit.upright));
  let standing: Float32Array = rotated(mesh.positions, upright);
  if (fit.mirror !== undefined) {
    const normals = rotated(shadingNormals(mesh.positions, mesh.indices, { iterations: 6 }), upright);
    standing = symmetrize(standing, mesh.indices, normals, mirrorPlane(fit));
  }
  const turn = turnAboutZ(-fit.front);
  let turned = rotated(standing, turn);
  let scale: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (fit.size && validProductSize(size)) {
    const { low, high } = trimmedExtents(turned);
    const [sx, sy, sz] = stretch([0, 0, 0], [high[0] - low[0], high[1] - low[1], high[2] - low[2]], size);
    scale = [sx, 0, 0, 0, sy, 0, 0, 0, sz];
    turned = rotated(turned, scale);
  }
  const back = invert(upright);
  const positions = rotated(turned, back);
  // The map of directions the fit applies (the mirror evening is not linear and is left out).
  const linear = multiply(back, multiply(scale, multiply(turn, upright)));
  return { positions, normalMatrix: transpose(invert(linear)) };
}

export const mirrorPlane = (fit: ProductFit): MirrorPlane => ({
  normal: radians(fit.front) + Math.PI / 2,
  offset: fit.mirror ?? 0,
});

/** The direction the photo was taken from, in a fitted mesh's own frame (the model's +x, turned along). */
export function fittedPhotoDirection(fit: ProductFit): Vec {
  const upright = rotationMatrix(normalized(fit.upright));
  const [x, y, z] = apply(multiply(invert(upright), multiply(turnAboutZ(-fit.front), upright)), 1, 0, 0);
  return [x, y, z];
}

/** Normals turned and stretched the way a fit moved the mesh (unit length). */
export function fittedNormals(normals: Float32Array, normalMatrix: Matrix): Float32Array {
  const out = new Float32Array(normals.length);
  for (let i = 0; i < normals.length; i += 3) {
    const [x, y, z] = apply(normalMatrix, normals[i], normals[i + 1], normals[i + 2]);
    const length = Math.hypot(x, y, z) || 1;
    out[i] = x / length;
    out[i + 1] = y / length;
    out[i + 2] = z / length;
  }
  return out;
}

export interface FitEstimate {
  fit: ProductFit;
  /** A mirror plane was found, so the front and the evening out come with it. */
  symmetric: boolean;
  /** The two cues for which end is the front disagree: the person should check. */
  uncertainFront: boolean;
  /** Mean distance between the mirrored surface and the surface, share of the size. */
  mirrorError?: number;
}

/**
 * A fit for a mesh as the pose stands it (`upright` = the pose's object quaternion): the mirror
 * plane and the front when the product is clearly symmetric, else a fit that only offers the size
 * (the model's own axes). With a size, a product that is symmetric both ways (a rectangular bath)
 * takes as left-right the axis whose proportions fit the size best.
 */
export function estimateProductFit(
  mesh: ProductMesh,
  upright: Quaternion4,
  { size, mirror = true }: { size?: Partial<ProductSize>; mirror?: boolean } = {},
): FitEstimate {
  const matrix = rotationMatrix(normalized(upright));
  const standing = rotated(mesh.positions, matrix);
  const symmetry = estimateSymmetry(standing);
  const plain: ProductFit = { upright: normalized(upright), front: 0, size: true };
  if (!symmetry) return { fit: plain, symmetric: false, uncertainFront: false };
  const photo = Math.atan2(matrix[3], matrix[0]);
  const frontOf = (plane: MirrorPlane) => estimateFront(standing, plane, photo);
  let plane: MirrorPlane = symmetry;
  let front = frontOf(plane);
  if (symmetry.twofold && symmetry.partner) {
    const other = frontOf(symmetry.partner);
    // Which of the two planes is left-right: the one that fits the real size better, or, with no size,
    // the one whose front is nearer to where the photo was taken from (a photo is usually of the front).
    const worse = validProductSize(size)
      ? (turn: number) => sizeMismatch(mesh, { ...plain, front: (turn * 180) / Math.PI }, size).worst
      : (turn: number) => -Math.cos(turn - photo);
    if (worse(other.front) < worse(front.front)) {
      plane = symmetry.partner;
      front = other;
    }
  }
  const degrees = (((front.front * 180) / Math.PI + 540) % 360) - 180;
  // The offset is along the plane's own normal; the fit measures along the front's quarter turn.
  const target = front.front + Math.PI / 2;
  const same = Math.cos(plane.normal - target) >= 0;
  return {
    fit: {
      upright: normalized(upright),
      front: degrees,
      ...(mirror ? { mirror: same ? plane.offset : -plane.offset } : {}),
      size: true,
    },
    symmetric: true,
    uncertainFront: front.uncertain,
    mirrorError: symmetry.error,
  };
}

const wrapDegrees = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180;

/** The fit a set of choices makes (`flip` turns the front around). Nothing on: no fit, the mesh as made. */
export function buildFit(
  estimate: FitEstimate,
  choice: { size: boolean; mirror: boolean; flip: boolean },
): ProductFit | undefined {
  const mirror = estimate.symmetric ? estimate.fit.mirror : undefined;
  const evened = choice.mirror && mirror !== undefined;
  if (!choice.size && !evened) return undefined;
  return {
    upright: estimate.fit.upright,
    front: estimate.symmetric ? wrapDegrees(estimate.fit.front + (choice.flip ? 180 : 0)) : 0,
    ...(evened ? { mirror: choice.flip ? -mirror : mirror } : {}),
    size: choice.size,
  };
}

/**
 * The fit a freshly made model starts with: the real size when there is one the photo agrees with
 * (a typed size the photo disagrees with by more than SIZE_MISMATCH is returned as `ask`, not applied),
 * and the mirror evening-out for symmetric kinds of product when a mirror plane was found.
 */
export function startingFit(
  mesh: ProductMesh,
  estimate: FitEstimate,
  { size, symmetricKind }: { size?: Partial<ProductSize>; symmetricKind: boolean },
) {
  const measured = validProductSize(size) ? sizeMismatch(mesh, estimate.fit, size) : undefined;
  const wantSize = !!measured && measured.worst <= SIZE_MISMATCH;
  const fit = buildFit(estimate, {
    size: wantSize,
    mirror: estimate.symmetric && symmetricKind,
    flip: false,
  });
  return { fit, ask: measured && !wantSize ? measured : undefined };
}
