import type { MaterialPricing, QuoteDocument, QuoteLine } from './quote-types';
import type { MaterialVersion, Scene, Surface } from './types';
import type {
  LatestUsagePricing,
  MaterialUsageResult,
  MaterialUsageRow,
  MaterialUsageState,
  UsageArea,
  UsageAssignment,
  UsagePriceSnapshot,
  UsageUnit,
} from './material-usage-types';

export type { MaterialUsageState, UsagePriceSnapshot } from './material-usage-types';
export const USAGE_UNIT_LABELS: Record<UsageUnit, string> = { m2: '㎡', box: '박스', piece: '장' };
export const MAX_USAGE_QUANTITY = 100_000;
export const MAX_USAGE_UNIT_PRICE = 100_000_000;
export const PACKAGING_AREA_TOLERANCE = 0.000001;

export function validUsageNumber(value: unknown, maximum = MAX_USAGE_QUANTITY, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}
export function validUsagePrice(value: unknown): value is number {
  return validUsageNumber(value, MAX_USAGE_UNIT_PRICE) && Number.isInteger(value);
}
function positive(value: unknown): value is number {
  return validUsageNumber(value, MAX_USAGE_QUANTITY, Number.MIN_VALUE);
}
function pieces(value: unknown): value is number {
  return positive(value) && Number.isInteger(value);
}
export function usageCeil(value: number): number {
  return Math.ceil(value - Number.EPSILON * Math.abs(value) * 8);
}
export function packagingCoverage(
  widthMm: number,
  heightMm: number,
  pricing: Pick<MaterialPricing, 'boxCoverageM2' | 'piecesPerBox'>,
): {
  coverageM2: number | null;
  calculatedCoverageM2: number | null;
  registeredCoverageM2: number | null;
  mismatch: boolean;
} {
  const tileArea = positive(widthMm) && positive(heightMm) ? (widthMm * heightMm) / 1_000_000 : null;
  const calculated =
    tileArea !== null && pieces(pricing.piecesPerBox) ? tileArea * pricing.piecesPerBox : null;
  const registered = positive(pricing.boxCoverageM2) ? pricing.boxCoverageM2 : null;
  return {
    // An invalid explicitly entered value does not silently become another amount.
    coverageM2: pricing.boxCoverageM2 !== null ? registered : calculated,
    calculatedCoverageM2: calculated,
    registeredCoverageM2: registered,
    mismatch:
      registered !== null &&
      calculated !== null &&
      Math.abs(registered - calculated) > PACKAGING_AREA_TOLERANCE,
  };
}
export function emptyMaterialUsage(): MaterialUsageState {
  return { version: 1, assignments: {}, areas: {}, quantities: {}, aggregateAreas: [] };
}
function priceSnapshot(
  versionId: string,
  category: 'tile' | 'fixture',
  material?: MaterialVersion,
): UsagePriceSnapshot {
  const pricing = material?.pricing;
  const supported =
    category === 'fixture' ? !pricing || pricing.unit === 'piece' : !pricing || pricing.unit !== 'set';
  return {
    sourceVersionId: versionId,
    unit:
      category === 'fixture'
        ? 'piece'
        : pricing?.unit === 'box' || pricing?.unit === 'piece'
          ? pricing.unit
          : 'm2',
    unitPrice: supported && validUsagePrice(pricing?.unitPrice) ? pricing!.unitPrice : null,
    boxCoverageM2: category === 'tile' && positive(pricing?.boxCoverageM2) ? pricing!.boxCoverageM2 : null,
    piecesPerBox: category === 'tile' && pieces(pricing?.piecesPerBox) ? pricing!.piecesPerBox : null,
    ...(!supported ? { requiresUnitReview: true } : {}),
  };
}
function usageKey(category: 'tile' | 'fixture', ids: string[]): string {
  return JSON.stringify([category, [...ids].sort()]);
}
function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, i) => value === [...right].sort()[i]);
}
function sourceEntities(
  scene: Scene,
): { id: string; category: 'tile' | 'fixture'; materialVersionId: string }[] {
  return [
    ...scene.surfaces
      .filter((s) => s.materialVersionId)
      .map((s) => ({ id: s.id, category: 'tile' as const, materialVersionId: s.materialVersionId! })),
    ...scene.fixtures.map((f) => ({
      id: f.id,
      category: 'fixture' as const,
      materialVersionId: f.materialVersionId,
    })),
  ];
}
function matchingLegacyIds(line: QuoteLine, quote: QuoteDocument, scene: Scene): string[] | null {
  if (!line.materialVersionId || line.sourceKey !== `${line.category}:${line.materialVersionId}`) return null;
  if (line.category === 'tile') {
    const ids = line.sourceSurfaceIds;
    if (!ids?.length || new Set(ids).size !== ids.length) return null;
    if (
      !ids.every((id) =>
        scene.surfaces.some((s) => s.id === id && s.materialVersionId === line.materialVersionId),
      )
    )
      return null;
    return ids;
  }
  if (line.category !== 'fixture') return null;
  try {
    const signature: unknown = JSON.parse(quote.sourceSignature);
    if (
      !signature ||
      typeof signature !== 'object' ||
      !('fixtures' in signature) ||
      !Array.isArray(signature.fixtures)
    )
      return null;
    const entries = signature.fixtures;
    if (
      !entries.every(
        (e) => Array.isArray(e) && e.length === 2 && e.every((v: unknown) => typeof v === 'string'),
      )
    )
      return null;
    const oldIds = entries.filter((e) => e[1] === line.materialVersionId).map((e) => e[0] as string);
    const actual = scene.fixtures
      .filter((f) => f.materialVersionId === line.materialVersionId)
      .map((f) => f.id);
    return actual.length && sameIds(actual, oldIds) ? actual : null;
  } catch {
    return null;
  }
}
function migrateLegacy(state: MaterialUsageState, quote: QuoteDocument, scene: Scene): void {
  const candidates = quote.lines
    .map((line) => ({ line, ids: matchingLegacyIds(line, quote, scene) }))
    .filter((entry): entry is { line: QuoteLine; ids: string[] } => Boolean(entry.ids));
  const occurrences = new Map<string, number>();
  for (const c of candidates) for (const id of c.ids) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
  for (const { line, ids } of candidates) {
    if (ids.some((id) => occurrences.get(id) !== 1)) continue;
    const assignments = ids.map((id) => state.assignments[id]);
    if (assignments.some((a) => !a || a.pricing.requiresUnitReview || a.pricing.unit !== line.unit)) continue;
    // The old line must cover the actual immutable version and the same selling unit.
    for (const assignment of assignments) {
      if (validUsagePrice(line.unitPrice)) assignment.pricing.unitPrice = line.unitPrice;
      if (line.category === 'tile') {
        if (positive(line.boxCoverageM2)) assignment.pricing.boxCoverageM2 = line.boxCoverageM2;
        if (pieces(line.piecesPerBox)) assignment.pricing.piecesPerBox = line.piecesPerBox;
      }
    }
    if (line.category !== 'tile') continue;
    if (line.areaSource !== 'room' && validUsageNumber(line.areaM2)) {
      if (ids.length === 1) state.areas[ids[0]] = { mode: 'manual', areaM2: line.areaM2 };
      else
        state.aggregateAreas.push({
          materialVersionId: line.materialVersionId!,
          surfaceIds: [...ids],
          areaM2: line.areaM2,
        });
    }
    if (
      line.quantityMode === 'manual' &&
      validUsageNumber(line.quantity) &&
      (line.unit === 'm2' || Number.isInteger(line.quantity))
    )
      state.quantities[usageKey('tile', ids)] = { mode: 'manual', quantity: line.quantity };
  }
  state.migratedQuoteId = quote.id;
}
/** Pure, read-time migration. Callers decide when a normal optimistic save persists it. */
export function ensureMaterialUsage(
  scene: Scene,
  materials: Record<string, MaterialVersion>,
  existing?: MaterialUsageState,
  legacyQuote?: QuoteDocument,
): MaterialUsageState {
  const state = existing ? structuredClone(existing) : emptyMaterialUsage();
  const entities = sourceEntities(scene);
  const live = new Set(entities.map((e) => e.id));
  for (const id of Object.keys(state.assignments)) if (!live.has(id)) delete state.assignments[id];
  for (const id of Object.keys(state.areas))
    if (!scene.surfaces.some((s) => s.id === id)) delete state.areas[id];
  for (const entity of entities) {
    const old = state.assignments[entity.id];
    if (old && old.materialVersionId === entity.materialVersionId && old.category === entity.category)
      continue;
    // A material still being fetched must not leave a permanent, empty price snapshot.
    if (!materials[entity.materialVersionId]) {
      delete state.assignments[entity.id];
      continue;
    }
    state.assignments[entity.id] = {
      category: entity.category,
      materialVersionId: entity.materialVersionId,
      pricing: priceSnapshot(entity.materialVersionId, entity.category, materials[entity.materialVersionId]),
    };
    if (old && old.materialVersionId !== entity.materialVersionId) {
      // Manual ordering belongs to a particular applied material, not just the face ID.
      for (const key of Object.keys(state.quantities)) {
        try {
          if ((JSON.parse(key)[1] as string[]).includes(entity.id)) delete state.quantities[key];
        } catch {
          delete state.quantities[key];
        }
      }
    }
  }
  // Removing a material retires its order. Keep only a review marker on surviving members;
  // otherwise applying a new product to the same face later could inherit the previous order.
  for (const [key] of Object.entries(state.quantities)) {
    const ids = quantityIds(key);
    const remaining = ids.filter((id) => state.assignments[id]?.category === 'tile');
    if (remaining.length !== ids.length) {
      delete state.quantities[key];
      if (remaining.length)
        state.quantities[usageKey('tile', remaining)] = { mode: 'manual', quantity: null };
    }
  }
  if (legacyQuote && !state.migratedQuoteId && entities.every((e) => state.assignments[e.id]))
    migrateLegacy(state, legacyQuote, scene);
  return existing && JSON.stringify(existing) === JSON.stringify(state) ? existing : state;
}

