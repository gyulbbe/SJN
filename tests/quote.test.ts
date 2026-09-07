import { describe, expect, it } from 'vitest';
import { createBaseRoomSurfaces } from '../src/lib/base-room';
import {
  calculateQuote,
  createCustomQuoteLine,
  createQuote,
  defaultMaterialPricing,
  duplicateQuote,
  quantityForLine,
  quoteSourceSignature,
} from '../src/lib/quote';
import type { QuoteLine } from '../src/lib/quote-types';
import { quoteDocumentSchema } from '../src/lib/quote-validation';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type FixtureInstance,
  type MaterialVersion,
  type LegacyProjectDocument as ProjectDocument,
} from '../src/lib/types';

function material(overrides: Partial<MaterialVersion> = {}): MaterialVersion {
  return {
    id: 'tile-v1',
    materialId: 'tile',
    version: 1,
    name: '스톤 타일',
    brand: '등록 업체',
    code: 'T-01',
    category: 'tile',
    scope: 'personal',
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 600,
    depthMm: 10,
    usage: 'both',
    installation: 'floor',
    coverAssetId: 'cover',
    imageAssetIds: ['cover'],
    textureAssetIds: ['texture'],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#fff',
    defaultPattern: 'grid',
    createdAt: '2026-01-01T00:00:00Z',
    pricing: { unit: 'box', unitPrice: 30000, boxCoverageM2: 1.44, piecesPerBox: 4, wastePercent: 10 },
    ...overrides,
  };
}

