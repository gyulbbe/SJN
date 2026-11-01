import { z } from 'zod';
import { assertion, batch, mutationStatement, sql, stamp, type Context } from '@/lib/d1/database';
import { D1StorageError, invalid, json } from '@/lib/d1/http';
import type { D1Bindings, D1DatabaseLike } from '@/lib/d1/types';
import {
  layoutItemSchema,
  layoutItemsSchema,
  layoutNameSchema,
  layoutOrderSchema,
  layoutRoomSchema,
  MAX_FIXTURE_LAYOUTS,
  publicLayoutsSchema,
  type LayoutItem,
  type LayoutRoom,
  type ManagedLayout,
} from '@/lib/fixture-layout-contract';
import type { PublicPlacement } from './placement-contract';
import { currentPublic, placementsOf } from './public';

/** 기본 배치 (migration 0013): the public list and an administrator's management. */
type Row = {
  id: string;
  name: string;
  sortOrder: number | null;
  active: number;
  revision: number;
  items_json: string;
  room_json: string;
};
type Stored = Omit<Row, 'items_json' | 'room_json'> & { items: LayoutItem[]; room: LayoutRoom };

function readRow(row: Row): Stored | undefined {
  // A row this code cannot read is left out rather than taking the whole list down.
  try {
    const items = z.array(layoutItemSchema).parse(JSON.parse(row.items_json));
    const room = layoutRoomSchema.parse(JSON.parse(row.room_json));
    return {
      id: row.id,
      name: row.name,
      sortOrder: row.sortOrder,
      active: row.active,
      revision: row.revision,
      items,
      room,
    };
  } catch {
    return undefined;
  }
}
/**
 * The layouts in their order (표시 순서, then those without one, by name). A table of 30 rows at most,
 * read whole. Before 0013 is applied there are none.
 */
async function readLayouts(db: D1DatabaseLike, activeOnly: boolean): Promise<Stored[]> {
  try {
    const rows = await db
      .prepare(
        `SELECT id,name,display_order AS sortOrder,active,revision,items_json,room_json FROM d1_fixture_layouts${activeOnly ? ' WHERE active=1' : ''}
         ORDER BY display_order IS NULL,display_order,name,id`,
      )
      .all<Row>();
    return rows.results.flatMap((row) => readRow(row) ?? []);
  } catch (error) {
    if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return [];
    throw error;
  }
}
/** Each material's current public placement, by material id (one read for all of them). */
async function placeable(env: D1Bindings, layouts: { items: LayoutItem[] }[]) {
  const ids = [...new Set(layouts.flatMap((layout) => layout.items.map((item) => item.materialId)))];
  const placements = ids.length ? await placementsOf(env, await currentPublic(env, ids)) : [];
  return new Map<string, PublicPlacement>(
    placements
      .filter((placement) => placement.category !== 'tile' && placement.views.length > 0)
      .map((placement) => [placement.materialId, placement]),
  );
}

/**
 * GET /api/catalog/layouts: no account needed. A product no longer public drops out of its layout and
 * is counted; a layout left with none is not listed.
 */
export async function publicLayouts(env: D1Bindings): Promise<Response> {
  const stored = await readLayouts(env.DB, true);
  const placements = await placeable(env, stored);
  const layouts = stored.flatMap((layout) => {
    const items = layout.items.filter((item) => placements.has(item.materialId));
    return items.length
      ? [
          {
            id: layout.id,
            name: layout.name,
            room: layout.room,
            items,
            missing: layout.items.length - items.length,
          },
        ]
      : [];
  });
  const used = new Set(layouts.flatMap((layout) => layout.items.map((item) => item.materialId)));
  return json(
    publicLayoutsSchema.parse({
      layouts,
      placements: [...placements.values()].filter((placement) => used.has(placement.materialId)),
    }),
  );
}

const reference = z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict();
const createInput = z
  .object({
    name: layoutNameSchema,
    sortOrder: layoutOrderSchema,
    active: z.boolean(),
    items: layoutItemsSchema,
    room: layoutRoomSchema,
  })
  .strict();
const overwriteInput = reference.extend({ items: layoutItemsSchema, room: layoutRoomSchema }).strict();
const updateInput = reference
  .extend({ name: layoutNameSchema, sortOrder: layoutOrderSchema, active: z.boolean() })
  .strict();