function roomAreas(scene: Scene): Map<string, { areaM2: number | null; issue?: string }> {
  const result = new Map<string, { areaM2: number | null; issue?: string }>();
  const applicable = scene.surfaces.filter((s) => s.materialVersionId);
  for (const s of applicable) result.set(s.id, { areaM2: null, issue: '순시공 면적을 직접 입력해 주세요.' });
  const room = scene.room;
  if (
    !room ||
    !validUsageNumber(room.widthMm, 20_000, 500) ||
    !validUsageNumber(room.depthMm, 20_000, 500) ||
    !validUsageNumber(room.heightMm, 6_000, 1000)
  )
    return result;
  for (const face of ['floor', 'back', 'left', 'right'] as const) {
    const surfaces = applicable.filter((s) => s.roomFace === face);
    if (!surfaces.length) continue;
    const invalid = surfaces.some(
      (s) =>
        s.geometryMode !== 'room' ||
        (s.reconstructionBand &&
          (face === 'floor' ||
            !validUsageNumber(s.reconstructionBand.from, 1) ||
            !validUsageNumber(s.reconstructionBand.to, 1) ||
            s.reconstructionBand.to <= s.reconstructionBand.from)),
    );
    const full = surfaces.filter(
      (s) => !s.reconstructionBand || (s.reconstructionBand.from === 0 && s.reconstructionBand.to === 1),
    );
    const bands = surfaces.filter((s) => s.reconstructionBand && !full.includes(s));
    const overlap = bands.some((s, i) =>
      bands
        .slice(i + 1)
        .some(
          (t) =>
            Math.min(s.reconstructionBand!.to, t.reconstructionBand!.to) -
              Math.max(s.reconstructionBand!.from, t.reconstructionBand!.from) >
            1e-9,
        ),
    );
    if (invalid || full.length > 1 || overlap) {
      for (const s of surfaces)
        result.set(s.id, {
          areaM2: null,
          issue: '영역 범위가 불명확하거나 겹칩니다. 순시공 면적을 확인해 주세요.',
        });
      continue;
    }
    const faceArea = (room.heightMm * (face === 'back' ? room.widthMm : room.depthMm)) / 1_000_000;
    const total = face === 'floor' ? (room.widthMm * room.depthMm) / 1_000_000 : faceArea;
    let used = 0;
    for (const s of bands) {
      const fraction = s.reconstructionBand!.to - s.reconstructionBand!.from;
      result.set(s.id, { areaM2: total * fraction });
      used += fraction;
    }
    for (const s of full) result.set(s.id, { areaM2: total * Math.max(0, 1 - used) });
  }
  return result;
}
function groupTerms(assignment: UsageAssignment, material?: MaterialVersion): string {
  const p = assignment.pricing;
  return JSON.stringify([
    assignment.category,
    assignment.materialVersionId,
    material?.widthMm,
    material?.heightMm,
    material?.depthMm,
    p.unit,
    p.unitPrice,
    p.boxCoverageM2,
    p.piecesPerBox,
    p.requiresUnitReview ?? false,
  ]);
}
function autoQuantity(
  area: number | null,
  pricing: UsagePriceSnapshot,
  material?: MaterialVersion,
): number | null {
  if (!validUsageNumber(area)) return null;
  if (pricing.unit === 'm2') return area;
  const coverage =
    pricing.unit === 'box'
      ? packagingCoverage(material?.widthMm ?? 0, material?.heightMm ?? 0, pricing).coverageM2
      : positive(material?.widthMm) && positive(material?.heightMm)
        ? (material!.widthMm * material!.heightMm) / 1_000_000
        : null;
  if (!positive(coverage)) return null;
  const quantity = usageCeil(area / coverage);
  return validUsageNumber(quantity) ? quantity : null;
}
function quantityIds(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) &&
      parsed[0] === 'tile' &&
      Array.isArray(parsed[1]) &&
      parsed[1].every((id) => typeof id === 'string')
      ? parsed[1]
      : [];
  } catch {
    return [];
  }
}
function clearLinkedQuantities(state: MaterialUsageState, ids: string[]): void {
  for (const key of Object.keys(state.quantities))
    if (quantityIds(key).some((id) => ids.includes(id))) delete state.quantities[key];
}
/** Existing ordering remains meaningful when commercial rows merge; it is never arbitrarily split. */
function manualQuantityForGroup(
  state: MaterialUsageState,
  ids: string[],
  areas: UsageArea[],
  pricing: UsagePriceSnapshot,
  material: MaterialVersion | undefined,
): { manual: boolean; quantity: number | null; issue?: string } {
  const entries = Object.entries(state.quantities)
    .map(([key, value]) => ({ ids: quantityIds(key), value }))
    .filter((entry) => entry.ids.some((id) => ids.includes(id)));
  if (!entries.length) return { manual: false, quantity: null };
  const covered = new Set<string>();
  let quantity = 0;
  for (const entry of entries) {
    if (entry.ids.some((id) => !ids.includes(id) || covered.has(id)))
      return {
        manual: true,
        quantity: null,
        issue: '기존 수동 구매 수량의 자재 구성이 바뀌었습니다. 수량을 다시 확인해 주세요.',
      };
    if (
      !validUsageNumber(entry.value.quantity) ||
      (pricing.unit !== 'm2' && !Number.isInteger(entry.value.quantity))
    )
      return { manual: true, quantity: null };
    quantity += entry.value.quantity;
    entry.ids.forEach((id) => covered.add(id));
  }
  const remaining = areas.filter((area) => !covered.has(area.surfaceId));
  if (remaining.length) {
    const extraArea = remaining.every((area) => area.areaM2 !== null)
      ? remaining.reduce((sum, area) => sum + area.areaM2!, 0)
      : null;
    const extraQuantity = autoQuantity(extraArea, pricing, material);
    if (extraQuantity === null)
      return {
        manual: true,
        quantity: null,
        issue: '추가된 면의 자동 수량을 확인해 주세요. 기존 수동 수량은 보존했습니다.',
      };
    quantity += extraQuantity;
  }
  return { manual: true, quantity: validUsageNumber(quantity) ? quantity : null };
}
function areaForSurface(
  surface: Surface,
  state: MaterialUsageState,
  rooms: ReturnType<typeof roomAreas>,
): UsageArea {
  const room = rooms.get(surface.id);
  const override = state.areas[surface.id];
  return {
    surfaceId: surface.id,
    name: surface.name,
    roomAreaM2: room?.areaM2 ?? null,
    areaM2: override ? (validUsageNumber(override.areaM2) ? override.areaM2 : null) : (room?.areaM2 ?? null),
    source: override ? 'manual' : room?.areaM2 !== null && room?.areaM2 !== undefined ? 'room' : 'unknown',
    ...(!override && room?.issue ? { issue: room.issue } : {}),
  };
}
/** Prices, quantities and totals come only from the current After placements and their snapshots. */
export function calculateMaterialUsage(
  scene: Scene,
  materials: Record<string, MaterialVersion>,
  existing?: MaterialUsageState,
  legacyQuote?: QuoteDocument,
): MaterialUsageResult {
  const state = ensureMaterialUsage(scene, materials, existing, legacyQuote);
  const groups = new Map<string, { assignment: UsageAssignment; entityIds: string[] }>();
  for (const entity of sourceEntities(scene)) {
    const assignment = state.assignments[entity.id] ?? {
      category: entity.category,
      materialVersionId: entity.materialVersionId,
      pricing: priceSnapshot(entity.materialVersionId, entity.category, materials[entity.materialVersionId]),
    };
    const terms = groupTerms(assignment, materials[entity.materialVersionId]);
    const group = groups.get(terms);
    if (group) group.entityIds.push(entity.id);
    else groups.set(terms, { assignment, entityIds: [entity.id] });
  }
  const rooms = roomAreas(scene);
  const rows: MaterialUsageRow[] = [];
  for (const { assignment, entityIds } of groups.values()) {
    const { category, materialVersionId } = assignment;
    const pricing = structuredClone(assignment.pricing);
    const material = materials[materialVersionId];
    const surfaceIds = category === 'tile' ? entityIds : [];
    const fixtureIds = category === 'fixture' ? entityIds : [];
    const surfaces = surfaceIds.map((id) => scene.surfaces.find((s) => s.id === id)!);
    const areas = surfaces.map((s) => areaForSurface(s, state, rooms));
    const issues: string[] = [];
    let areaM2 =
      category === 'tile' && areas.every((a) => a.areaM2 !== null)
        ? areas.reduce((sum, a) => sum + a.areaM2!, 0)
        : null;
    let areaNeedsReview = false;
    if (category === 'tile') {
      const aggregates = state.aggregateAreas.filter(
        (a) =>
          a.materialVersionId === materialVersionId && a.surfaceIds.some((id) => surfaceIds.includes(id)),
      );
      for (const aggregate of aggregates) {
        // Explicit per-surface values (or resets) supersede the legacy total as a whole.
        if (aggregate.surfaceIds.every((id) => state.areas[id])) continue;
        if (sameIds(aggregate.surfaceIds, surfaceIds) && validUsageNumber(aggregate.areaM2)) {
          areaM2 = aggregate.areaM2;
          for (const a of areas) {
            a.areaM2 = null;
            a.source = 'legacy-total';
            delete a.issue;
          }
        } else {
          areaM2 = null;
          areaNeedsReview = true;
          issues.push('기존 합계 면적의 연결 면이 바뀌었습니다. 면별 순시공 면적을 다시 확인해 주세요.');
        }
      }
      if (areaM2 === null) {
        areaNeedsReview = true;
        issues.push('면적 확인 필요');
        for (const a of areas) if (a.issue) issues.push(a.issue);
      }
    }
    const tileArea =
      material && positive(material.widthMm) && positive(material.heightMm)
        ? (material.widthMm * material.heightMm) / 1_000_000
        : null;
    const packagingMissing =
      category === 'tile' &&
      (pricing.unit === 'box'
        ? !positive(packagingCoverage(material?.widthMm ?? 0, material?.heightMm ?? 0, pricing).coverageM2)
        : pricing.unit === 'piece'
          ? !positive(tileArea)
          : false);
    if (packagingMissing) issues.push('포장·규격 확인 필요');
    if (pricing.requiresUnitReview) issues.push('기존 판매 단위를 개당 단가로 확인해 주세요.');
    if (!material) issues.push('상품 버전 정보 확인 필요');
    const key = usageKey(category, entityIds);
    const automaticQuantity =
      category === 'fixture' ? entityIds.length : autoQuantity(areaM2, pricing, material);
    const manual =
      category === 'tile'
        ? manualQuantityForGroup(state, surfaceIds, areas, pricing, material)
        : { manual: false, quantity: null };
    if (manual.issue) issues.push(manual.issue);
    const quantity = manual.manual ? manual.quantity : automaticQuantity;
    const amount =
      quantity !== null && validUsagePrice(pricing.unitPrice) && !pricing.requiresUnitReview
        ? Math.round(quantity * pricing.unitPrice)
        : null;
    if (quantity === null) issues.push('구매 수량 확인 필요');
    if (!validUsagePrice(pricing.unitPrice)) issues.push('단가 입력 필요');
    const safeAmount = amount !== null && Number.isSafeInteger(amount) ? amount : null;
    if (amount !== null && safeAmount === null) issues.push('금액이 계산 가능한 범위를 초과했습니다.');
    rows.push({
      key,
      category,
      materialVersionId,
      material,
      entityIds: [...entityIds],
      surfaceIds: [...surfaceIds],
      fixtureIds: [...fixtureIds],
      locations:
        category === 'tile'
          ? surfaces.map((s) => s.name)
          : fixtureIds.map((id) => scene.fixtures.find((f) => f.id === id)!.name),
      pricing,
      areas,
      areaM2,
      count: fixtureIds.length,
      automaticQuantity,
      quantity,
      quantityMode: manual.manual ? 'manual' : 'auto',
      amount: safeAmount,
      issues: [...new Set(issues)],
      needsAttention: areaNeedsReview || packagingMissing || Boolean(pricing.requiresUnitReview) || !material,
    });
  }
  const total = rows.reduce((sum, row) => sum + (row.amount ?? 0), 0);
  const unresolvedCount = rows.filter((r) => r.amount === null).length;
  const attentionCount = rows.filter((r) => r.needsAttention).length;
  return {
    rows,
    total: Number.isSafeInteger(total) ? total : 0,
    unresolvedCount,
    attentionCount,
    complete: unresolvedCount === 0 && attentionCount === 0 && Number.isSafeInteger(total),
    state,
  };
}

