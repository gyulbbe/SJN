import sharp from 'sharp';
import type { AuthenticatedApp } from './authenticated-app';

/** A seeded catalogue's size (tiles, then basins). */
export const TILES = 110,
  PRODUCTS = 20;
const COLORS = ['화이트', '그레이 · 베이지', '차콜'];
type Spec = {
  i: number;
  name: string;
  tile: boolean;
  category: string;
  usage: string;
  installation: string;
};
export type SeededRow = { name: string; usage: string; category: string; versionId: string; assetId: string };
/** One shared catalogue material (its image in R2, then the rows the 0009 triggers summarise). */
async function material(app: AuthenticatedApp, png: Buffer, spec: Spec) {
  const owner = app.actor.id;
  const { i, name, tile, category, usage } = spec;
  const assetId = crypto.randomUUID(),
    materialId = crypto.randomUUID(),
    versionId = crypto.randomUUID();
  const key = `assets/${owner}/${assetId}/1`;
  await app.env.ASSET_BUCKET.put(key, png, { httpMetadata: { contentType: 'image/png' } });
  const row: SeededRow = { name, usage, category, versionId, assetId };
  const created = new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
  const statements = [
    app.env.DB.prepare(
      'INSERT INTO d1_assets(id,owner_id,object_key,metadata_json,content_hash,created_at) VALUES(?,?,?,?,?,?)',
    ).bind(
      assetId,
      owner,
      key,
      JSON.stringify({
        id: assetId,
        ownerId: owner,
        name: name + '.png',
        kind: tile ? 'texture' : 'product',
        mime: 'image/png',
        width: 16,
        height: 16,
        size: png.length,
        createdAt: created,
      }),
      'hash-' + assetId,
      created,
    ),
    app.env.DB.prepare(
      "INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose) VALUES(?,?,'shared',?,?,?,'catalog')",
    ).bind(materialId, owner, versionId, created, created),
    app.env.DB.prepare(
      'INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES(?,?,1,?,?,?,?)',
    ).bind(
      versionId,
      materialId,
      JSON.stringify({
        id: versionId,
        materialId,
        version: 1,
        name,
        brand: i % 2 ? 'TOTO' : '',
        code: 'PG-' + i,
        category,
        scope: 'shared',
        description: '',
        color: COLORS[i % 3],
        finish: i % 4 ? '무광' : '유광',
        widthMm: tile ? [600, 300][i % 2] : 600,
        heightMm: tile ? 600 : 450,
        depthMm: tile ? 10 : 400,
        usage,
        installation: spec.installation,
        textureAssetIds: tile ? [assetId] : [],
        views: tile ? [] : [{ assetId, direction: '정면', anchor: { x: 0.5, y: 1 } }],
        defaultGroutWidth: 2,
        defaultGroutColor: '#d5d1c9',
        defaultPattern: 'grid',
        createdAt: created,
      }),
      category,
      tile ? 0 : 1,
      created,
    ),
    app.env.DB.prepare('INSERT INTO d1_material_assets(version_id,asset_id) VALUES(?,?)').bind(
      versionId,
      assetId,
    ),
  ];
  return { row, statements };
}
const swatch = () =>
  sharp({ create: { width: 16, height: 16, channels: 3, background: '#b9b5aa' } })
    .png()
    .toBuffer();
/** A catalogue straight into the isolated D1/R2 (the 0009 triggers fill the list summary). */
export async function seed(app: AuthenticatedApp) {
  const png = await swatch();
  const statements = [];
  const rows: SeededRow[] = [];
  for (let i = 0; i < TILES + PRODUCTS; i++) {
    const tile = i < TILES;
    const made = await material(app, png, {
      i,
      tile,
      name: tile
        ? `페이징 타일 ${String(i).padStart(3, '0')}`
        : `페이징 세면대 ${String(i).padStart(3, '0')}`,
      category: tile ? 'tile' : 'basin',
      usage: tile ? ['both', 'wall', 'floor'][i % 3] : 'both',
      installation: tile ? 'wall' : 'floor',
    });
    // The returned row keeps the tile pattern's usage for every row (as before).
    rows.push({ ...made.row, usage: ['both', 'wall', 'floor'][i % 3] });
    statements.push(...made.statements);
  }
  await app.env.DB.batch(statements);
  return rows;
}
/** More shared products of given kinds (after the catalogue's, so newer). */
export async function seedProducts(
  app: AuthenticatedApp,
  products: { name: string; category: string; installation?: string }[],
) {
  const png = await swatch();
  const statements = [];
  const rows: SeededRow[] = [];
  for (const [n, product] of products.entries()) {
    const made = await material(app, png, {
      i: TILES + PRODUCTS + n,
      tile: false,
      name: product.name,
      category: product.category,
      usage: 'both',
      installation: product.installation ?? 'floor',
    });
    rows.push(made.row);
    statements.push(...made.statements);
  }
  await app.env.DB.batch(statements);
  return rows;
}