function fixture(id: string, materialVersionId = 'fixture-v1'): FixtureInstance {
  return {
    id,
    name: '배치 제품',
    materialVersionId,
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.2,
    height: 0.3,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0.4, blur: 10, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}

function project(): ProjectDocument {
  const surfaces = createBaseRoomSurfaces();
  surfaces[0].materialVersionId = 'tile-v1';
  surfaces[1].materialVersionId = 'tile-v1';
  return {
    id: 'project',
    ownerId: 'local',
    name: '우리 집',
    schemaVersion: 1,
    editRevision: 3,
    storageRevision: 2,
    scene: {
      originalAssetId: 'photo',
      previewAssetId: 'preview',
      imageWidth: 1536,
      imageHeight: 1024,
      surfaces,
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
    history: { past: [], future: [] },
    viewport: { zoom: 2, pan: { x: 12, y: 30 } },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function line(overrides: Partial<QuoteLine> = {}): QuoteLine {
  return {
    ...createCustomQuoteLine(),
    name: '시공비',
    quantityConfirmed: true,
    unitPrice: 10000,
    ...overrides,
  };
}

function tileLine(overrides: Partial<QuoteLine> = {}): QuoteLine {
  return { ...createQuote(project(), { 'tile-v1': material() }).lines[0], ...overrides };
}

describe('quotation defaults and immutable source snapshots', () => {
  it('uses unknown prices and zero waste by default, including legacy versions', () => {
    expect(defaultMaterialPricing('tile')).toEqual({
      unit: 'm2',
      unitPrice: null,
      boxCoverageM2: null,
      piecesPerBox: null,
      wastePercent: 0,
    });
    expect(defaultMaterialPricing('basin').unit).toBe('piece');
    const legacy = material({ pricing: undefined });
    const quote = createQuote(project(), { 'tile-v1': legacy });
    expect(quote.lines[0].unit).toBe('m2');
    expect(quote.lines[0].unitPrice).toBeNull();
    expect(quote.lines[0].areaM2).toBeNull();
    expect(quote.siteName).toBe('우리 집');
    expect(quote.number).toMatch(/^Q-\d{8}-[A-F0-9]{6}$/);
    expect(quote.taxRate).toBe(0);
  });

  it('copies registered prices, units, packaging and waste without sharing live material state', () => {
    const source = material();
    const quote = createQuote(project(), { 'tile-v1': source });
    expect(quote.lines).toHaveLength(1);
    expect(quote.lines[0]).toMatchObject({
      sourceKey: 'tile:tile-v1',
      materialVersionId: 'tile-v1',
      name: '스톤 타일',
      unit: 'box',
      unitPrice: 30000,
      boxCoverageM2: 1.44,
      piecesPerBox: 4,
      wastePercent: 10,
      tileAreaM2: 0.36,
    });
    source.pricing!.unitPrice = 9999;
    source.pricing!.boxCoverageM2 = 3;
    source.name = '새 이름';
    expect(quote.lines[0].unitPrice).toBe(30000);
    expect(quote.lines[0].boxCoverageM2).toBe(1.44);
    expect(quote.lines[0].name).toBe('스톤 타일');
    quote.lines[0].wastePercent = 20;
    expect(source.pricing!.wastePercent).toBe(10);
  });

  it('never treats perspective dimensions, calibrated quads, or masks as measured construction area', () => {
    const input = project();
    input.scene.surfaces.forEach((surface) => {
      surface.calibrated = true;
      surface.widthMm = 90000;
      surface.heightMm = 80000;
    });
    input.scene.surfaces[0].mask.holes = [
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
    ];
    const quote = createQuote(input, { 'tile-v1': material() });
    expect(quote.lines[0].areaM2).toBeNull();
    expect(quantityForLine(quote.lines[0])).toBeNull();
    expect(calculateQuote(quote)).toMatchObject({ total: 0, unresolvedCount: 1 });
  });

  it('groups product versions by placement count but requires existing-product confirmation', () => {
    const input = project();
    input.scene.fixtures = [fixture('one'), fixture('two'), fixture('third', 'fixture-v2')];
    const products = {
      'tile-v1': material(),
      'fixture-v1': material({
        id: 'fixture-v1',
        category: 'toilet',
        pricing: { ...defaultMaterialPricing('toilet'), unitPrice: 150000 },
      }),
      'fixture-v2': material({
        id: 'fixture-v2',
        category: 'toilet',
        pricing: { ...defaultMaterialPricing('toilet'), unitPrice: 180000 },
      }),
    };
    const quote = createQuote(input, products);
    expect(quote.lines).toHaveLength(3);
    expect(quote.lines[1]).toMatchObject({
      sourceKey: 'fixture:fixture-v1',
      quantity: 2,
      quantityMode: 'manual',
      quantityConfirmed: false,
      unitPrice: 150000,
    });
    expect(quote.lines[2].quantity).toBe(1);
    expect(calculateQuote(quote)).toMatchObject({ subtotal: 480000, unresolvedCount: 3 });
  });

  it('retains unknown assigned material rows and ignores unassigned surfaces and undo history', () => {
    const input = project();
    input.history.past.push(structuredClone(input.scene));
    input.scene.surfaces = [];
    expect(createQuote(input, {}).lines).toEqual([]);
    input.scene.fixtures.push(fixture('unknown', 'missing-version'));
    const quote = createQuote(input, {});
    expect(quote.lines).toHaveLength(1);
    expect(quote.lines[0]).toMatchObject({
      name: '자재 정보 확인 필요',
      materialVersionId: 'missing-version',
      unitPrice: null,
    });
    expect(calculateQuote(quote).unresolvedCount).toBe(1);
  });

  it('tracks source assignment changes while ignoring visual edits, reordering, masks and product moves', () => {
    const input = project();
    input.scene.fixtures = [fixture('one'), fixture('two')];
    const signature = quoteSourceSignature(input.scene);
    input.scene.surfaces.reverse();
    input.scene.fixtures.reverse();
    input.scene.fixtures[0].position.x = 0.99;
    input.scene.fixtures[0].occlusion.polygon = [{ x: 0, y: 0 }];
    input.scene.fixtures[0].rotation = 45;
    input.scene.surfaces[0].widthMm = 123;
    input.scene.surfaces[1].mask.strokes.push({ points: [{ x: 0, y: 0 }], radius: 0.5, erase: true });
    input.scene.color.exposure = 1;
    expect(quoteSourceSignature(input.scene)).toBe(signature);
    input.scene.fixtures.pop();
    expect(quoteSourceSignature(input.scene)).not.toBe(signature);
    const removedSignature = quoteSourceSignature(input.scene);
    input.scene.surfaces[2].materialVersionId = 'tile-v2';
    expect(quoteSourceSignature(input.scene)).not.toBe(removedSignature);
  });

  it('duplicates a quotation deeply with a new identifier and number, preserving negotiated values', () => {
    const original = createQuote(project(), { 'tile-v1': material() });
    original.lines[0].unitPrice = 25000;
    original.customerName = '고객';
    original.createdAt = '2020-01-01T00:00:00Z';
    const copy = duplicateQuote(original);
    expect(copy.id).not.toBe(original.id);
    expect(copy.number).not.toBe(original.number);
    expect(copy.createdAt).not.toBe(original.createdAt);
    expect(copy.updatedAt).toBe(copy.createdAt);
    expect(copy.sourceSignature).toBe(original.sourceSignature);
    expect(copy.customerName).toBe('고객');
    expect(copy.lines).toEqual(original.lines);
    copy.lines[0].unitPrice = 123;
    expect(original.lines[0].unitPrice).toBe(25000);
  });
});

describe('measured quantities and packaging', () => {
  it('rounds boxes after grouping the same material across planes and applying waste', () => {
    const quote = createQuote(project(), { 'tile-v1': material() });
    expect(quote.lines).toHaveLength(1);
    Object.assign(quote.lines[0], { areaM2: 12, quantityConfirmed: true });
    expect(quantityForLine(quote.lines[0])).toBe(10);
    expect(calculateQuote(quote)).toMatchObject({ subtotal: 300000, total: 300000, unresolvedCount: 0 });
    expect(quantityForLine(tileLine({ areaM2: 14.4, wastePercent: 0 }))).toBe(10);
  });

  it('prefers explicit box coverage and otherwise derives it from pieces and true tile dimensions', () => {
    expect(quantityForLine(tileLine({ areaM2: 3, wastePercent: 0, boxCoverageM2: 3, piecesPerBox: 4 }))).toBe(
      1,
    );
    expect(
      quantityForLine(tileLine({ areaM2: 3, wastePercent: 0, boxCoverageM2: null, piecesPerBox: 4 })),
    ).toBe(3);
    expect(quantityForLine(tileLine({ areaM2: 3, boxCoverageM2: null, piecesPerBox: null }))).toBeNull();
    expect(quantityForLine(tileLine({ areaM2: 3, boxCoverageM2: -1, piecesPerBox: 4 }))).toBeNull();
  });

  it('supports square metres, whole tiles and manual overrides without applying waste twice', () => {
    expect(quantityForLine(tileLine({ unit: 'm2', areaM2: 12 }))).toBe(13.2);
    expect(quantityForLine(tileLine({ unit: 'piece', areaM2: 1, wastePercent: 0 }))).toBe(3);
    expect(quantityForLine(tileLine({ unit: 'set', areaM2: 1 }))).toBeNull();
    expect(
      quantityForLine(
        tileLine({ unit: 'box', quantityMode: 'manual', quantity: 7, areaM2: 100, wastePercent: 100 }),
      ),
    ).toBe(7);
    expect(quantityForLine(tileLine({ unit: 'm2', areaM2: 0 }))).toBe(0);
  });

  it('rejects invalid input values, excess quantities and missing specifications safely', () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 100001]) {
      expect(quantityForLine(line({ quantity: value }))).toBeNull();
      expect(quantityForLine(tileLine({ areaM2: value }))).toBeNull();
    }
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 101])
      expect(quantityForLine(tileLine({ areaM2: 1, wastePercent: value }))).toBeNull();
    expect(quantityForLine(tileLine({ areaM2: 100000, unit: 'm2', wastePercent: 100 }))).toBeNull();
    expect(
      quantityForLine(tileLine({ unit: 'box', areaM2: 1, boxCoverageM2: null, piecesPerBox: 1.5 })),
    ).toBeNull();
    expect(quantityForLine(tileLine({ unit: 'piece', areaM2: 1, tileAreaM2: 0 }))).toBeNull();
    expect(tileLine().areaM2).toBeNull();
    const invalidTile = material({ widthMm: -600, heightMm: -600 });
    expect(createQuote(project(), { 'tile-v1': invalidTile }).lines[0].tileAreaM2).toBeNull();
  });
});