export function setUsageArea(
  state: MaterialUsageState,
  surfaceId: string,
  value: number | null | 'room',
): MaterialUsageState {
  if (value !== null && value !== 'room' && !validUsageNumber(value))
    throw new Error('면적은 0 이상 100,000 이하의 숫자로 입력해 주세요.');
  const next = structuredClone(state);
  if (value === 'room') delete next.areas[surfaceId];
  else next.areas[surfaceId] = { mode: 'manual', areaM2: value };
  // Retiring a manual total cannot silently allocate its remaining area. Each other member needs review or an explicit room reset.
  for (const aggregate of next.aggregateAreas.filter((a) => a.surfaceIds.includes(surfaceId))) {
    for (const id of aggregate.surfaceIds)
      if (id !== surfaceId && !next.areas[id]) next.areas[id] = { mode: 'manual', areaM2: null };
  }
  next.aggregateAreas = next.aggregateAreas.filter((a) => !a.surfaceIds.includes(surfaceId));
  return next;
}
export function setUsageQuantity(
  state: MaterialUsageState,
  row: MaterialUsageRow,
  value: number | null | 'auto',
): MaterialUsageState {
  if (row.category !== 'tile') throw new Error('제품 개수는 실제 배치에서 계산합니다.');
  if (
    value !== null &&
    value !== 'auto' &&
    (!validUsageNumber(value) || (row.pricing.unit !== 'm2' && !Number.isInteger(value)))
  )
    throw new Error('구매 수량을 올바르게 입력해 주세요. 박스와 장은 정수만 사용할 수 있습니다.');
  const next = structuredClone(state);
  clearLinkedQuantities(next, row.entityIds);
  if (value !== 'auto') next.quantities[row.key] = { mode: 'manual', quantity: value };
  return next;
}
function validatePrice(pricing: UsagePriceSnapshot, category: 'tile' | 'fixture'): void {
  if (!['m2', 'box', 'piece'].includes(pricing.unit) || (category === 'fixture' && pricing.unit !== 'piece'))
    throw new Error('제품은 개, 타일은 박스·장·㎡ 단위만 사용할 수 있습니다.');
  if (pricing.unitPrice !== null && !validUsagePrice(pricing.unitPrice))
    throw new Error('단가는 0 이상 100,000,000 이하의 정수로 입력해 주세요.');
  if (pricing.boxCoverageM2 !== null && !positive(pricing.boxCoverageM2))
    throw new Error('박스당 면적은 0보다 큰 숫자로 입력해 주세요.');
  if (pricing.piecesPerBox !== null && !pieces(pricing.piecesPerBox))
    throw new Error('박스당 장수는 양의 정수로 입력해 주세요.');
}
export function setUsagePricing(
  state: MaterialUsageState,
  row: MaterialUsageRow,
  patch: Partial<UsagePriceSnapshot>,
): MaterialUsageState {
  const next = structuredClone(state);
  const pricing = { ...row.pricing, ...patch };
  if (Object.hasOwn(patch, 'unitPrice') && validUsagePrice(patch.unitPrice))
    delete pricing.requiresUnitReview;
  validatePrice(pricing, row.category);
  for (const id of row.entityIds) {
    const assignment = next.assignments[id];
    if (assignment?.materialVersionId === row.materialVersionId)
      assignment.pricing = structuredClone(pricing);
  }
  if (pricing.unit !== row.pricing.unit) clearLinkedQuantities(next, row.entityIds);
  return next;
}
export function describeLatestUsagePricing(
  row: MaterialUsageRow,
  latest: MaterialVersion,
): LatestUsagePricing {
  const current = row.material;
  const next = priceSnapshot(latest.id, row.category, latest);
  const compatible = Boolean(
    current &&
    current.materialId === latest.materialId &&
    current.category === latest.category &&
    current.widthMm === latest.widthMm &&
    current.heightMm === latest.heightMm &&
    current.depthMm === latest.depthMm &&
    current.code === latest.code,
  );
  return {
    compatible,
    ...(!compatible ? { reason: '상품 규격 또는 모델이 달라졌습니다. 자재를 다시 선택해 주세요.' } : {}),
    changed: JSON.stringify(row.pricing) !== JSON.stringify(next),
    unitChanged: row.pricing.unit !== next.unit,
    previous: structuredClone(row.pricing),
    next,
  };
}
export function applyLatestUsagePricing(
  state: MaterialUsageState,
  row: MaterialUsageRow,
  latest: MaterialVersion,
): MaterialUsageState {
  const update = describeLatestUsagePricing(row, latest);
  if (!update.compatible) throw new Error(update.reason);
  return setUsagePricing(state, row, update.next);
}

