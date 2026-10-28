import { z } from 'zod';
import { categoryLabels, type MaterialInput, type MaterialKind } from '@/lib/types';
import {
  defaultKindRows,
  isCustomKind,
  isManagedKind,
  newKindCode,
  orderKinds,
  type MaterialKindRow,
} from '@/lib/material-kinds';
import { sql, batch, mutationStatement, assertion, type Context } from '@/lib/d1/database';
import { D1StorageError, invalid } from '@/lib/d1/http';
import type { D1DatabaseLike } from '@/lib/d1/types';
import {
  emptySelection,
  normalizeCatalogName,
  optionKinds,
  type CatalogData,
  type OptionKind,
} from './contract';

/**
 * The 위생도기 kinds (migration 0012), hidden ones too, in their order (기타 last). A small table read
 * whole. Before 0012 is applied the built-in kinds stand in, as they were.
 */
export async function readKinds(db: D1DatabaseLike): Promise<MaterialKindRow[]> {
  try {
    const rows = await db
      .prepare('SELECT code,name,display_order AS displayOrder,active,builtin FROM d1_material_kinds')
      .all<Omit<MaterialKindRow, 'active' | 'builtin'> & { active: number; builtin: number }>();
    return orderKinds(rows.results.map((row) => ({ ...row, active: !!row.active, builtin: !!row.builtin })));
  } catch (error) {
    if (/no such table/i.test(error instanceof Error ? error.message : String(error)))
      return defaultKindRows();
    throw error;
  }
}
/** 표시 순서 first (0 first), then the ones without one; by name within (migration 0011). */
const displayOrder = ' ORDER BY display_order IS NULL,display_order,normalized_name';
export async function readCatalog(db: D1DatabaseLike, includeInactive = false): Promise<CatalogData> {
  const where = includeInactive ? '' : ' WHERE active=1';
  const [options, subcategories, kinds] = await Promise.all([
    db
      .prepare(
        'SELECT id,kind,name,color_hex AS colorHex,display_order AS sortOrder,active FROM d1_catalog_options' +
          where +
          displayOrder,
      )
      .all(),
    db
      .prepare(
        'SELECT id,category_code AS category,name,display_order AS sortOrder,active FROM d1_material_subcategories' +
          where +
          displayOrder,
      )
      .all(),
    readKinds(db),
  ]);
  return {
    options: options.results.map((row) => ({ ...row, active: !!row.active })),
    subcategories: subcategories.results.map((row) => ({ ...row, active: !!row.active })),
    kinds,
  } as CatalogData;
}
const rowSchema = z.object({
  id: z.string().uuid().optional(),
  kind: z.enum([...optionKinds, 'subcategory', 'materialKind']),
  /** A 위생도기 kind's code (its id). */
  code: z.string().max(40).optional(),
  name: z.string().trim().min(1).max(100),
  category: z.string().optional(),
  /** 표시 순서: a whole number 0–9999, or null for none. */
  sortOrder: z.number().int().min(0).max(9999).nullable(),
  active: z.boolean(),
  colorHex: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullable()
    .optional(),
});
export async function manageCatalog(ctx: Context, body: Record<string, unknown>) {
  if (!ctx.actor.isAdmin) throw new D1StorageError(403, '분류 관리는 관리자만 할 수 있어요.', 'FORBIDDEN');
  if (body.operation === 'list') return readCatalog(ctx.env.DB, true);
  if (body.operation === 'delete') return deleteKind(ctx, body.input);
  if (!['create', 'update'].includes(String(body.operation))) throw invalid('지원하지 않는 분류 작업이에요.');
  const row = rowSchema.parse(body.input);
  const normalized = normalizeCatalogName(row.name);
  if (!normalized) throw invalid('이름을 입력해 주세요.');
  if (row.kind === 'materialKind') return saveKind(ctx, body.operation === 'create', row, normalized);
  if (row.kind === 'subcategory' && !Object.hasOwn(categoryLabels, row.category ?? ''))
    throw invalid('상위 카테고리를 선택해 주세요.');
  // The subcategory table's kinds are fixed by migration 0003 (its CHECK has no 기타).
  if (row.kind === 'subcategory' && row.category === 'other')
    throw invalid('기타에는 하위 카테고리를 둘 수 없어요.');
  if (row.kind !== 'color' && row.colorHex) throw invalid('색상에서만 HEX 값을 지정할 수 있어요.');
  const table = row.kind === 'subcategory' ? 'd1_material_subcategories' : 'd1_catalog_options';
  const grouping = row.kind === 'subcategory' ? 'category_code' : 'kind';
  const group = row.kind === 'subcategory' ? row.category! : row.kind;
  const id = body.operation === 'create' ? crypto.randomUUID() : z.string().uuid().parse(row.id);
  if (body.operation === 'update') {
    const current = await sql(ctx, `SELECT ${grouping} AS parent FROM ${table} WHERE id=?`, id).first<{
      parent: string;
    }>();
    if (!current) throw new D1StorageError(404, '분류를 찾지 못했어요.');
    if (current.parent !== group) throw invalid('기존 분류의 종류나 상위 카테고리는 변경할 수 없어요.');
  }
  if (
    await sql(
      ctx,
      `SELECT id FROM ${table} WHERE ${grouping}=? AND normalized_name=? AND id<>?`,
      group,
      normalized,
      id,
    ).first()
  )
    throw new D1StorageError(409, '같은 이름의 항목이 이미 있어요.');
  const columns = row.kind === 'subcategory' ? '' : ',color_hex';
  const extra = row.kind === 'subcategory' ? [] : [row.colorHex ?? null];
  const statement =
    body.operation === 'create'
      ? sql(
          ctx,
          `INSERT INTO ${table}(id,${grouping},name,normalized_name,display_order,active${columns}) VALUES(?,?,?,?,?,?${extra.length ? ',?' : ''})`,
          id,
          group,
          row.name,
          normalized,
          row.sortOrder,
          Number(row.active),
          ...extra,
        )
      : sql(
          ctx,
          // A brand's new order reaches its materials' list rows (0011 trigger d1_material_list_brand_order).
          `UPDATE ${table} SET name=?,normalized_name=?,display_order=?,active=?,updated_at=CURRENT_TIMESTAMP${extra.length ? ',color_hex=?' : ''} WHERE id=?`,
          row.name,
          normalized,
          row.sortOrder,
          Number(row.active),
          ...extra,
          id,
        );
  await batch(ctx, [statement, ...mutationStatement(ctx, { value: { id } })]);
  return { id };
}
/**
 * 위생도기 kinds (migration 0012): a new kind (name, order, use), or a kind's order and use. A built-in
 * kind's name is fixed; 기타 has no order (always last). A name may not be another kind's.
 */
