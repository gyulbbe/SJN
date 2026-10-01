import { estimateAlbedo } from './albedo';
import { mixedSurface } from './mixed-color';
import { shadingNormals } from './mesh-cleanup';
import type { ProductMesh, ProductShading } from './state-types';

/** What a view mode draws: colours (sRGB 0–1) and, for the lit modes, normals in the mesh's own frame. */
export interface ProductSurface {
  colors: Float32Array;
  normals?: Float32Array;
}

/** The editor, the 3D room, the PNG capture and the AI export all take their colours from here. */
export const isLitShading = (mode: ProductShading | undefined) => mode === 'lit' || mode === 'mixed';

const computed = new WeakMap<ProductMesh, Partial<Record<ProductShading, ProductSurface>>>();

/** The colours of a mode if they were worked out already (here or, handed over, by a worker). */
export const readySurface = (mode: ProductShading, mesh: ProductMesh) => computed.get(mesh)?.[mode];
export function keepSurface(mode: ProductShading, mesh: ProductMesh, surface: ProductSurface) {
  const modes = computed.get(mesh) ?? {};
  computed.set(mesh, modes);
  modes[mode] ??= surface;
}

/**
 * 'baked': the model's own RGB, as saved. 'lit': one base colour per material, lit by the viewer.
 * 'mixed': base colour plus the photo's detail where the photo shows the product (see mixed-color).
 * It takes about a second on a 290k-vertex mesh, so it is kept for as long as the mesh is, and a
 * screen that must not stop for it asks prepareProductSurface (surface.ts) first, which does the
 * work in a Web Worker and leaves the result here.
 */
export function productSurface(mode: ProductShading, mesh: ProductMesh): ProductSurface {
  const modes = computed.get(mesh) ?? {};
  computed.set(mesh, modes);
  return (modes[mode] ??=
    mode === 'baked'
      ? { colors: mesh.colors }
      : mode === 'lit'
        ? {
            colors: estimateAlbedo(mesh.positions, mesh.indices, mesh.colors),
            normals: shadingNormals(mesh.positions, mesh.indices),
          }
        : mixedSurface(mesh.positions, mesh.indices, mesh.colors));
}
