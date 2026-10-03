import { SOURCE_CAMERA, projectVertices, type PhotoCamera } from '../../src/lib/product3d/photo-camera';
import { rasterize, type ProductPhoto } from '../../src/lib/product3d/photo-color';
import type { ProductMesh } from '../../src/lib/product3d/state-types';
import { toilet } from './product3d-fit-shapes';

export const SIZE = 512;

/** A flat sheet facing +x at `x`, `half` wide and high, `divisions` squares a side. */
export function sheet(
  x: number,
  half: number,
  divisions: number,
  around: [number, number] = [0, 0],
): ProductMesh {
  const count = divisions + 1;
  const positions = new Float32Array(count * count * 3);
  for (let j = 0; j < count; j++)
    for (let i = 0; i < count; i++)
      positions.set(
        [x, around[0] + (i / divisions - 0.5) * 2 * half, around[1] + (j / divisions - 0.5) * 2 * half],
        (j * count + i) * 3,
      );
  const indices: number[] = [];
  for (let j = 0; j < divisions; j++)
    for (let i = 0; i < divisions; i++) {
      const a = j * count + i,
        b = a + 1,
        c = a + count,
        d = c + 1;
      // Seen from +x with y to the right and z up, counter-clockwise: the normal is +x.
      indices.push(a, b, d, a, d, c);
    }
  return {
    positions,
    indices: Uint32Array.from(indices),
    colors: new Float32Array(positions.length).fill(0.8),
  };
}
export const concat = (a: ProductMesh, b: ProductMesh): ProductMesh => {
  const offset = a.positions.length / 3;
  return {
    positions: Float32Array.from([...a.positions, ...b.positions]),
    colors: Float32Array.from([...a.colors, ...b.colors]),
    indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, (i) => i + offset)]),
  };
};
export const onFront: PhotoCamera = { ...SOURCE_CAMERA, distance: 2, focal: 2.75 };

/** The photo a camera would take of the mesh: its outline as the alpha, colours from `colour(x, y)` (0–255, rows down). */
export function photoOf(
  mesh: ProductMesh,
  camera: PhotoCamera,
  colour: (x: number, y: number) => [number, number, number] = () => [210, 210, 210],
): ProductPhoto {
  const { depth } = rasterize(projectVertices(mesh.positions, camera, SIZE), mesh.indices, SIZE);
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (!Number.isFinite(depth[i])) continue;
      data.set([...colour(x, y), 255], i * 4);
    }
  return { size: SIZE, data };
}
export const alphaOf = (photo: ProductPhoto) =>
  Uint8Array.from({ length: SIZE * SIZE }, (_, i) => photo.data[i * 4 + 3]);
export const centred = (mesh: ProductMesh): ProductMesh => {
  const positions = new Float32Array(mesh.positions);
  const centre = [0.35, 0, 0.42];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) positions[i + k] -= centre[k];
  return { ...mesh, positions };
};
export const toiletMesh = (divisions: number): ProductMesh => {
  const shape = toilet(divisions);
  return centred({ ...shape, colors: new Float32Array(shape.positions.length).fill(0.8) });
};
