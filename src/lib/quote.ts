import type { MaterialPricing, QuoteDocument, QuoteLine, QuoteUnit } from './quote-types';
import { getActiveScene } from './designs';
import type { MaterialCategory, MaterialVersion, ProjectInput, Scene } from './types';

export const QUOTE_UNIT_LABELS: Record<QuoteUnit, string> = {
  m2: '㎡',
  box: '박스',
  piece: '개',
  set: '세트',
};

const MAX_QUANTITY = 100_000;
const MAX_UNIT_PRICE = 100_000_000;
const MAX_LINES = 300;

export function defaultMaterialPricing(category: MaterialCategory): MaterialPricing {
  return {
    unit: category === 'tile' ? 'm2' : 'piece',
    unitPrice: null,
    boxCoverageM2: null,
    piecesPerBox: null,
    wastePercent: 0,
  };
}

function bounded(value: unknown, maximum: number, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

/** Only purchasing inputs affect this signature. Occlusion and placement never reduce quantities. */
export function quoteSourceSignature(scene: Scene): string {
  const sorted = (entries: string[][]) =>
    entries.sort((a, b) => {
      const left = JSON.stringify(a);
      const right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return JSON.stringify({
    surfaces: sorted(
      scene.surfaces
        .filter((surface) => surface.materialVersionId)
        .map((surface) => [surface.id, surface.materialVersionId!]),
    ),
    fixtures: sorted(scene.fixtures.map((fixture) => [fixture.id, fixture.materialVersionId])),
  });
}

/** A full linked face contributes its physical area, independently of photo masks or occluding products. */
export function roomAreaForSurfaces(scene: Scene, surfaceIds: string[], versionId?: string): number | null {
  const room = scene.room;
  if (!room || !surfaceIds.length || new Set(surfaceIds).size !== surfaceIds.length) return null;
  if (
    !bounded(room.widthMm, 20_000, 500) ||
    !bounded(room.depthMm, 20_000, 500) ||
    !bounded(room.heightMm, 6_000, 1_000)
  )
    return null;
  const faces = new Map<string, { from: number; to: number }[]>();
  let area = 0;
  for (const id of surfaceIds) {
    const surface = scene.surfaces.find((item) => item.id === id);
    if (
      !surface ||
      surface.geometryMode !== 'room' ||
      !surface.roomFace ||
      (versionId && surface.materialVersionId !== versionId)
    )
      return null;
    const band = surface.reconstructionBand ?? { from: 0, to: 1 };
    if (
      !Number.isFinite(band.from) ||
      !Number.isFinite(band.to) ||
      band.from < 0 ||
      band.to > 1 ||
      band.from >= band.to ||
      (surface.reconstructionBand && surface.roomFace === 'floor')
    )
      return null;
    const intervals = faces.get(surface.roomFace) ?? [];
    if (intervals.some((b) => Math.min(b.to, band.to) - Math.max(b.from, band.from) > 1e-9)) return null;
    faces.set(surface.roomFace, [...intervals, band]);
    const fraction = band.to - band.from;
    if (surface.roomFace === 'floor') area += room.widthMm * room.depthMm;
    else if (surface.roomFace === 'back') area += room.widthMm * room.heightMm * fraction;
    else if (surface.roomFace === 'left' || surface.roomFace === 'right')
      area += room.depthMm * room.heightMm * fraction;
    else return null;
  }
  return Math.round(area) / 1_000_000;
}

/** Keep the original quote composition and all commercial overrides while updating explicitly linked areas. */
export function resyncRoomQuote(quote: QuoteDocument, scene: Scene): QuoteDocument {
  let changed = false;
  const lines = quote.lines.map((line) => {
    if (line.category !== 'tile' || line.areaSource !== 'room') return line;
    const areaM2 = roomAreaForSurfaces(scene, line.sourceSurfaceIds ?? [], line.materialVersionId);
    if (areaM2 === line.areaM2) return line;
    changed = true;
    const next = { ...line, areaM2 };
    if (line.quantityMode === 'auto' && (areaM2 === null || quantityForLine(next) !== quantityForLine(line)))
      next.quantityConfirmed = false;
    return next;
  });
  return changed ? { ...quote, lines, updatedAt: new Date().toISOString() } : quote;
}

/** Snapshot descriptions must also fit the persisted quotation schema. */
function fitText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let end = maximum - 1;
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end--;
  return `${value.slice(0, end)}…`;
}

function fixtureQuantity(pricing: MaterialPricing, count: number): Pick<QuoteLine, 'quantity' | 'note'> {
  const confirmation = '기존 제품 유지·이동 여부와 구매 수량을 확인하세요.';
  if (pricing.unit === 'piece')
    return { quantity: count, note: `배치된 제품 ${count}개를 가져왔습니다. ${confirmation}` };
  if (pricing.unit === 'set')
    return {
      quantity: count,
      note: `배치된 제품 1개를 1세트로 가정한 수량입니다. 실제 세트 구성을 확인하세요. ${confirmation}`,
    };
  if (pricing.unit === 'box') {
    if (bounded(pricing.piecesPerBox, MAX_QUANTITY, 1) && Number.isInteger(pricing.piecesPerBox))
      return {
        quantity: Math.ceil(count / pricing.piecesPerBox),
        note: `배치된 제품 ${count}개를 박스당 ${pricing.piecesPerBox}개 기준으로 올림했습니다. ${confirmation}`,
      };
    return {
      quantity: null,
      note: `배치된 제품은 ${count}개입니다. 박스당 수량이 없어 주문 박스 수를 계산할 수 없습니다. 구매 수량을 직접 입력하세요. ${confirmation}`,
    };
  }
  return {
    quantity: null,
    note: `배치된 제품은 ${count}개입니다. ㎡ 단가는 배치 개수로 환산할 수 없습니다. 실측 면적을 수량에 직접 입력하세요. ${confirmation}`,
  };
}
function materialLine(
  category: 'tile' | 'fixture',
  versionId: string,
  material: MaterialVersion | undefined,
  count: number,
): QuoteLine {
  const pricing = {
    ...defaultMaterialPricing(category === 'tile' ? 'tile' : 'toilet'),
    ...material?.pricing,
  };
  const fixtureDefault = category === 'fixture' ? fixtureQuantity(pricing, count) : null;
  const dimensions = material
    ? [material.widthMm, material.heightMm, ...(category === 'fixture' ? [material.depthMm] : [])]
        .filter((value) => bounded(value, 1_000_000, Number.MIN_VALUE))
        .join(' × ')
    : '';
  const tileArea =
    material &&
    bounded(material.widthMm, 1_000_000, Number.MIN_VALUE) &&
    bounded(material.heightMm, 1_000_000, Number.MIN_VALUE)
      ? (material.widthMm * material.heightMm) / 1_000_000
      : null;
  return {
    id: crypto.randomUUID(),
    sourceKey: `${category}:${versionId}`,
    materialVersionId: versionId,
    category,
    name: fitText(material?.name || '자재 정보 확인 필요', 200),
    specification: fitText(
      [dimensions ? `${dimensions} mm` : '', material?.brand, material?.code].filter(Boolean).join(' · '),
      300,
    ),
    ...pricing,
    quantity: fixtureDefault?.quantity ?? null,
    quantityMode: category === 'fixture' ? 'manual' : 'auto',
    quantityConfirmed: false,
    areaM2: null,
    tileAreaM2: category === 'tile' && bounded(tileArea, MAX_QUANTITY, Number.MIN_VALUE) ? tileArea : null,
    included: true,
    note: fitText(
      material
        ? (fixtureDefault?.note ?? '')
        : `자재 버전 ${versionId}의 정보를 찾을 수 없습니다. 상품과 단가를 확인하세요.`,
      2000,
    ),
  };
}

export function createQuote(
  project: ProjectInput,
  materials: Record<string, MaterialVersion>,
): QuoteDocument {
  const scene = project.schemaVersion === 3 ? getActiveScene(project) : project.scene;
  const grouped = new Map<string, { category: 'tile' | 'fixture'; versionId: string; count: number }>();
  const add = (category: 'tile' | 'fixture', versionId: string) => {
    const key = `${category}:${versionId}`;
    const current = grouped.get(key);
    if (current) current.count++;
    else grouped.set(key, { category, versionId, count: 1 });
  };
  for (const surface of scene.surfaces) if (surface.materialVersionId) add('tile', surface.materialVersionId);
  for (const fixture of scene.fixtures) add('fixture', fixture.materialVersionId);
  const now = new Date();
  const createdAt = now.toISOString();
  // Use the user's calendar date, rather than switching the issue date at UTC midnight.
  const issueDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const id = crypto.randomUUID();
  return {
    id,
    number: `Q-${issueDate.replaceAll('-', '')}-${id.slice(0, 6).toUpperCase()}`,
    createdAt,
    updatedAt: createdAt,
    sourceSignature: quoteSourceSignature(scene),
    supplierName: '',
    supplierPhone: '',
    customerName: '',
    siteName: fitText(project.name, 200),
    issueDate,
    validUntil: '',
    notes: '',
    discount: 0,
    taxRate: 0,
    lines: [...grouped.values()].map(({ category, versionId, count }) => {
      const line = materialLine(category, versionId, materials[versionId], count);
      if (category !== 'tile') return line;
      const sourceSurfaceIds = scene.surfaces
        .filter((surface) => surface.materialVersionId === versionId)
        .map((surface) => surface.id);
      const areaM2 = roomAreaForSurfaces(scene, sourceSurfaceIds, versionId);
      return {
        ...line,
        sourceSurfaceIds,
        areaSource: areaM2 === null ? ('manual' as const) : ('room' as const),
        areaM2,
      };
    }),
  };
}

/** Returns a potential quantity. quantityConfirmed is checked separately when totaling a quote. */
export function quantityForLine(line: QuoteLine): number | null {
  if (line.quantityMode === 'manual') return bounded(line.quantity, MAX_QUANTITY) ? line.quantity : null;
  if (
    line.quantityMode !== 'auto' ||
    line.category !== 'tile' ||
    !bounded(line.areaM2, MAX_QUANTITY) ||
    !bounded(line.wastePercent, 100)
  )
    return null;
  const area = line.areaM2 * (1 + line.wastePercent / 100);
  let quantity: number;
  if (line.unit === 'm2') quantity = Math.round(area * 1_000_000) / 1_000_000;
  else if (line.unit === 'piece' || line.unit === 'box') {
    let coverage = line.tileAreaM2;
    if (line.unit === 'box') {
      if (line.boxCoverageM2 !== null) coverage = line.boxCoverageM2;
      else if (
        bounded(line.piecesPerBox, MAX_QUANTITY, 1) &&
        Number.isInteger(line.piecesPerBox) &&
        bounded(line.tileAreaM2, MAX_QUANTITY, Number.MIN_VALUE)
      )
        coverage = line.piecesPerBox * line.tileAreaM2;
      else return null;
    }
    if (!bounded(coverage, MAX_QUANTITY, Number.MIN_VALUE)) return null;
    const ratio = area / coverage;
    // Exact box multiples should not become an extra box due to binary float rounding.
    quantity = Math.ceil(ratio - Number.EPSILON * Math.max(1, ratio) * 8);
  } else return null;
  return bounded(quantity, MAX_QUANTITY) ? quantity : null;
}

export function calculateQuote(quote: QuoteDocument): {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  unresolvedCount: number;
} {
  let subtotal = 0;
  let unresolvedCount = 0;
  let includedCount = 0;
  for (const line of quote.lines) {
    if (!line.included) continue;
    includedCount++;
    const quantity = quantityForLine(line);
    const priceValid = bounded(line.unitPrice, MAX_UNIT_PRICE);
    const supportedUnit = Object.hasOwn(QUOTE_UNIT_LABELS, line.unit);
    const valid = quantity !== null && priceValid && supportedUnit && includedCount <= MAX_LINES;
    if (!valid || !line.quantityConfirmed) unresolvedCount++;
    if (valid) subtotal += Math.round(quantity * line.unitPrice!);
  }
  const discount = Number.isFinite(quote.discount)
    ? Math.round(Math.min(subtotal, Math.max(0, quote.discount)))
    : 0;
  const taxRate = bounded(quote.taxRate, 100) ? quote.taxRate : 0;
  const tax = Math.round(((subtotal - discount) * taxRate) / 100);
  return { subtotal, discount, tax, total: subtotal - discount + tax, unresolvedCount };
}

export function createCustomQuoteLine(): QuoteLine {
  return {
    id: crypto.randomUUID(),
    category: 'custom',
    name: '',
    specification: '',
    ...defaultMaterialPricing('toilet'),
    unit: 'set',
    quantity: 1,
    quantityMode: 'manual',
    quantityConfirmed: false,
    areaM2: null,
    tileAreaM2: null,
    included: true,
    note: '',
  };
}

/** A copied project gets an independent quotation and a fresh customer-visible number. */
export function duplicateQuote(quote: QuoteDocument): QuoteDocument {
  const copied = structuredClone(quote);
  const now = new Date();
  const calendarDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  copied.id = crypto.randomUUID();
  copied.number = `Q-${calendarDate}-${copied.id.slice(0, 6).toUpperCase()}`;
  copied.createdAt = now.toISOString();
  copied.updatedAt = copied.createdAt;
  return copied;
}
