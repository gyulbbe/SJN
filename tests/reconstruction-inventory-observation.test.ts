import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fixtureInventoryJsonSchema,
  fixtureInventoryV1JsonSchema,
  parseFixtureInventoryV1,
  INVENTORY_OUTPUT_CONTRACT,
  INVENTORY_V1_OUTPUT_CONTRACT,
  isFixtureInventoryOutputContract,
  FIXTURE_INVENTORY_PROMPT,
  parseFixtureInventory,
} from '../src/lib/reconstruction/inventory-observation';

const basin = () => ({
  kind: 'basin',
  bbox_2d: [200, 300, 600, 550],
  view: 'direct',
  basin: { shape: 'rectangular', support: 'pedestal', bowls: 1 },
  note: 'visible narrow support',
});
const parse = (items: unknown[]) => parseFixtureInventory(JSON.stringify({ items }));

describe('compact fixture observations (structural unit tests, not model accuracy)', () => {
  it('separates observed support from rule-derived mounting and leaves camera unknown', () => {
    const raw = JSON.stringify({ items: [basin()] });
    const { inventory, understanding } = parseFixtureInventory(raw);
    expect(inventory.items[0].bbox_2d).toEqual([200, 300, 600, 550]);
    expect(understanding.candidates[0]).toMatchObject({
      id: 'item_01',
      kind: 'basin',
      basinStyle: 'pedestal',
      shape: 'rectangular',
      mounting: 'floor',
      wall: 'unknown',
      bowlCount: 1,
      provenance: { kind: 'model', shape: 'model', mounting: 'geometry', position: 'default' },
    });
    expect(understanding.candidates[0].bounds).toEqual({ left: 0.2, top: 0.3, right: 0.6, bottom: 0.55 });
    expect(understanding.candidates[0].anchor).toBeUndefined();
    expect(understanding.roomLayout).toMatchObject({
      orthogonal: 'unknown',
      backWallQuad: null,
      lines: [],
      corners: [],
    });
    expect(JSON.parse(raw)).toEqual({ items: [basin()] });
  });
  it('does not confuse unknown depth with a reflected image', () => {
    const item = basin();
    item.note = 'depth unknown';
    item.basin = { shape: 'round', support: 'wall', bowls: 1 };
    expect(parse([item]).understanding.candidates[0]).toMatchObject({
      reflection: 'physical',
      basinStyle: 'wall',
      shape: 'round',
      mounting: 'wall',
      wall: 'unknown',
    });
  });
  it('keeps a two-bowl cabinet assembly as one fixture without inventing its floor support', () => {
    const item = basin();
    item.basin = { shape: 'round', support: 'cabinet', bowls: 2 };
    const result = parse([item]).understanding;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ basinStyle: 'vanity', mounting: 'unknown', bowlCount: 2 });
    expect(result.candidates[0].validation).toBeUndefined();
    expect(result.relations).toEqual([]);
  });
  it('maps a cabinet with basin attributes to the supported vanity model without adding a pedestal field', () => {
    const item = { ...basin(), kind: 'vanity', basin: { shape: 'round', support: 'cabinet', bowls: 2 } };
    const result = parse([item]).understanding;
    expect(result.candidates[0]).toMatchObject({
      kind: 'vanity',
      basinStyle: 'unknown',
      shape: 'round',
      bowlCount: 2,
      mounting: 'unknown',
    });
    expect(result.candidates[0].validation).toBeUndefined();
    expect(result.relations).toEqual([]);
  });
  it('does not infer two bowls from a wide unknown-count observation', () => {
    const item = {
      ...basin(),
      bbox_2d: [50, 300, 950, 700],
      basin: { shape: 'round', support: 'cabinet', bowls: null },
    };
    expect(parse([item]).understanding.candidates[0].bowlCount).toBeUndefined();
  });
  it('distinguishes a direct mirror panel, a mirror copy and an unresolved reflection', () => {
    const items = ['direct', 'mirror_image', 'unclear'].map((view) => ({
      kind: 'mirror',
      bbox_2d: [100, 100, 400, 400],
      view,
      basin: null,
      note: '',
    }));
    expect(parse(items).understanding.candidates.map((c) => c.reflection)).toEqual([
      'physical',
      'reflected',
      'uncertain',
    ]);
  });
  it('quarantines unrelated basin attributes without losing another valid observation', () => {
    const result = parse([{ ...basin(), kind: 'toilet' }, basin()]).understanding;
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].validation?.issues.map((x) => x.code)).toContain('non-basin-support');
    expect(result.candidates[1].validation).toBeUndefined();
  });
  it('uses stable application IDs without deduplicating different original observations', () => {
    const items = [basin(), basin()];
    const a = parse(items),
      b = parse(items);
    expect(a.understanding.candidates.map((c) => c.id)).toEqual(['item_01', 'item_02']);
    expect(a).toEqual(b);
    expect(a.inventory.items).toHaveLength(2);
  });
  it('preserves reversed in-range bounds as a held semantic observation', () => {
    const result = parse([{ ...basin(), bbox_2d: [700, 300, 200, 550] }, basin()]).understanding;
    expect(result.candidates[0].validation?.issues.map((x) => x.code)).toContain('bounds-order');
    expect(result.candidates[1].validation).toBeUndefined();
  });
  it.each(['{', '{"items":[]', '{"items":[{"kind":"script"}]}', '{"items":[],"code":"run"}'])(
    'does not repair malformed or unsupported structure: %s',
    (text) => {
      expect(() => parseFixtureInventory(text)).toThrow();
    },
  );
  it('validates numeric ranges, length and maximum item count', () => {
    expect(() => parse([{ ...basin(), bbox_2d: [-100, 200, 500, 600] }])).toThrow();
    expect(() => parse([{ ...basin(), bbox_2d: [100, 200, 500] }])).toThrow();
    expect(() => parse(Array.from({ length: 25 }, basin))).toThrow();
    expect(() => parseFixtureInventory(' '.repeat(150001))).toThrow();
  });
  it('treats photo instructions and executable-looking notes only as untrusted text', () => {
    const note = '<script>deleteEverything()</script>';
    const result = parse([{ ...basin(), note }]);
    expect(result.inventory.items[0].note).toBe(note);
    expect(result.understanding.candidates[0].evidence).toEqual([note]);
  });
  it('uses the runtime-compatible fixed-length numeric array grammar', () => {
    const schema = fixtureInventoryJsonSchema as unknown as {
      properties: { items: { items: { properties: { bbox_2d: unknown } } } };
    };
    expect(schema.properties.items.items.properties.bbox_2d).toMatchObject({
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: { type: 'integer', minimum: 0, maximum: 1000 },
    });
  });
});

