import { describe, expect, it } from 'vitest';
import {
  EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  INVENTORY_OUTPUT_CONTRACT,
  extendedFixtureInventoryJsonSchema,
  fixtureInventoryJsonSchema,
  parseFixtureInventory,
} from '../src/lib/reconstruction/inventory-observation';

const observation = (kind: string) => ({
  kind,
  bbox_2d: [100, 200, 700, 800],
  view: 'direct',
  basin: null as null | { shape: string; support: string; bowls: number },
  note: 'Visible fixture',
});

describe('extended fixture contract (parser checks, not AI accuracy)', () => {
  it.each(['shower', 'wallCabinet', 'lowPartition'])(
    'accepts %s only in the explicit extended contract',
    (kind) => {
      const raw = JSON.stringify({ items: [observation(kind)] });
      expect(() => parseFixtureInventory(raw, INVENTORY_OUTPUT_CONTRACT)).toThrow();
      const result = parseFixtureInventory(raw, EXTENDED_INVENTORY_OUTPUT_CONTRACT);
      expect(result.understanding.candidates[0]).toMatchObject({ kind, reflection: 'physical' });
      expect(result.inventory).toEqual(JSON.parse(raw));
      expect(fixtureInventoryJsonSchema.properties.items.items.properties.kind.enum).not.toContain(kind);
      expect(extendedFixtureInventoryJsonSchema.properties.items.items.properties.kind.enum).toContain(kind);
    },
  );

  it('keeps irrelevant basin fields in raw data without excluding a bath from the new canonical inventory', () => {
    const item = { ...observation('bath'), basin: { shape: 'rectangular', support: 'wall', bowls: 1 } };
    const raw = JSON.stringify({ items: [item] });
    const historical = parseFixtureInventory(raw, INVENTORY_OUTPUT_CONTRACT);
    const extended = parseFixtureInventory(raw, EXTENDED_INVENTORY_OUTPUT_CONTRACT);
    expect(historical.understanding.candidates[0].basinStyle).toBe('wall');
    expect(extended.understanding.candidates[0]).toMatchObject({
      kind: 'bath',
      basinStyle: 'unknown',
      shape: 'unknown',
    });
    expect(extended.understanding.candidates[0].uncertainty.join(' ')).toContain('원응답은 보존');
    expect(extended.inventory).toEqual(JSON.parse(raw));
    expect(historical.inventory).toEqual(extended.inventory);
  });

  it('preserves real basin and vanity assembly fields, including two visible bowls', () => {
    const items = ['basin', 'vanity'].map((kind) => ({
      ...observation(kind),
      basin: { shape: 'round', support: 'cabinet', bowls: 2 },
    }));
    const result = parseFixtureInventory(JSON.stringify({ items }), EXTENDED_INVENTORY_OUTPUT_CONTRACT);
    expect(result.understanding.candidates.map((c) => [c.kind, c.shape, c.bowlCount])).toEqual([
      ['basin', 'round', 2],
      ['vanity', 'round', 2],
    ]);
  });
});
