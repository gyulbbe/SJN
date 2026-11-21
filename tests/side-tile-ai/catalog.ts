/** The trial's catalogue (catalog.mjs): records by material id and image files by asset id. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicRecord } from '../export-photoreal/scene-builder';
import { CATALOG } from './paths.mjs';

export function trialCatalog() {
  const catalog = JSON.parse(readFileSync(join(CATALOG as string, 'catalog.json'), 'utf8')) as {
    placements: (PublicRecord & { materialId: string; name: string })[];
  };
  const records: Record<string, PublicRecord & { name: string }> = {};
  for (const p of catalog.placements) records[p.materialId] = p;
  const files: Record<string, string> = {};
  for (const f of readdirSync(join(CATALOG as string, 'images')))
    files[f] = join(CATALOG as string, 'images', f);
  const imageFiles = Object.fromEntries(Object.keys(files).map((f) => [f.replace(/\.[a-z]+$/, ''), f]));
  return { records, files, imageFiles };
}
