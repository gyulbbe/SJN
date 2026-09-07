import { describe, expect, it } from 'vitest';
import {
  applyLatestUsagePricing,
  calculateMaterialUsage,
  describeLatestUsagePricing,
  ensureMaterialUsage,
  packagingCoverage,
  remapMaterialUsage,
  setUsageArea,
  setUsagePricing,
  setUsageQuantity,
  usageCeil,
} from '../src/lib/material-usage';
import { createQuote } from '../src/lib/quote';
import {
  DEFAULT_COLOR,
  DEFAULT_TILE,
  EMPTY_MASK,
  type MaterialVersion,
  type Surface,
  type FixtureInstance,
  type Scene,
  type LegacyProjectDocument,
} from '../src/lib/types';

function material(overrides: Partial<MaterialVersion> = {}): MaterialVersion {
  return {
    id: 'tile-v1',
    materialId: 'tile',
    version: 1,
    name: '스톤',
    brand: '업체',
    code: 'T1',
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
    createdAt: '2026-09-01T00:00:00Z',
    pricing: { unit: 'box', unitPrice: 40_000, boxCoverageM2: 1.44, piecesPerBox: 4, wastePercent: 25 },
    ...overrides,
  };
}
function surface(id: string, changes: Partial<Surface> = {}): Surface {
  return {
    id,
    name: id,
    kind: 'wall',
    roomFace: 'back',
    geometryMode: 'room',
    widthMm: 4000,
    heightMm: 3000,
    calibrated: false,
    materialVersionId: 'tile-v1',
    quad: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    mask: EMPTY_MASK(),
    tile: { ...DEFAULT_TILE },
    color: { ...DEFAULT_COLOR },
    ...changes,
  };
}
function fixture(id: string, changes: Partial<FixtureInstance> = {}): FixtureInstance {
  return {
    id,
    name: id,
    materialVersionId: 'product-v1',
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
    ...changes,
  };
}
function scene(surfaces = [surface('back')], fixtures: FixtureInstance[] = []): Scene {
  return {
    originalAssetId: 'photo',
    previewAssetId: 'preview',
    imageWidth: 1920,
    imageHeight: 1080,
    room: { kind: 'parametric', version: 1, widthMm: 4000, depthMm: 2000, heightMm: 3000 },
    surfaces,
    fixtures,
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
function project(value: Scene): LegacyProjectDocument {
  return {
    id: 'project',
    name: '방',
    ownerId: 'local',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 0,
    scene: value,
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  };
}
const tiles = () => ({ 'tile-v1': material() });
const products = () => ({
  'product-v1': material({
    id: 'product-v1',
    materialId: 'product',
    category: 'toilet',
    pricing: { unit: 'piece', unitPrice: 125_000, boxCoverageM2: null, piecesPerBox: null, wastePercent: 40 },
  }),
});

describe('After material usage calculation', () => {
  it('calculates 12㎡ ÷ 1.44㎡ = 9 boxes and 360,000 won without waste/tax', () => {
    const result = calculateMaterialUsage(scene(), tiles());
    expect(result.rows[0]).toMatchObject({ areaM2: 12, automaticQuantity: 9, quantity: 9, amount: 360_000 });
    expect(result).toMatchObject({ total: 360_000, unresolvedCount: 0, attentionCount: 0, complete: true });
    expect(result.state).not.toHaveProperty('total');
    expect(result.state).not.toHaveProperty('automaticQuantity');
  });
  it('sums faces before rounding purchase quantities once', () => {
    const value = scene([surface('left', { roomFace: 'left' }), surface('right', { roomFace: 'right' })]);
    const result = calculateMaterialUsage(value, tiles());
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ areaM2: 12, quantity: 9 });
  });
  it('corrects floating error at exact box multiples', () => {
    expect(usageCeil(0.1 + 0.2)).toBe(1);
    expect(usageCeil(3.0000000000000004)).toBe(3);
    expect(usageCeil(3.0000001)).toBe(4);
    const value = scene();
    let state = ensureMaterialUsage(value, tiles());
    state = setUsageArea(state, 'back', 14.4);
    expect(calculateMaterialUsage(value, tiles(), state).rows[0].quantity).toBe(10);
  });
  it('never erases a positive purchase quantity while correcting floating error', () => {
    expect(usageCeil(0)).toBe(0);
    expect(usageCeil(1e-20)).toBe(1);
    expect(usageCeil(Number.MIN_VALUE)).toBe(1);
  });
  it('does not round m² quantities before multiplying the unit price', () => {
    const catalog = {
      'tile-v1': material({
        pricing: { unit: 'm2', unitPrice: 9999, boxCoverageM2: null, piecesPerBox: null, wastePercent: 80 },
      }),
    };
    const value = scene();
    const state = setUsageArea(ensureMaterialUsage(value, catalog), 'back', 1.23456789);
    expect(calculateMaterialUsage(value, catalog, state).rows[0]).toMatchObject({
      quantity: 1.23456789,
      amount: Math.round(1.23456789 * 9999),
    });
  });
  it('uses tile dimensions for piece selling units', () => {
    const catalog = tiles();
    catalog['tile-v1'].pricing!.unit = 'piece';
    expect(calculateMaterialUsage(scene(), catalog).rows[0].quantity).toBe(34);
  });
  it('uses explicit box area before dimension × pieces fallback', () => {
    expect(packagingCoverage(600, 600, { boxCoverageM2: 1.5, piecesPerBox: 4 })).toMatchObject({
      coverageM2: 1.5,
      calculatedCoverageM2: 1.44,
      mismatch: true,
    });
    expect(packagingCoverage(600, 600, { boxCoverageM2: null, piecesPerBox: 4 })).toMatchObject({
      coverageM2: 1.44,
      mismatch: false,
    });
    expect(packagingCoverage(600, 600, { boxCoverageM2: 1.4400005, piecesPerBox: 4 }).mismatch).toBe(false);
    expect(packagingCoverage(600, 600, { boxCoverageM2: 0, piecesPerBox: 4 }).coverageM2).toBeNull();
  });
  it('keeps separate immutable products even if their display names match', () => {
    const catalog = { ...tiles(), 'tile-v2': material({ id: 'tile-v2', version: 2 }) };
    const value = scene([
      surface('left', { roomFace: 'left' }),
      surface('right', { roomFace: 'right', materialVersionId: 'tile-v2' }),
    ]);
    expect(calculateMaterialUsage(value, catalog).rows).toHaveLength(2);
  });
  it('separates price and packaging conditions for the same product version', () => {
    const value = scene([surface('left', { roomFace: 'left' }), surface('right', { roomFace: 'right' })]);
    const state = ensureMaterialUsage(value, tiles());
    state.assignments.right.pricing.unitPrice = 50_000;
    expect(calculateMaterialUsage(value, tiles(), state).rows).toHaveLength(2);
    state.assignments.right.pricing.unitPrice = 40_000;
    state.assignments.right.pricing.piecesPerBox = 8;
    expect(calculateMaterialUsage(value, tiles(), state).rows).toHaveLength(2);
  });
  it('distinguishes missing, explicit zero and invalid prices', () => {
    const value = scene();
    const catalog = tiles();
    catalog['tile-v1'].pricing!.unitPrice = null;
    expect(calculateMaterialUsage(value, catalog)).toMatchObject({ unresolvedCount: 1, complete: false });
    expect(calculateMaterialUsage(value, catalog).rows[0].amount).toBeNull();
    catalog['tile-v1'].pricing!.unitPrice = 0;
    expect(calculateMaterialUsage(value, catalog)).toMatchObject({ total: 0, complete: true });
    catalog['tile-v1'].pricing!.unitPrice = Number.NaN;
    expect(calculateMaterialUsage(value, catalog).rows[0].amount).toBeNull();
  });
  it('counts actual products regardless of move, rotation, masking, image bounds or visibility', () => {
    const value = scene(
      [],
      [
        fixture('one'),
        fixture('two', {
          position: { x: -10, y: 3 },
          rotation: 99,
          occlusion: {
            polygon: [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 1, y: 1 },
            ],
            strokes: [],
          },
        }),
      ],
    );
    const result = calculateMaterialUsage(value, products());
    expect(result.rows[0]).toMatchObject({ count: 2, quantity: 2, amount: 250_000 });
    value.fixtures.pop();
    expect(calculateMaterialUsage(value, products(), result.state).total).toBe(125_000);
  });
  it('never interprets legacy product box/set prices as per-piece prices', () => {
    const catalog = products();
    catalog['product-v1'].pricing!.unit = 'set';
    const value = scene([], [fixture('one')]);
    const result = calculateMaterialUsage(value, catalog);
    expect(result.rows[0]).toMatchObject({ quantity: 1, amount: null, needsAttention: true });
    const next = setUsagePricing(result.state, result.rows[0], { unitPrice: 100_000 });
    expect(calculateMaterialUsage(value, catalog, next)).toMatchObject({ total: 100_000, complete: true });
  });
  it('has no items after all applied materials and products are removed', () => {
    const value = scene([], []);
    expect(calculateMaterialUsage(value, tiles())).toMatchObject({ rows: [], total: 0, complete: true });
  });
});

