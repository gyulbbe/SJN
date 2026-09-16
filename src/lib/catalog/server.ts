import { z } from 'zod';
import { categoryLabels, type MaterialInput } from '@/lib/types';
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

export async function readCatalog(db: D1DatabaseLike, includeInactive = false): Promise<CatalogData> {
  const where = includeInactive ? '' : ' WHERE active=1';
  const [options, subcategories] = await Promise.all([
    db
      .prepare(
        'SELECT id,kind,name,color_hex AS colorHex,sort_order AS sortOrder,active FROM d1_catalog_options' +
          where +
          ' ORDER BY sort_order,normalized_name',
      )
      .all(),
    db
      .prepare(
        'SELECT id,category_code AS category,name,sort_order AS sortOrder,active FROM d1_material_subcategories' +
          where +
          ' ORDER BY sort_order,normalized_name',
      )
      .all(),
  ]);
  return {
    options: options.results.map((row) => ({ ...row, active: !!row.active })),
    subcategories: subcategories.results.map((row) => ({ ...row, active: !!row.active })),
  } as CatalogData;
}
const rowSchema = z.object({
  id: z.string().uuid().optional(),
  kind: z.enum([...optionKinds, 'subcategory']),
  name: z.string().trim().min(1).max(100),
  category: z.string().optional(),
  sortOrder: z.number().int().min(0).max(100000),
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
  if (!['create', 'update'].includes(String(body.operation))) throw invalid('지원하지 않는 분류 작업이에요.');
  const row = rowSchema.parse(body.input);
  const normalized = normalizeCatalogName(row.name);
  if (!normalized) throw invalid('이름을 입력해 주세요.');
  if (row.kind === 'subcategory' && !Object.hasOwn(categoryLabels, row.category ?? ''))
    throw invalid('상위 카테고리를 선택해 주세요.');
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
          `INSERT INTO ${table}(id,${grouping},name,normalized_name,sort_order,active${columns}) VALUES(?,?,?,?,?,?${extra.length ? ',?' : ''})`,
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
          `UPDATE ${table} SET name=?,normalized_name=?,sort_order=?,active=?,updated_at=CURRENT_TIMESTAMP${extra.length ? ',color_hex=?' : ''} WHERE id=?`,
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
  return { selected, catalog };
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