/** Registering checks here too: only what anyone can read may go in (no personal or analysis model). */
async function requirePlaceable(ctx: Context, items: LayoutItem[]) {
  const placements = await placeable(ctx.env, [{ items }]);
  if (items.some((item) => !placements.has(item.materialId)))
    throw invalid(
      '공개된 공용 제품만 기본 배치에 넣을 수 있어요. 공용이 아닌 제품을 빼고 다시 등록해 주세요.',
    );
}
const sameRevision = 'EXISTS(SELECT 1 FROM d1_fixture_layouts WHERE id=? AND revision=?)';
/** Writes one row, in one batch: the revision seen is checked with the write. */
async function write(ctx: Context, id: string, revision: number, statement: ReturnType<typeof sql>) {
  await batch(ctx, [
    assertion(ctx, 'conflict', sameRevision, id, revision),
    statement,
    ...mutationStatement(ctx, { value: { id } }),
  ]);
  return { id };
}
export async function manageFixtureLayouts(ctx: Context, body: Record<string, unknown>) {
  if (!ctx.actor.isAdmin)
    throw new D1StorageError(403, '기본 배치는 관리자만 관리할 수 있어요.', 'FORBIDDEN');
  switch (body.operation) {
    case 'list':
      return listManaged(ctx);
    case 'create': {
      const input = createInput.parse(body.input);
      await requirePlaceable(ctx, input.items);
      const count = await sql(ctx, 'SELECT count(*) AS n FROM d1_fixture_layouts').first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_FIXTURE_LAYOUTS)
        throw invalid(`기본 배치는 ${MAX_FIXTURE_LAYOUTS}개까지 등록할 수 있어요.`);
      const id = crypto.randomUUID();
      await batch(ctx, [
        assertion(ctx, 'conflict', '(SELECT count(*) FROM d1_fixture_layouts)<?', MAX_FIXTURE_LAYOUTS),
        sql(
          ctx,
          'INSERT INTO d1_fixture_layouts(id,name,display_order,active,items_json,room_json,created_by) VALUES(?,?,?,?,?,?,?)',
          id,
          input.name,
          input.sortOrder,
          Number(input.active),
          JSON.stringify(input.items),
          JSON.stringify(input.room),
          ctx.actor.id,
        ),
        ...mutationStatement(ctx, { value: { id } }),
      ]);
      return { id };
    }
    case 'save': {
      const input = overwriteInput.parse(body.input);
      await requirePlaceable(ctx, input.items);
      return write(
        ctx,
        input.id,
        input.revision,
        sql(
          ctx,
          'UPDATE d1_fixture_layouts SET items_json=?,room_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
          JSON.stringify(input.items),
          JSON.stringify(input.room),
          stamp(),
          input.id,
          input.revision,
        ),
      );
    }
    case 'update': {
      const input = updateInput.parse(body.input);
      return write(
        ctx,
        input.id,
        input.revision,
        sql(
          ctx,
          'UPDATE d1_fixture_layouts SET name=?,display_order=?,active=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
          input.name,
          input.sortOrder,
          Number(input.active),
          stamp(),
          input.id,
          input.revision,
        ),
      );
    }
    case 'remove': {
      const input = reference.parse(body.input);
      return write(
        ctx,
        input.id,
        input.revision,
        sql(ctx, 'DELETE FROM d1_fixture_layouts WHERE id=? AND revision=?', input.id, input.revision),
      );
    }
    default:
      throw invalid('지원하지 않는 기본 배치 작업이에요.');
  }
}
async function listManaged(ctx: Context): Promise<{ layouts: ManagedLayout[] }> {
  const stored = await readLayouts(ctx.env.DB, false);
  const placements = await placeable(ctx.env, stored);
  return {
    layouts: stored.map((layout) => {
      const products = layout.items.flatMap((item) => placements.get(item.materialId)?.name ?? []);
      return {
        id: layout.id,
        name: layout.name,
        sortOrder: layout.sortOrder,
        active: !!layout.active,
        revision: layout.revision,
        room: layout.room,
        items: layout.items,
        products,
        missing: layout.items.length - products.length,
      };
    }),
  };
}
