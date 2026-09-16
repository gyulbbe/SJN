import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLOUD_GEMMA_GROUPED_INVENTORY_CONTRACT,
  CLOUD_GEMMA_GROUPED_INVENTORY_METADATA,
  CLOUD_GEMMA_INVENTORY_GROUPS,
  cloudGemmaGroupedInventoryJsonSchema,
  cloudGemmaGroupedInventoryPrompt,
  flattenCloudGemmaGroupedInventory,
} from '../src/lib/reconstruction/cloud-gemma-inventory';
import {
  normalizeCloudGemmaOutput,
  parseCloudGemmaExtendedInventory,
  prepareCloudGemmaSchema,
} from '../src/lib/reconstruction/cloud-gemma-coordinates';
import {
  EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  EXTENDED_INVENTORY_PROMPT_REVISION,
  parseFixtureInventory,
} from '../src/lib/reconstruction/inventory-observation';
const empty = () =>
  ({ sanitary: [], mirrors_storage: [], partitions: [], showers_shelves: [], openings: [] }) as Record<
    string,
    unknown[]
  >;
const item = (kind = 'shower') => ({
  kind,
  bbox_2d: [120, 230, 740, 830],
  view: 'direct',
  basin: null,
  note: 'Synthetic visible fixture',
});
const response = (value: unknown) => ({
  ...CLOUD_GEMMA_GROUPED_INVENTORY_METADATA,
  outputContract: EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  promptRevision: EXTENDED_INVENTORY_PROMPT_REVISION,
  rawText: JSON.stringify(value),
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

describe('named Gemma grouped inventory contract (synthetic inputs; no model calls)', () => {
  it('retains the exact common prompt and schema bytes exercised by the four-photo experiment', () => {
    const schema = prepareCloudGemmaSchema(cloudGemmaGroupedInventoryJsonSchema());
    expect(digest(JSON.stringify(schema))).toBe(
      '1442315dc7799910509fd9977b2cb8bccbb98e4f56d2f737bc6a6564269fb97b',
    );
    expect(digest(cloudGemmaGroupedInventoryPrompt(schema))).toBe(
      '9790fdecf164364a47c5f77f7933896d4cf5fb2c91a6b38f9ee3660705b3f9c4',
    );
    expect(schema.required).toEqual(CLOUD_GEMMA_INVENTORY_GROUPS);
    expect(schema.properties.sanitary).toEqual(schema.properties.partitions);
  });
  it('accepts all empty groups without inventing a candidate', () => {
    expect(parseCloudGemmaExtendedInventory(response(empty())).understanding.candidates).toEqual([]);
  });
  it('concatenates fixed groups, retains repeated observations, and changes only the native coordinate representation', () => {
    const value = empty();
    value.sanitary.push(item('toilet'));
    value.mirrors_storage.push(item('mirror'));
    value.showers_shelves.push(item(), item());
    const source = '\n' + JSON.stringify(value) + '\n',
      frozen = source;
    const native = flattenCloudGemmaGroupedInventory(source);
    expect(native.items.map((x) => x.kind)).toEqual(['toilet', 'mirror', 'shower', 'shower']);
    expect(native.items).toHaveLength(4);
    const normalized = JSON.parse(
      normalizeCloudGemmaOutput(source, 'inventory-extended', CLOUD_GEMMA_GROUPED_INVENTORY_CONTRACT),
    );
    expect(normalized.items[0]).toEqual({ ...item('toilet'), bbox_2d: [230, 120, 830, 740] });
    expect(source).toBe(frozen);
    expect(parseCloudGemmaExtendedInventory(response(value)).understanding.candidates[0].bounds).toEqual({
      left: 0.23,
      top: 0.12,
      right: 0.83,
      bottom: 0.74,
    });
  });
  it('requires the named protocol instead of guessing from raw text shape', () => {
    expect(() => normalizeCloudGemmaOutput(JSON.stringify(empty()), 'inventory-extended')).toThrow();
    expect(() =>
      normalizeCloudGemmaOutput('{"items":[]}', 'inventory-extended', CLOUD_GEMMA_GROUPED_INVENTORY_CONTRACT),
    ).toThrow();
    expect(() =>
      normalizeCloudGemmaOutput(JSON.stringify(empty()), 'inventory-extended', 'unknown-protocol'),
    ).toThrow();
    expect(() =>
      normalizeCloudGemmaOutput(JSON.stringify(empty()), 'inventory', CLOUD_GEMMA_GROUPED_INVENTORY_CONTRACT),
    ).toThrow();
    expect(
      parseFixtureInventory('{"items":[]}', EXTENDED_INVENTORY_OUTPUT_CONTRACT).understanding.candidates,
    ).toEqual([]);
  });
  it.each(['missing', 'extra', 'wrong-array', 'item-extra', 'wrong-kind'])(
    'rejects strict envelope/item %s violations',
    (mutation) => {
      const value = empty();
      if (mutation === 'missing') delete value.openings;
      if (mutation === 'extra') value.invented = [];
      if (mutation === 'wrong-array') Object.assign(value, { openings: {} });
      if (mutation === 'item-extra') value.openings.push({ ...item(), extra: true });
      if (mutation === 'wrong-kind') value.openings.push(item('expected-fixture'));
      expect(() => flattenCloudGemmaGroupedInventory(JSON.stringify(value))).toThrow();
    },
  );
  it.each([
    [120, 230, 120, 830],
    [740, 230, 120, 830],
    [120, 830, 740, 230],
    [0, 0, 1001, 900],
    [0, 0, 1.5, 2],
  ])('rejects invalid native bounds before flattening: %j', (...bbox) => {
    const value = empty();
    value.sanitary.push({ ...item(), bbox_2d: bbox });
    expect(() => flattenCloudGemmaGroupedInventory(JSON.stringify(value))).toThrow();
  });
  it('allows exactly 24 total rows but rejects 25 across groups without truncation', () => {
    const value = empty();
    value.sanitary = Array.from({ length: 12 }, () => item());
    value.openings = Array.from({ length: 12 }, () => item());
    expect(flattenCloudGemmaGroupedInventory(JSON.stringify(value)).items).toHaveLength(24);
    value.showers_shelves.push(item());
    expect(() => flattenCloudGemmaGroupedInventory(JSON.stringify(value))).toThrow();
    expect(value.showers_shelves).toHaveLength(1);
  });
  it.each(['providerInventoryContract', 'providerInventorySchemaRevision', 'providerInventoryTransform'])(
    'rejects missing/obsolete %s metadata',
    (key) => {
      const source = response(empty()) as Record<string, unknown>;
      delete source[key];
      expect(() => parseCloudGemmaExtendedInventory(source as ReturnType<typeof response>)).toThrow();
      source[key] = 'obsolete';
      expect(() => parseCloudGemmaExtendedInventory(source as ReturnType<typeof response>)).toThrow();
    },
  );
});