describe('explicit versioned coordinate contracts', () => {
  const legacy = () => {
    const { bbox_2d, ...item } = basin();
    return { ...item, bbox: bbox_2d.map((value) => value / 1000) };
  };
  it('keeps normalized v1 wire data unchanged and yields the same canonical coordinates', () => {
    const raw = JSON.stringify({ items: [legacy()] });
    const before = JSON.parse(raw);
    const v1 = parseFixtureInventory(raw, INVENTORY_V1_OUTPUT_CONTRACT);
    expect(parseFixtureInventoryV1(raw)).toEqual(v1);
    expect(v1.inventory).toEqual(before);
    expect(v1.understanding).toEqual(parse([basin()]).understanding);
    expect(JSON.parse(raw)).toEqual(before);
  });
  it('divides small v2 integers exactly once instead of treating them as normalized coordinates', () => {
    const raw = JSON.stringify({ items: [{ ...basin(), bbox_2d: [0, 0, 1, 1] }] });
    const result = parseFixtureInventory(raw);
    expect(result.inventory.items[0].bbox_2d).toEqual([0, 0, 1, 1]);
    expect(result.understanding.candidates[0].bounds).toEqual({
      left: 0,
      top: 0,
      right: 0.001,
      bottom: 0.001,
    });
    expect(parseFixtureInventory(raw).understanding).toEqual(result.understanding);
  });
  it.each([0.5, -1, 1001, '100', null])(
    'rejects invalid v2 coordinates %s without rounding or coercion',
    (value) => {
      expect(() => parse([{ ...basin(), bbox_2d: [0, 0, value, 1000] }])).toThrow();
    },
  );
  it('requires the declared version field names and ranges, even when the other version is valid', () => {
    const current = JSON.stringify({ items: [basin()] }),
      old = JSON.stringify({ items: [legacy()] });
    expect(() => parseFixtureInventory(old)).toThrow();
    expect(() => parseFixtureInventory(current, INVENTORY_V1_OUTPUT_CONTRACT)).toThrow();
    expect(() =>
      parseFixtureInventoryV1(JSON.stringify({ items: [{ ...legacy(), bbox: [0, 0, 1000, 1000] }] })),
    ).toThrow();
    expect(() => parse([{ ...basin(), bbox: [0, 0, 1, 1] }])).toThrow();
  });
  it('validates unknown contracts at runtime without falling through to either parser', () => {
    expect(INVENTORY_OUTPUT_CONTRACT).toBe('fixture-inventory-v2');
    for (const contract of ['future', '', null, 3]) {
      expect(isFixtureInventoryOutputContract(contract)).toBe(false);
      // Deliberately exercise the untyped transport boundary.
      expect(() => Reflect.apply(parseFixtureInventory, null, ['{"items":[]}', contract])).toThrow();
    }
  });
  it('pins the exact C3 prompt/schema and maintains a different explicit legacy wire grammar', () => {
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(sha(FIXTURE_INVENTORY_PROMPT)).toBe(
      'e83b80c43a117531c1451defbf346fbbce2241fdf2fe09ce36457ea59d86a35f',
    );
    expect(sha(JSON.stringify(fixtureInventoryJsonSchema))).toBe(
      'e930fdb511cf09f17ecbe7f622f2e4f2dcd2a79a893811a0d7aa4831bb9a8d57',
    );
    expect(JSON.stringify(fixtureInventoryV1JsonSchema)).toContain('"bbox"');
    expect(JSON.stringify(fixtureInventoryV1JsonSchema)).not.toContain('"bbox_2d"');
  });
});
