import { describe, expect, it } from 'vitest';
import {
  decodeProductMesh,
  encodeProductMesh,
  makeProductMeshAsset,
  MAX_PRODUCT_MESH_BYTES,
  PRODUCT_MESH_MIME,
} from '../src/lib/product3d/codec';
import type { ProductMesh } from '../src/lib/product3d/state-types';

const triangle = (): ProductMesh => ({
  positions: new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0]),
  colors: new Float32Array([1, 1, 1, 0.2, 0.5, 0.7, 0, 0, 0]),
  indices: new Uint32Array([0, 1, 2]),
});
async function corrupt(offset: number, value: number) {
  const bytes = await encodeProductMesh(triangle()).arrayBuffer();
  new DataView(bytes).setUint32(offset, value, true);
  return new Blob([bytes], { type: PRODUCT_MESH_MIME });
}
describe('versioned product mesh binary', () => {
  it('round-trips exact typed-array values without aliasing the source', async () => {
    const mesh = triangle();
    const blob = encodeProductMesh(mesh);
    const restored = await decodeProductMesh(blob);
    expect(blob.type).toBe(PRODUCT_MESH_MIME);
    expect(blob.size).toBe(108);
    expect(restored).toEqual(mesh);
    restored.positions[0] = 20;
    expect(mesh.positions[0]).toBe(-1);
  });
  it.each([0, 8, 12, 16, 20])('rejects a corrupt header field at byte %i', async (offset) => {
    await expect(decodeProductMesh(await corrupt(offset, 0xffffffff))).rejects.toThrow('손상');
  });
  it('rejects truncated, trailing, empty, oversized, or foreign bytes', async () => {
    const valid = encodeProductMesh(triangle());
    await expect(decodeProductMesh(valid.slice(0, valid.size - 1))).rejects.toThrow();
    await expect(decodeProductMesh(new Blob([valid, new Uint8Array(4)]))).rejects.toThrow();
    await expect(decodeProductMesh(new Blob([]))).rejects.toThrow();
    await expect(decodeProductMesh(new Blob([new Uint8Array(MAX_PRODUCT_MESH_BYTES + 1)]))).rejects.toThrow(
      '25MB',
    );
    await expect(decodeProductMesh(new Blob([valid], { type: 'image/png' }))).rejects.toThrow();
  });
  it.each(['positions', 'colors'] as const)(
    'rejects non-finite %s on encoding and decoding',
    async (field) => {
      const mesh = triangle();
      mesh[field][0] = NaN;
      expect(() => encodeProductMesh(mesh)).toThrow();
      const offset = field === 'positions' ? 24 : 60;
      await expect(decodeProductMesh(await corrupt(offset, 0x7f800000))).rejects.toThrow();
    },
  );
  it('rejects inconsistent arrays, out-of-range colors and triangle indices', () => {
    const mesh = triangle();
    expect(() => encodeProductMesh({ ...mesh, colors: new Float32Array(3) })).toThrow();
    expect(() => encodeProductMesh({ ...mesh, indices: new Uint32Array([0, 1]) })).toThrow();
    expect(() => encodeProductMesh({ ...mesh, indices: new Uint32Array([0, 1, 3]) })).toThrow();
    mesh.colors[0] = 1.1;
    expect(() => encodeProductMesh(mesh)).toThrow();
  });
  it('creates a separate asset with the exact input reference and no fictitious image dimensions', async () => {
    const source = crypto.randomUUID();
    const asset = await makeProductMeshAsset(triangle(), '제품 입체', source);
    expect(asset.kind).toBe('product-mesh');
    expect(asset.sourceAssetId).toBe(source);
    expect(asset).not.toHaveProperty('width');
    expect(asset).not.toHaveProperty('height');
    expect(asset.id).not.toBe(source);
    await expect(makeProductMeshAsset(triangle(), '제품 입체', '')).rejects.toThrow();
  });
});