describe('credible net installation areas', () => {
  it('does not infer photo areas from pixels, estimated plane sizes or masks', () => {
    const value = scene([surface('back', { geometryMode: 'manual', calibrated: false })]);
    delete value.room;
    const result = calculateMaterialUsage(value, tiles());
    expect(result.rows[0].areaM2).toBeNull();
    expect(result).toMatchObject({ unresolvedCount: 1, attentionCount: 1, complete: false });
  });
  it('refuses a partial known area total when one linked area is missing', () => {
    const value = scene([
      surface('back'),
      surface('unknown', { roomFace: undefined, geometryMode: 'manual' }),
    ]);
    expect(calculateMaterialUsage(value, tiles()).rows[0].areaM2).toBeNull();
  });
  it('allocates defined child bands before the remaining parent, across different materials', () => {
    const catalog = { ...tiles(), 'band-v1': material({ id: 'band-v1', materialId: 'band' }) };
    const value = scene([
      surface('parent'),
      surface('child', { reconstructionBand: { from: 0.5, to: 1 }, materialVersionId: 'band-v1' }),
    ]);
    const rows = calculateMaterialUsage(value, catalog).rows;
    expect(rows.map((r) => r.areaM2)).toEqual([6, 6]);
    expect(rows.reduce((sum, r) => sum + r.areaM2!, 0)).toBe(12);
  });
  it('does not double count parent and child if they use the same material', () => {
    const value = scene([surface('parent'), surface('child', { reconstructionBand: { from: 0.6, to: 1 } })]);
    expect(calculateMaterialUsage(value, tiles()).rows[0]).toMatchObject({ areaM2: 12, quantity: 9 });
  });
  it('holds automatic calculation for overlapping or duplicate full regions', () => {
    const value = scene([surface('a'), surface('b')]);
    expect(calculateMaterialUsage(value, tiles()).rows[0].areaM2).toBeNull();
    value.surfaces[0].reconstructionBand = { from: 0.2, to: 0.7 };
    value.surfaces[1].reconstructionBand = { from: 0.5, to: 1 };
    expect(calculateMaterialUsage(value, tiles()).rows[0].areaM2).toBeNull();
  });
  it('requires all areas in an ambiguous face to be confirmed independently', () => {
    const value = scene([surface('a'), surface('b')]);
    let state = setUsageArea(ensureMaterialUsage(value, tiles()), 'a', 5);
    expect(calculateMaterialUsage(value, tiles(), state).complete).toBe(false);
    state = setUsageArea(state, 'b', 7);
    expect(calculateMaterialUsage(value, tiles(), state)).toMatchObject({ complete: true, total: 360_000 });
  });
  it('ignores product occlusions and protection masks when computing room areas', () => {
    const value = scene();
    value.surfaces[0].mask.holes = [
      [
        { x: 0, y: 0 },
        { x: 0.9, y: 0 },
        { x: 0.9, y: 1 },
      ],
    ];
    expect(calculateMaterialUsage(value, tiles()).rows[0].areaM2).toBe(12);
  });
  it('shows a valid manual purchase amount despite missing area or packaging', () => {
    const value = scene();
    delete value.room;
    const catalog = tiles();
    catalog['tile-v1'].pricing!.boxCoverageM2 = null;
    catalog['tile-v1'].pricing!.piecesPerBox = null;
    const initial = calculateMaterialUsage(value, catalog);
    const state = setUsageQuantity(initial.state, initial.rows[0], 9);
    expect(calculateMaterialUsage(value, catalog, state)).toMatchObject({
      total: 360_000,
      unresolvedCount: 0,
      attentionCount: 1,
      complete: false,
    });
  });
});

