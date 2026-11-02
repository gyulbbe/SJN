/**
 * Reading the catalog-match trial's saved features (node): the catalog snapshot and its features, the
 * query faces and theirs, as typed arrays. Shared by the round scripts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicPlacement } from '../../src/lib/catalog/placement-contract';
import { OUT, SNAPSHOT } from './paths.mjs';
import type { ColourFeatures, TextureFeatures } from './tile-features';

export const out = OUT as string;
export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export type Classic = { colour: ColourFeatures; texture: TextureFeatures };
export type Matrix = { rows: number; dims: number; data: Float32Array };
export function readMatrix(path: string, rows: number): Matrix | undefined {
  if (!existsSync(path)) return;
  const buffer = readFileSync(path);
  const data = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  return { rows, dims: data.length / rows, data };
}
export function cosineRow(m: Matrix, row: number, query: Float32Array | number[], offset = 0): number {
  let dot = 0;
  const base = row * m.dims;
  for (let k = 0; k < m.dims; k++) dot += m.data[base + k] * query[offset + k];
  return dot;
}

export type CatalogTile = {
  id: string;
  name: string;
  code: string;
  brand: string;
  usage: 'wall' | 'floor' | 'both';
  widthMm: number;
  heightMm: number;
  color: string;
  finish: string;
  classic: Classic;
};
export function loadCatalog(dir = join(out, 'features', 'catalog')) {
  const ids = readJson<string[]>(join(dir, 'ids.json'));
  const classic = readJson<(Classic & { id: string })[]>(join(dir, 'classic.json'));
  const snapshot = readJson<{ takenAt: string; placements: PublicPlacement[] }>(
    join(SNAPSHOT as string, 'catalog.json'),
  );
  const byId = new Map(snapshot.placements.map((p) => [p.materialId, p]));
  const tiles: CatalogTile[] = ids.map((id, i) => {
    const p = byId.get(id)!;
    if (classic[i].id !== id) throw new Error('classic.json out of order');
    return {
      id,
      name: p.name,
      code: p.code,
      brand: p.brand,
      usage: p.usage,
      widthMm: p.widthMm,
      heightMm: p.heightMm,
      color: p.color,
      finish: p.finish,
      classic: classic[i],
    };
  });
  const matrix = (name: string) => readMatrix(join(dir, `${name}.f32`), ids.length);
  return { takenAt: snapshot.takenAt, tiles, matrix, placements: snapshot.placements };
}

export type QueryRow = { query: string; variant: string; mm: { widthMm: number; heightMm: number } };
export type QueryFace = {
  id: string;
  set: string;
  split: string;
  photo: string;
  path: string;
  face: 'back' | 'left' | 'right' | 'floor';
  materialId?: string;
  observed?: { color?: string; widthMm?: number; heightMm?: number } | null;
  resolution: number;
};
export function loadQueries(dir: string) {
  const faces = readJson<QueryFace[]>(join(dir, 'faces.json'));
  const rows = readJson<QueryRow[]>(join(dir, 'rows.json'));
  const classic = readJson<Classic[]>(join(dir, 'classic.json'));
  const matrix = (name: string) => readMatrix(join(dir, `${name}.f32`), rows.length);
  return { faces, rows, classic, matrix };
}
