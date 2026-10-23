/**
 * List images: a small copy (long side LIST_IMAGE_EDGE) of the image a material card shows
 * (docs/list-thumbnails-results-20261023.md). It is an asset of kind 'thumbnail', derivation 'list',
 * whose `source_asset_id` is that image. It is never read by its own id from a card: a card asks for
 * the source image with `size=list`, the source is authorized exactly as before, and the list image
 * of that source is returned in its place (the source itself when there is none yet).
 */
import { z } from 'zod';
import { getMaterialImageAssetId } from '../material-images';
import { readMaterialViews } from '../product-direction';
import type { MaterialVersion } from '../types';
import { invalid } from './http';
import type { D1DatabaseLike } from './types';

/** Long side of a list image, in pixels. */
export const LIST_IMAGE_EDGE = 256;
/** The largest side the server accepts for one (a list image is never a full image). */
export const LIST_IMAGE_MAX_EDGE = 512;

/** A source image's list image, through the `source_asset_id` index (a source has few children). */
export const LIST_IMAGE_OF = `SELECT object_key,metadata_json FROM d1_assets INDEXED BY d1_assets_source
  WHERE source_asset_id=? AND deleting=0 AND json_extract(metadata_json,'$.derivation')='list' LIMIT 1`;

export async function listImageOf(db: D1DatabaseLike, sourceId: string) {
  return db.prepare(LIST_IMAGE_OF).bind(sourceId).first<{ object_key: string; metadata_json: string }>();
}

/** Which of these source images already have a list image (one query). */
export async function listedSources(db: D1DatabaseLike, sourceIds: string[]): Promise<Set<string>> {
  if (!sourceIds.length) return new Set();
  const rows = await db
    .prepare(
      `SELECT DISTINCT a.source_asset_id AS id FROM json_each(?) q CROSS JOIN d1_assets a INDEXED BY d1_assets_source
       WHERE a.source_asset_id=q.value AND a.deleting=0 AND json_extract(a.metadata_json,'$.derivation')='list'`,
    )
    .bind(JSON.stringify([...new Set(sourceIds)]))
    .all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
}

/** One backfill page: shared current materials' card images and whether each has a list image. */
export type ListImagePage = {
  items: { materialId: string; name: string; imageAssetId: string; listImage: boolean }[];
  nextCursor: string | null;
  /** First page only: every shared current material (active and deactivated). */
  total?: number;
};
const BACKFILL_PAGE = 48;
type BackfillCursor = { a: 0 | 1; u?: string; m?: string };
const cursorSchema = z
  .object({
    a: z.union([z.literal(0), z.literal(1)]),
    u: z.string().max(100).optional(),
    m: z.string().max(100).optional(),
  })
  .strict();
const encode = (cursor: BackfillCursor) =>
  btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decode(text: string): BackfillCursor {
  try {
    return cursorSchema.parse(JSON.parse(atob(text.replace(/-/g, '+').replace(/_/g, '/'))));
  } catch {
    throw invalid('목록 위치를 확인해 주세요.');
  }
}
/**
 * The administrator's backfill walks shared current materials newest first (active ones, then
 * deactivated ones) through the 0009 summary, a page at a time; reads follow the page.
 */
export async function listImagePage(db: D1DatabaseLike, cursorText?: string): Promise<ListImagePage> {
  const cursor = cursorText ? decode(cursorText) : ({ a: 1 } as BackfillCursor);
  const after = cursor.u && cursor.m ? ' AND (l.updated_at,l.material_id)<(?,?)' : '';
  const rows = await db
    .prepare(
      `SELECT l.material_id,l.updated_at,v.payload_json FROM d1_material_list l INDEXED BY d1_list_recent
       CROSS JOIN d1_material_versions v
       WHERE l.active=? AND l.is_current=1 AND l.scope='shared'${after} AND v.id=l.version_id
       ORDER BY l.updated_at DESC,l.material_id DESC LIMIT ?`,
    )
    .bind(cursor.a, ...(after ? [cursor.u, cursor.m] : []), BACKFILL_PAGE + 1)
    .all<{ material_id: string; updated_at: string; payload_json: string }>();
  const page = rows.results.slice(0, BACKFILL_PAGE);
  const cards = page.flatMap((row) => {
    const version = readMaterialViews(JSON.parse(row.payload_json) as MaterialVersion);
    const imageAssetId = getMaterialImageAssetId(version);
    return imageAssetId ? [{ materialId: row.material_id, name: version.name, imageAssetId }] : [];
  });
  const listed = await listedSources(
    db,
    cards.map((card) => card.imageAssetId),
  );
  const last = page.at(-1);
  const nextCursor =
    rows.results.length > BACKFILL_PAGE && last
      ? encode({ a: cursor.a, u: last.updated_at, m: last.material_id })
      : cursor.a === 1
        ? encode({ a: 0 })
        : null;
  const total = cursorText
    ? undefined
    : ((
        await db
          .prepare(
            `SELECT coalesce(SUM(n),0) AS n FROM d1_material_list_counts WHERE active IN (0,1) AND facet='' AND value='' AND n>0`,
          )
          .first<{ n: number }>()
      )?.n ?? 0);
  return {
    items: cards.map((card) => ({ ...card, listImage: listed.has(card.imageAssetId) })),
    nextCursor,
    ...(total === undefined ? {} : { total }),
  };
}
