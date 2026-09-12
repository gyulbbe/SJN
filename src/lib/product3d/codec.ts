import type { ProductMeshAssetRecord } from '../types';
import type { ProductMesh } from './state-types';

export const PRODUCT_MESH_MIME = 'application/x-sjn-product-mesh';
export const MAX_PRODUCT_MESH_BYTES = 25 * 1024 * 1024;
const MAGIC = new Uint8Array([83, 74, 78, 80, 77, 69, 83, 72]); // SJNPMESH
const HEADER_BYTES = 24;
const invalid = () => new Error('입체 데이터가 손상됐거나 지원하지 않는 형식이에요. 다시 입체화해 주세요.');

export function validateProductMesh(mesh: ProductMesh): void {
  if (
    !(mesh.positions instanceof Float32Array) ||
    !(mesh.colors instanceof Float32Array) ||
    !(mesh.indices instanceof Uint32Array) ||
    mesh.positions.length < 9 ||
    mesh.positions.length % 3 !== 0 ||
    mesh.colors.length !== mesh.positions.length ||
    mesh.indices.length < 3 ||
    mesh.indices.length % 3 !== 0
  )
    throw invalid();
  if (
    HEADER_BYTES + mesh.positions.byteLength + mesh.colors.byteLength + mesh.indices.byteLength >
    MAX_PRODUCT_MESH_BYTES
  )
    throw new Error('입체 데이터는 25MB 이하여야 해요.');
  const vertices = mesh.positions.length / 3;
  for (const value of mesh.positions) if (!Number.isFinite(value)) throw invalid();
  for (const value of mesh.colors) if (!Number.isFinite(value) || value < 0 || value > 1) throw invalid();
  for (const index of mesh.indices) if (index >= vertices) throw invalid();
}

/** Explicit little-endian format, independent of the executing CPU architecture. */
export function encodeProductMesh(mesh: ProductMesh): Blob {
  validateProductMesh(mesh);
  const bytes = new ArrayBuffer(
    HEADER_BYTES + mesh.positions.byteLength + mesh.colors.byteLength + mesh.indices.byteLength,
  );
  const view = new DataView(bytes);
  new Uint8Array(bytes, 0, MAGIC.length).set(MAGIC);
  view.setUint32(8, 1, true);
  view.setUint32(12, mesh.positions.length / 3, true);
  view.setUint32(16, mesh.indices.length, true);
  view.setUint32(20, 0, true);
  let offset = HEADER_BYTES;
  for (const values of [mesh.positions, mesh.colors])
    for (const value of values) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
  for (const index of mesh.indices) {
    view.setUint32(offset, index, true);
    offset += 4;
  }
  return new Blob([bytes], { type: PRODUCT_MESH_MIME });
}

export async function decodeProductMesh(blob: Blob): Promise<ProductMesh> {
  if (blob.size > MAX_PRODUCT_MESH_BYTES) throw new Error('입체 데이터는 25MB 이하여야 해요.');
  if (
    blob.size < HEADER_BYTES ||
    (blob.type && blob.type !== PRODUCT_MESH_MIME && blob.type !== 'application/octet-stream')
  )
    throw invalid();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (
    !MAGIC.every((value, index) => bytes[index] === value) ||
    view.getUint32(8, true) !== 1 ||
    view.getUint32(20, true) !== 0
  )
    throw invalid();
  const vertexCount = view.getUint32(12, true);
  const indexCount = view.getUint32(16, true);
  if (
    vertexCount < 3 ||
    indexCount < 3 ||
    indexCount % 3 !== 0 ||
    HEADER_BYTES + vertexCount * 24 + indexCount * 4 !== buffer.byteLength
  )
    throw invalid();
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let offset = HEADER_BYTES;
  for (const values of [positions, colors])
    for (let i = 0; i < values.length; i++) {
      values[i] = view.getFloat32(offset, true);
      offset += 4;
    }
  for (let i = 0; i < indexCount; i++) {
    indices[i] = view.getUint32(offset, true);
    offset += 4;
  }
  const mesh = { positions, colors, indices };
  validateProductMesh(mesh);
  return mesh;
}

export async function makeProductMeshAsset(
  mesh: ProductMesh,
  name: string,
  sourceAssetId: string,
): Promise<ProductMeshAssetRecord> {
  if (!sourceAssetId) throw new Error('입체화에 사용한 원본 이미지를 먼저 저장해 주세요.');
  const blob = encodeProductMesh(mesh);
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