describe('independent editing and price snapshots', () => {
  it('preserves manual purchase quantities after area changes and can return to auto', () => {
    const value = scene();
    const initial = calculateMaterialUsage(value, tiles());
    let state = setUsageQuantity(initial.state, initial.rows[0], 20);
    state = setUsageArea(state, 'back', 5);
    const manual = calculateMaterialUsage(value, tiles(), state);
    expect(manual.rows[0]).toMatchObject({ quantity: 20, automaticQuantity: 4, quantityMode: 'manual' });
    state = setUsageQuantity(state, manual.rows[0], 'auto');
    expect(calculateMaterialUsage(value, tiles(), state).rows[0].quantity).toBe(4);
    state = setUsageArea(state, 'back', 'room');
    expect(calculateMaterialUsage(value, tiles(), state).rows[0].areaM2).toBe(12);
  });
  it('does not transfer an old manual order after clearing and then applying another material', () => {
    const value = scene();
    const initial = calculateMaterialUsage(value, tiles());
    let state = setUsageQuantity(initial.state, initial.rows[0], 99);
    delete value.surfaces[0].materialVersionId;
    state = ensureMaterialUsage(value, tiles(), state);
    expect(state.quantities).toEqual({});
    value.surfaces[0].materialVersionId = 'tile-v2';
    const catalog = { ...tiles(), 'tile-v2': material({ id: 'tile-v2', version: 2 }) };
    expect(calculateMaterialUsage(value, catalog, state).rows[0]).toMatchObject({
      quantity: 9,
      quantityMode: 'auto',
    });
  });
  it('requires a new quantity on surviving faces when an unsplittable manual order loses a face', () => {
    const value = scene([surface('left', { roomFace: 'left' }), surface('right', { roomFace: 'right' })]);
    const initial = calculateMaterialUsage(value, tiles());
    const state = setUsageQuantity(initial.state, initial.rows[0], 20);
    delete value.surfaces[1].materialVersionId;
    const result = calculateMaterialUsage(value, tiles(), state);
    expect(result.rows[0]).toMatchObject({ quantity: null, quantityMode: 'manual', automaticQuantity: 5 });
    value.surfaces[1].materialVersionId = 'tile-v2';
    const catalog = { ...tiles(), 'tile-v2': material({ id: 'tile-v2', version: 2 }) };
    expect(
      calculateMaterialUsage(value, catalog, result.state).rows.find(
        (row) => row.materialVersionId === 'tile-v2',
      ),
    ).toMatchObject({ quantity: 5, quantityMode: 'auto' });
  });
  it('retains explicitly zero manual quantity', () => {
    const value = scene();
    const initial = calculateMaterialUsage(value, tiles());
    const state = setUsageQuantity(initial.state, initial.rows[0], 0);
    expect(calculateMaterialUsage(value, tiles(), state)).toMatchObject({ total: 0, complete: true });
  });
  it('requires per-piece product quantities to come from placements', () => {
    const result = calculateMaterialUsage(scene([], [fixture('f')]), products());
    expect(() => setUsageQuantity(result.state, result.rows[0], 10)).toThrow();
  });
  it('rejects NaN, infinity, negative, excessive and fractional unit counts', () => {
    const initial = calculateMaterialUsage(scene(), tiles());
    for (const bad of [NaN, Infinity, -1, 100_001]) {
      expect(() => setUsageArea(initial.state, 'back', bad)).toThrow();
      expect(() => setUsageQuantity(initial.state, initial.rows[0], bad)).toThrow();
    }
    expect(() => setUsageQuantity(initial.state, initial.rows[0], 1.5)).toThrow();
    for (const bad of [NaN, Infinity, -1, 0.5, 100_000_001])
      expect(() => setUsagePricing(initial.state, initial.rows[0], { unitPrice: bad })).toThrow();
    expect(() => setUsagePricing(initial.state, initial.rows[0], { piecesPerBox: 1.5 })).toThrow();
  });
  it('keeps an immutable applied price when the catalog changes', () => {
    const value = scene();
    const catalog = tiles();
    const state = ensureMaterialUsage(value, catalog);
    catalog['tile-v1'].pricing!.unitPrice = 1;
    expect(calculateMaterialUsage(value, catalog, state).total).toBe(360_000);
    expect(ensureMaterialUsage(value, catalog, state)).toBe(state);
  });
  it('does not capture an unresolved material as a permanent empty snapshot', () => {
    const value = scene();
    const pending = ensureMaterialUsage(value, {});
    expect(pending.assignments).toEqual({});
    expect(calculateMaterialUsage(value, tiles(), pending).total).toBe(360_000);
  });
  it('changes only the selected usage snapshot and preserves manual quantity on same unit', () => {
    const value = scene();
    const result = calculateMaterialUsage(value, tiles());
    const original = structuredClone(result.state);
    const manual = setUsageQuantity(result.state, result.rows[0], 11);
    const next = setUsagePricing(manual, result.rows[0], { unitPrice: 5 });
    expect(calculateMaterialUsage(value, tiles(), next).rows[0]).toMatchObject({ quantity: 11, amount: 55 });
    expect(result.state).toEqual(original);
    expect(tiles()['tile-v1'].pricing!.unitPrice).toBe(40_000);
  });
  it('previews latest compatible pricing without changing visual version and resets quantity on a unit change', () => {
    const value = scene();
    const initial = calculateMaterialUsage(value, tiles());
    const state = setUsageQuantity(initial.state, initial.rows[0], 20);
    const latest = material({
      id: 'tile-v2',
      version: 2,
      pricing: { unit: 'm2', unitPrice: 1000, boxCoverageM2: null, piecesPerBox: null, wastePercent: 90 },
    });
    expect(describeLatestUsagePricing(initial.rows[0], latest)).toMatchObject({
      compatible: true,
      changed: true,
      unitChanged: true,
    });
    const next = applyLatestUsagePricing(state, initial.rows[0], latest);
    expect(next.assignments.back).toMatchObject({
      materialVersionId: 'tile-v1',
      pricing: { sourceVersionId: 'tile-v2' },
    });
    expect(calculateMaterialUsage(value, tiles(), next).rows[0]).toMatchObject({
      quantity: 12,
      quantityMode: 'auto',
      amount: 12000,
    });
    expect(value.surfaces[0].materialVersionId).toBe('tile-v1');
  });
  it('rejects latest pricing when dimensions, model, category or product changed', () => {
    const result = calculateMaterialUsage(scene(), tiles());
    for (const patch of [
      { widthMm: 300 },
      { code: 'OTHER' },
      { category: 'toilet' as const },
      { materialId: 'different' },
    ]) {
      const latest = material({ id: 'tile-v2', ...patch });
      expect(describeLatestUsagePricing(result.rows[0], latest).compatible).toBe(false);
      expect(() => applyLatestUsagePricing(result.state, result.rows[0], latest)).toThrow();
    }
  });
  it('keeps manual quantities when two commercial rows merge after repricing', () => {
    const value = scene([surface('left', { roomFace: 'left' }), surface('right', { roomFace: 'right' })]);
    let state = ensureMaterialUsage(value, tiles());
    state.assignments.right.pricing.unitPrice = 50_000;
    let rows = calculateMaterialUsage(value, tiles(), state).rows;
    state = setUsageQuantity(state, rows[0], 8);
    state = setUsageQuantity(state, rows[1], 9);
    state = setUsagePricing(state, rows[1], { unitPrice: 40_000 });
    rows = calculateMaterialUsage(value, tiles(), state).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      quantity: 17,
      quantityMode: 'manual',
      automaticQuantity: 9,
      amount: 680_000,
    });
    state = setUsageQuantity(state, rows[0], 'auto');
    expect(calculateMaterialUsage(value, tiles(), state).rows[0].quantity).toBe(9);
  });
  it('requires review if a legacy manual order cannot be split across new price groups', () => {
    const value = scene([surface('left', { roomFace: 'left' }), surface('right', { roomFace: 'right' })]);
    const result = calculateMaterialUsage(value, tiles());
    const state = setUsageQuantity(result.state, result.rows[0], 20);
    state.assignments.right.pricing.unitPrice = 1;
    const split = calculateMaterialUsage(value, tiles(), state);
    expect(split.rows.every((row) => row.quantityMode === 'manual' && row.quantity === null)).toBe(true);
    expect(split.unresolvedCount).toBe(2);
  });
  it('remaps all mutable references and manual ordering without copying immutable version IDs', () => {
    const value = scene();
    const initial = calculateMaterialUsage(value, tiles());
    let state = setUsageArea(initial.state, 'back', 7);
    state = setUsageQuantity(state, initial.rows[0], 8);
    const copy = remapMaterialUsage(
      state,
      (id) => `${id}-copy`,
      (id) => `${id}-copy`,
    );
    copy.assignments['back-copy'].pricing.unitPrice = 3;
    expect(state.assignments.back.pricing.unitPrice).toBe(40_000);
    expect(copy.assignments['back-copy'].materialVersionId).toBe('tile-v1');
    const copiedScene = scene([surface('back-copy')]);
    expect(calculateMaterialUsage(copiedScene, tiles(), copy).rows[0]).toMatchObject({
      areaM2: 7,
      quantity: 8,
      amount: 24,
    });
  });
});

