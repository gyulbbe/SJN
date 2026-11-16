/**
 * The fixture-haze trial's catalogue (docs/fixture-haze-20261116.md, section 4): the 2026-11-02 public
 * snapshot, plus the three basins registered on the LOCAL dev server with direction photos
 * (register.mjs), taken from its public catalogue by tests/catalog-match/snapshot.mjs into
 * test-results/fixture-haze-20261116/catalog/. Image files are absolute paths.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicRecord } from '../export-photoreal/scene-builder';
import { SNAPSHOT } from '../tile-ai/paths.mjs';
import { OUT } from './paths.mjs';

export const LOCAL = join(OUT as string, 'catalog');
type Catalog = { placements: (PublicRecord & { materialId: string; name: string })[] };

export function trialCatalog() {
  const records: Record<string, PublicRecord & { name: string }> = {};
  const files: Record<string, string> = {};
  for (const dir of [SNAPSHOT as string, LOCAL]) {
    const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')) as Catalog;
    for (const p of catalog.placements) records[p.materialId] = p;
    for (const f of readdirSync(join(dir, 'images'))) files[f] = join(dir, 'images', f);
  }
  /** Asset id → file name, as the scene builder asks for /images/<file>. */
  const imageFiles = Object.fromEntries(Object.keys(files).map((f) => [f.replace(/\.[a-z]+$/, ''), f]));
  return { records, files, imageFiles };
}
