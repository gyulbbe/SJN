/**
 * The sanitary-ware collection of 2026-11-06 (test-results/위생도기-화신-20261106): 목록.csv's rows, each
 * product's photos and its catalogue size in the app's order. Node only; no network.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SanitaryClass } from './classes';

export type CatalogRow = Record<string, string>;

/** One CSV line (quoted fields, doubled quotes inside them). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '',
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * A catalogue size in the app's order (width × height × depth, mm), or undefined when the site gives
 * none. The site's order differs by kind: a toilet D × W × H, a basin or a urinal W × D × H, a bath
 * L × W × H (its length is the app's width). Two numbers are a round product's diameter and height
 * ("420x175"); a trailing letter is dropped ("17T", a glass thickness, makes 420x140 a round bowl).
 */
export function appSize(kind: SanitaryClass['kind'], text: string): [number, number, number] | undefined {
  const parts = text
    .split(/[xX×]/)
    .map((p) => p.trim())
    .filter((p) => /^\d+$/.test(p))
    .map(Number);
  if (parts.length === 2) {
    const [across, high] = parts;
    return [across, high, across];
  }
  if (parts.length !== 3) return undefined;
  const [a, b, c] = parts;
  return kind === '양변기' ? [b, c, a] : [a, c, b];
}

/**
 * A product's series: a CLINS or LHY code with its number (HSL 302S and HSL 302V are one series), or
 * a LAUCHE name's first word (그레타 2342 and 그레타 2360 are one series).
 */
export function seriesOf(name: string) {
  const code = name.match(/^([A-Z]{2,5})[\s-]*(\d+)/);
  return code ? `${code[1]}${code[2].slice(0, 3)}` : name.split(/\s+/)[0];
}

export type Catalog = {
  rows: Map<number, CatalogRow>;
  /** Every photo of a product, in the site's order (_1, _2, …). */
  photos: Map<number, string[]>;
};

export function readCatalog(dir: string): Catalog {
  const [head, ...lines] = readFileSync(path.join(dir, '목록.csv'), 'utf8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter(Boolean);
  const columns = parseCsvLine(head);
  const rows = new Map(
    lines.map((line) => {
      const row = Object.fromEntries(parseCsvLine(line).map((v, i) => [columns[i], v]));
      return [Number(row.product_cd), row];
    }),
  );
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
    );
  const found: [number, number, string][] = [];
  for (const file of walk(dir)) {
    const m = path.basename(file).match(/\[(\d+)\]_(\d+)\.\w+$/);
    if (m) found.push([Number(m[1]), Number(m[2]), file]);
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const photos = new Map<number, string[]>();
  for (const [cd, , file] of found) photos.set(cd, [...(photos.get(cd) ?? []), file]);
  return { rows, photos };
}