describe('quotation totals', () => {
  it('rounds each line to won, discounts the subtotal, then applies configured tax', () => {
    const quote = createQuote(project(), {});
    quote.lines = [line({ unitPrice: 101, quantity: 1.5 }), line({ unitPrice: 101, quantity: 1.5 })];
    quote.discount = 4;
    quote.taxRate = 10;
    expect(calculateQuote(quote)).toEqual({
      subtotal: 304,
      discount: 4,
      tax: 30,
      total: 330,
      unresolvedCount: 0,
    });
  });

  it('distinguishes zero and missing prices, excludes unchecked rows, and flags unconfirmed quantities', () => {
    const quote = createQuote(project(), {});
    quote.lines = [
      line({ unitPrice: 0 }),
      line({ unitPrice: null }),
      line({ quantityConfirmed: false }),
      line({ included: false, unitPrice: null }),
    ];
    expect(calculateQuote(quote)).toEqual({
      subtotal: 10000,
      discount: 0,
      tax: 0,
      total: 10000,
      unresolvedCount: 2,
    });
    quote.lines = [line({ quantity: 0, unitPrice: 200 })];
    expect(calculateQuote(quote)).toMatchObject({ subtotal: 0, unresolvedCount: 0 });
  });

  it('clamps discounts and rejects invalid rates or prices instead of producing negative or non-finite totals', () => {
    const quote = createQuote(project(), {});
    quote.lines = [line()];
    quote.discount = 50000;
    quote.taxRate = 10;
    expect(calculateQuote(quote)).toMatchObject({ discount: 10000, total: 0 });
    quote.discount = -100;
    quote.taxRate = -10;
    expect(calculateQuote(quote)).toMatchObject({ discount: 0, tax: 0, total: 10000 });
    quote.discount = Number.NaN;
    quote.taxRate = Number.POSITIVE_INFINITY;
    expect(calculateQuote(quote)).toMatchObject({ discount: 0, tax: 0, total: 10000 });
    quote.lines = [-1, Number.NaN, Number.POSITIVE_INFINITY, 100000001].map((unitPrice) =>
      line({ unitPrice }),
    );
    expect(calculateQuote(quote)).toMatchObject({ subtotal: 0, total: 0, unresolvedCount: 4 });
  });

  it('keeps the supported maximum amount within integer safety and flags excess rows', () => {
    const quote = createQuote(project(), {});
    quote.lines = Array.from({ length: 301 }, () => line({ unitPrice: 100000000, quantity: 100000 }));
    quote.taxRate = 100;
    const totals = calculateQuote(quote);
    expect(totals.subtotal).toBe(3000000000000000);
    expect(totals.total).toBe(6000000000000000);
    expect(Number.isSafeInteger(totals.total)).toBe(true);
    expect(totals.unresolvedCount).toBe(1);
  });
});