describe('precise one-time quote migration', () => {
  it('migrates exactly linked manual tile area, purchase quantity and price, preserving the source quote', () => {
    const value = scene();
    const catalog = tiles();
    const quote = createQuote(project(value), catalog);
    Object.assign(quote.lines[0], {
      areaSource: 'manual',
      areaM2: 10,
      quantityMode: 'manual',
      quantity: 12,
      unitPrice: 30000,
    });
    quote.taxRate = 10;
    quote.discount = 5000;
    const original = structuredClone(quote);
    const result = calculateMaterialUsage(value, catalog, undefined, quote);
    expect(result.rows[0]).toMatchObject({ areaM2: 10, quantity: 12, amount: 360_000 });
    expect(quote).toEqual(original);
    expect(result.state.migratedQuoteId).toBe(quote.id);
    quote.lines[0].unitPrice = 1;
    expect(calculateMaterialUsage(value, catalog, result.state, quote).total).toBe(360_000);
  });
  it('does not bring automatic waste quantities or old taxes into material totals', () => {
    const value = scene();
    const quote = createQuote(project(value), tiles());
    quote.taxRate = 20;
    quote.lines[0].quantity = 500;
    quote.lines[0].wastePercent = 99;
    expect(calculateMaterialUsage(value, tiles(), undefined, quote).total).toBe(360_000);
  });
  it('counts placed products instead of importing a manual legacy purchasing quantity', () => {
    const value = scene([], [fixture('a'), fixture('b')]);
    const catalog = products();
    const quote = createQuote(project(value), catalog);
    quote.lines[0].quantity = 100;
    quote.lines[0].unitPrice = 200;
    expect(calculateMaterialUsage(value, catalog, undefined, quote).rows[0]).toMatchObject({
      count: 2,
      quantity: 2,
      amount: 400,
    });
  });
  it('does not migrate mismatched selling units or ambiguous source links', () => {
    const value = scene();
    const quote = createQuote(project(value), tiles());
    quote.lines[0].unit = 'piece';
    quote.lines[0].unitPrice = 1;
    expect(calculateMaterialUsage(value, tiles(), undefined, quote).total).toBe(360_000);
    quote.lines[0].unit = 'box';
    quote.lines[0].sourceSurfaceIds = ['deleted'];
    expect(calculateMaterialUsage(value, tiles(), undefined, quote).total).toBe(360_000);
  });
  it('does not take fixture commercial values from a stale source signature', () => {
    const value = scene([], [fixture('a')]);
    const catalog = products();
    const quote = createQuote(project(value), catalog);
    quote.lines[0].unitPrice = 1;
    value.fixtures.push(fixture('b'));
    expect(calculateMaterialUsage(value, catalog, undefined, quote).total).toBe(250_000);
  });
  it('requires confirmation of the other faces when replacing a legacy aggregate with individual areas', () => {
    const value = scene([surface('left', { roomFace: 'left' }), surface('right', { roomFace: 'right' })]);
    const quote = createQuote(project(value), tiles());
    Object.assign(quote.lines[0], { areaSource: 'manual', areaM2: 10 });
    const migrated = ensureMaterialUsage(value, tiles(), undefined, quote);
    const state = setUsageArea(migrated, 'left', 3);
    expect(state.areas.right).toEqual({ mode: 'manual', areaM2: null });
    expect(calculateMaterialUsage(value, tiles(), state).rows[0].areaM2).toBeNull();
    expect(calculateMaterialUsage(value, tiles(), setUsageArea(state, 'right', 'room')).rows[0].areaM2).toBe(
      9,
    );
  });
  it('retains a multi-face manual total without inventing per-face areas, and requires review after membership changes', () => {
    const value = scene([surface('left', { roomFace: 'left' }), surface('right', { roomFace: 'right' })]);
    const quote = createQuote(project(value), tiles());
    Object.assign(quote.lines[0], { areaSource: 'manual', areaM2: 10 });
    const result = calculateMaterialUsage(value, tiles(), undefined, quote);
    expect(result.rows[0]).toMatchObject({ areaM2: 10, quantity: 7, amount: 280_000 });
    expect(result.rows[0].areas.every((a) => a.source === 'legacy-total' && a.areaM2 === null)).toBe(true);
    expect(result.state.areas).toEqual({});
    value.surfaces.pop();
    expect(calculateMaterialUsage(value, tiles(), result.state)).toMatchObject({
      attentionCount: 1,
      complete: false,
    });
    const copy = remapMaterialUsage(
      result.state,
      (id) => `${id}-new`,
      (id) => id,
    );
    expect(copy.aggregateAreas[0].surfaceIds).toEqual(['left-new', 'right-new']);
  });
});