type IdMap = Map<string, string> | Record<string, string> | ((id: string) => string);
function mapId(map: IdMap, id: string): string {
  return typeof map === 'function' ? map(id) : map instanceof Map ? (map.get(id) ?? id) : (map[id] ?? id);
}
export function remapMaterialUsage(
  state: MaterialUsageState,
  surfaceMap: IdMap,
  fixtureMap: IdMap,
): MaterialUsageState {
  const next = structuredClone(state);
  next.assignments = Object.fromEntries(
    Object.entries(state.assignments).map(([id, assignment]) => [
      mapId(assignment.category === 'tile' ? surfaceMap : fixtureMap, id),
      structuredClone(assignment),
    ]),
  );
  next.areas = Object.fromEntries(
    Object.entries(state.areas).map(([id, area]) => [mapId(surfaceMap, id), structuredClone(area)]),
  );
  next.aggregateAreas = state.aggregateAreas.map((a) => ({
    ...a,
    surfaceIds: a.surfaceIds.map((id) => mapId(surfaceMap, id)),
  }));
  next.quantities = {};
  for (const [key, value] of Object.entries(state.quantities)) {
    try {
      const [category, ids] = JSON.parse(key) as ['tile' | 'fixture', string[]];
      next.quantities[
        usageKey(
          category,
          ids.map((id) => mapId(category === 'tile' ? surfaceMap : fixtureMap, id)),
        )
      ] = structuredClone(value);
    } catch {
      /* Obsolete malformed keys have no linked current purchasing row. */
    }
  }
  return next;
}