describe('fixture sale units and persisted description limits', () => {
  function productQuote(pricing: MaterialVersion['pricing']) {
    const input = project();
    input.scene.surfaces = [];
    input.scene.fixtures = [fixture('one'), fixture('two'), fixture('three')];
    return createQuote(input, { 'fixture-v1': material({ id: 'fixture-v1', category: 'toilet', pricing }) });
  }

  it('uses one piece or set per placement with explicit confirmation and set assumptions', () => {
    const pieces = productQuote({ ...defaultMaterialPricing('toilet'), unitPrice: 10000 });
    expect(pieces.lines[0]).toMatchObject({ quantity: 3, unit: 'piece', quantityConfirmed: false });
    expect(pieces.lines[0].note).toContain('제품 3개');
    const sets = productQuote({ ...defaultMaterialPricing('toilet'), unit: 'set', unitPrice: 10000 });
    expect(sets.lines[0]).toMatchObject({ quantity: 3, unit: 'set', quantityConfirmed: false });
    expect(sets.lines[0].note).toContain('제품 1개를 1세트로 가정');
    expect(calculateQuote(sets)).toMatchObject({ subtotal: 30000, unresolvedCount: 1 });
  });

  it('converts grouped product counts to boxes using pieces per box, never square metre coverage', () => {
    const quote = productQuote({
      ...defaultMaterialPricing('toilet'),
      unit: 'box',
      unitPrice: 10000,
      piecesPerBox: 2,
      boxCoverageM2: 500,
    });
    expect(quote.lines[0]).toMatchObject({ quantity: 2, quantityMode: 'manual', quantityConfirmed: false });
    expect(quote.lines[0].note).toContain('박스당 2개');
    expect(calculateQuote(quote)).toMatchObject({ subtotal: 20000, unresolvedCount: 1 });
    quote.lines[0].quantity = 1;
    quote.lines[0].quantityConfirmed = true;
    expect(calculateQuote(quote)).toMatchObject({ subtotal: 10000, unresolvedCount: 0 });
  });

  it('leaves quantities unknown when product packaging is missing or sold by area', () => {
    for (const piecesPerBox of [null, 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const quote = productQuote({
        ...defaultMaterialPricing('toilet'),
        unit: 'box',
        unitPrice: 10000,
        piecesPerBox,
        boxCoverageM2: 1,
      });
      expect(quote.lines[0].quantity).toBeNull();
      expect(quote.lines[0].note).toContain('박스당 수량이 없어');
      expect(calculateQuote(quote)).toMatchObject({ subtotal: 0, unresolvedCount: 1 });
    }
    const quote = productQuote({ ...defaultMaterialPricing('toilet'), unit: 'm2', unitPrice: 10000 });
    expect(quote.lines[0]).toMatchObject({
      quantity: null,
      quantityMode: 'manual',
      quantityConfirmed: false,
    });
    expect(quote.lines[0].note).toContain('실측 면적을 수량에 직접 입력');
    expect(calculateQuote(quote)).toMatchObject({ subtotal: 0, unresolvedCount: 1 });
  });

  it('keeps copied descriptions within quotation schema limits, preserving dimensions first', () => {
    const input = project();
    input.name = '현장'.repeat(150);
    const versionId = crypto.randomUUID();
    input.scene.surfaces.forEach((surface) => {
      if (surface.materialVersionId) surface.materialVersionId = versionId;
    });
    const quote = createQuote(input, {
      [versionId]: material({
        id: versionId,
        name: '🧱'.repeat(150),
        brand: '가'.repeat(200),
        code: 'B'.repeat(200),
      }),
    });
    expect(quote.lines[0].name.length).toBeLessThanOrEqual(200);
    expect(quote.lines[0].name).toMatch(/…$/);
    expect(quote.lines[0].specification.length).toBeLessThanOrEqual(300);
    expect(quote.lines[0].specification.startsWith('600 × 600 mm')).toBe(true);
    expect(quote.lines[0].note.length).toBeLessThanOrEqual(2000);
    expect(quote.siteName.length).toBeLessThanOrEqual(200);
    expect(quoteDocumentSchema.safeParse(quote).success).toBe(true);
  });
});
