import { readFile } from 'node:fs/promises';
import type { D1DatabaseLike } from '../../src/lib/d1/types';

// Keep a CREATE TRIGGER ... BEGIN ... END block together. Splitting on every
// semicolon silently breaks migrations as soon as the first trigger is added.
export function migrationStatements(sql: string): string[] {
  const source = sql.replace(/--[^\n]*/g, '');
  const result: string[] = [];
  let start = 0;
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === quote) {
        if (source[i + 1] === quote) i++;
        else quote = '';
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char !== ';') continue;
    const statement = source.slice(start, i).trim();
    if (/^CREATE\s+TRIGGER\b/i.test(statement) && !/\bEND\s*$/i.test(statement)) continue;
    if (statement) result.push(statement);
    start = i + 1;
  }
  const last = source.slice(start).trim();
  if (last) result.push(last);
  return result;
}
export async function applyD1Migrations(db: D1DatabaseLike, files: string[]) {
  for (const file of files) {
    const sql = await readFile(`migrations/d1/${file}`, 'utf8');
    for (const statement of migrationStatements(sql)) await db.prepare(statement).run();
  }
}
export const allD1Migrations = [
  '0001_auth.sql',
  '0002_storage.sql',
  '0003_catalog.sql',
  '0004_catalog_seed.sql',
  '0005_admin_management.sql',
  '0006_reconstruction_diagnostics.sql',
  '0007_username_auth.sql',
];
