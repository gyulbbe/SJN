import type { ProductMesh } from './state-types';

/** What the photo gives each vertex: its colour (sRGB 0–1, three per vertex) and how far to trust it (0–1). */
export interface PhotoColors {
  colors: Float32Array;
  weight: Float32Array;
}

const painted = new WeakMap<ProductMesh, PhotoColors>();

/**
 * A mesh that carries the input photo's colours (see photo-color.ts) is a mesh of its own: its
 * colour modes read the photo where the photo shows the product. It is a separate object so a mesh
 * without them (the photo colours turned off) keeps its own, and so every colour that is worked
 * out per mesh stays right.
 */
export const registerPainted = (mesh: ProductMesh, photo: PhotoColors) => painted.set(mesh, photo);
export const paintedFrom = (mesh: ProductMesh): PhotoColors | undefined => painted.get(mesh);