async function saveKind(ctx: Context, create: boolean, row: z.infer<typeof rowSchema>, normalized: string) {
  const code = create ? newKindCode() : z.string().min(1).parse(row.code);
  if (!create) {
    const current = await sql(ctx, 'SELECT name,builtin FROM d1_material_kinds WHERE code=?', code).first<{
      name: string;
      builtin: number;
    }>();
    if (!current) throw new D1StorageError(404, '종류를 찾지 못했어요.');
    if (current.builtin && row.name.trim() !== current.name)
      throw invalid('기본 종류의 이름은 바꿀 수 없어요. 표시 순서와 사용만 바꿀 수 있어요.');
  }
  // Another kind's name, or a stored kind no one picks (타일·문·창·샤워 커튼), is taken.
  const reserved = Object.values(categoryLabels).some((name) => normalizeCatalogName(name) === normalized);
  if (
    (create && reserved) ||
    (await sql(
      ctx,
      'SELECT code FROM d1_material_kinds WHERE normalized_name=? AND code<>?',
      normalized,
      code,
    ).first())
  )
    throw new D1StorageError(409, '같은 이름의 종류가 이미 있어요.');
  const order = code === 'other' ? null : row.sortOrder;
  const statement = create
    ? sql(
        ctx,
        'INSERT INTO d1_material_kinds(code,name,normalized_name,display_order,active,builtin) VALUES(?,?,?,?,?,0)',
        code,
        row.name.trim(),
        normalized,
        order,
        Number(row.active),
      )
    : sql(
        ctx,
        'UPDATE d1_material_kinds SET name=CASE WHEN builtin=1 THEN name ELSE ? END,normalized_name=CASE WHEN builtin=1 THEN normalized_name ELSE ? END,display_order=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE code=?',
        row.name.trim(),
        normalized,
        order,
        Number(row.active),
        code,
      );
  await batch(ctx, [statement, ...mutationStatement(ctx, { value: { id: code } })]);
  return { id: code };
}
/** Deletes an added kind no material (any version, active or not) has; a built-in one is only hidden. */
async function deleteKind(ctx: Context, input: unknown) {
  const code = z.object({ code: z.string().max(40) }).parse(input).code;
  if (!isCustomKind(code)) throw invalid('기본 종류는 지울 수 없어요. 사용을 끄면 목록에서 숨겨져요.');
  // Any version of any material (0012's partial index holds only added kinds' versions).
  const used = "SELECT 1 FROM d1_material_versions WHERE substr(category,1,2)='k-' AND category=? LIMIT 1";
  if (await sql(ctx, used, code).first())
    throw new D1StorageError(409, '이 종류의 자재가 있어 지울 수 없어요. 사용을 끄면 목록에서 숨겨져요.');
  await batch(ctx, [
    // A material saved with it in the meantime keeps the kind.
    assertion(ctx, 'conflict', `NOT EXISTS(${used})`, code),
    sql(ctx, 'DELETE FROM d1_material_kinds WHERE code=? AND builtin=0', code),
    ...mutationStatement(ctx, { value: { id: code } }),
  ]);
  return { id: code };
}
/**
 * A material's kind (migration 0012): a managed kind must be in use, unless the material already had
 * it (a hidden kind's material can still be edited). Tiles and the kinds no one picks (문·창·샤워 커튼,
 * the photo-analysis standard model's) pass as before.
 */
