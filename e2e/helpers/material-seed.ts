import sharp from 'sharp';
import type { AuthenticatedApp } from './authenticated-app';

/** A seeded catalogue's size (tiles, then basins). */
export const TILES = 110,
  PRODUCTS = 20;
const COLORS = ['화이트', '그레이 · 베이지', '차콜'];
/** A catalogue straight into the isolated D1/R2 (the 0009 triggers fill the list summary). */
export async function seed(app: AuthenticatedApp) {
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#b9b5aa' } })
    .png()
    .toBuffer();
  const owner = app.actor.id;
  const statements = [];
  const rows: { name: string; usage: string; category: string; versionId: string; assetId: string }[] = [];
  for (let i = 0; i < TILES + PRODUCTS; i++) {
    const tile = i < TILES;
    const assetId = crypto.randomUUID(),
      materialId = crypto.randomUUID(),
      versionId = crypto.randomUUID();
    const key = `assets/${owner}/${assetId}/1`;
    await app.env.ASSET_BUCKET.put(key, png, { httpMetadata: { contentType: 'image/png' } });
    const name = tile
      ? `페이징 타일 ${String(i).padStart(3, '0')}`
      : `페이징 세면대 ${String(i).padStart(3, '0')}`;
    const usage = ['both', 'wall', 'floor'][i % 3];
    rows.push({ name, usage, category: tile ? 'tile' : 'basin', versionId, assetId });
    const created = new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
    statements.push(
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
          category: tile ? 'tile' : 'basin',
          scope: 'shared',
          description: '',
          color: COLORS[i % 3],
          finish: i % 4 ? '무광' : '유광',
          widthMm: tile ? [600, 300][i % 2] : 600,
          heightMm: tile ? 600 : 450,
          depthMm: tile ? 10 : 400,
          usage: tile ? usage : 'both',
          installation: tile ? 'wall' : 'floor',
          textureAssetIds: tile ? [assetId] : [],
          views: tile ? [] : [{ assetId, direction: '정면', anchor: { x: 0.5, y: 1 } }],
          defaultGroutWidth: 2,
          defaultGroutColor: '#d5d1c9',
          defaultPattern: 'grid',
          createdAt: created,
        }),
        tile ? 'tile' : 'basin',
        tile ? 0 : 1,
        created,
      ),
      app.env.DB.prepare('INSERT INTO d1_material_assets(version_id,asset_id) VALUES(?,?)').bind(
        versionId,
        assetId,
      ),
    );
  }
  await app.env.DB.batch(statements);
  return rows;
}
