import type { ProductMeshAssetRecord } from '../../src/lib/types';

/** The mime the removed 360° editor stored its meshes under (docs/product3d-removal.md). */
export const PRODUCT_MESH_MIME = 'application/x-sjn-product-mesh' as const;

/**
 * A mesh asset as an older version of the app stored it. Its bytes are opaque here: nothing opens
 * a mesh any more, a material only keeps its reference and the asset stays stored.
 */
export function legacyMeshAsset(name: string, sourceAssetId: string): ProductMeshAssetRecord {
  const blob = new Blob([new Uint8Array([83, 74, 78, 77, 1, 2, 3, 4])], { type: PRODUCT_MESH_MIME });
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name,
    kind: 'product-mesh',
    mime: PRODUCT_MESH_MIME,
    size: blob.size,
    sourceAssetId,
    createdAt: new Date().toISOString(),
    blob,
  };
}