export function checkMaterialKind(kinds: MaterialKindRow[], kind: MaterialKind, previous?: string) {
  if (!isManagedKind(kind) || kind === previous) return;
  if (!kinds.some((row) => row.code === kind && row.active))
    throw invalid('사용하지 않는 종류예요. 분류 관리에서 사용 중인 종류를 골라 주세요.');
}
export async function resolveCatalogInput(ctx: Context, input: MaterialInput) {
  const catalog = input.catalog ?? emptySelection();
  if (
    !input.catalog &&
    [input.brand, input.color, input.finish, input.composition, input.subcategoryName].some(Boolean)
  )
    throw invalid('색상·브랜드·재질·마감은 등록된 목록에서 선택해 주세요.');
  const data = await readCatalog(ctx.env.DB);
  const selected: { id: string; kind: OptionKind }[] = [];
  function names(kind: OptionKind, ids: string[]) {
    if (new Set(ids).size !== ids.length) throw invalid('중복된 선택 항목이에요.');
    return ids
      .map((id) => {
        const row = data.options.find((item) => item.id === id && item.kind === kind);
        if (!row) throw invalid('삭제되거나 비활성화된 항목을 다시 선택해 주세요.');
        selected.push({ id, kind });
        return row.name;
      })
      .join(' · ');
  }
  input.brand = names('brand', catalog.brandId ? [catalog.brandId] : []);
  input.color = names('color', catalog.colorIds);
  input.composition = names('composition', catalog.compositionIds);
  input.finish = names('finish', catalog.finishIds);
  input.subcategoryName = '';
  if (catalog.subcategoryId) {
    const sub = data.subcategories.find(
      (item) => item.id === catalog.subcategoryId && item.category === input.category,
    );
    if (!sub) throw invalid('이 제품 종류에 사용할 수 없는 하위 카테고리예요.');
    input.subcategoryName = sub.name;
  }
  input.catalog = catalog;
  return { selected, catalog, kinds: data.kinds ?? defaultKindRows() };
}
export function catalogStatements(
  ctx: Context,
  versionId: string,
  selection: Awaited<ReturnType<typeof resolveCatalogInput>>,
) {
  const selected = JSON.stringify(selection.selected);
  return [
    // Bound query count regardless of the number of selected attributes (Workers Free).
    assertion(
      ctx,
      'reference',
      `NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(
      SELECT 1 FROM d1_catalog_options o WHERE o.id=json_extract(j.value,'$.id') AND o.kind=json_extract(j.value,'$.kind') AND o.active=1))`,
      selected,
    ),
    sql(
      ctx,
      `INSERT INTO d1_material_version_options(version_id,option_id,option_kind)
      SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.kind') FROM json_each(?)`,
      versionId,
      selected,
    ),
    ...(selection.catalog.subcategoryId
      ? [
          assertion(
            ctx,
            'reference',
            'EXISTS(SELECT 1 FROM d1_material_subcategories WHERE id=? AND active=1)',
            selection.catalog.subcategoryId,
          ),
        ]
      : []),
  ];
}
