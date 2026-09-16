import { describe, expect, it } from 'vitest';
import {
  CLOUD_GEMMA_COORDINATE_CONTRACT,
  normalizeCloudGemmaOutput,
  prepareCloudGemmaPrompt,
  prepareCloudGemmaSchema,
} from '../src/lib/reconstruction/cloud-gemma-coordinates';
import {
  EXTENDED_FIXTURE_INVENTORY_PROMPT,
  EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  FIXTURE_INVENTORY_PROMPT,
  extendedFixtureInventoryJsonSchema,
  parseFixtureInventory,
} from '../src/lib/reconstruction/inventory-observation';
import { identityObservationPrompt } from '../src/lib/reconstruction/identity-observation';
import { installationObservationPrompt } from '../src/lib/reconstruction/installation-observation';
import { layoutObservationPrompt } from '../src/lib/reconstruction/layout-observation';
import {
  fixtureAppearancePrompt,
  fixtureAppearanceJsonSchemaFor,
} from '../src/lib/reconstruction/fixture-appearance-observation';
import {
  showerObservationPrompt,
  showerObservationJsonSchemaFor,
} from '../src/lib/reconstruction/shower-observation';
import { dividerObservationPrompt } from '../src/lib/reconstruction/divider-observation';
import { targetExistencePrompt } from '../src/lib/reconstruction/target-existence-observation';
import type { CloudGemmaOperation } from '../src/lib/reconstruction/cloud-gemma-contract';

// Synthetic asymmetric regions; no evaluation photos, filenames, or photo-specific corrections.
const xyxy = [110, 230, 570, 890];
const yxyx = [230, 110, 890, 570];
const items = ['basin', 'shower', 'glassPartition'].map((kind) => ({
  kind,
  bbox_2d: [...xyxy],
  view: 'direct',
  basin: kind === 'basin' ? { shape: 'rectangular', support: 'wall', bowls: 1 } : null,
  note: 'Synthetic fixture observation',
}));
const inventory = parseFixtureInventory(
  JSON.stringify({ items }),
  EXTENDED_INVENTORY_OUTPUT_CONTRACT,
).understanding;
const boxes = inventory.candidates.map(({ id, bounds }) => ({ id, bounds }));

describe('explicit Gemma bounding-box boundary', () => {
  it.each(['inventory', 'inventory-extended'] as const)(
    'normalizes only %s item boxes into the unchanged Qwen parser',
    (operation) => {
      const native = JSON.stringify({ items: items.map((item) => ({ ...item, bbox_2d: yxyx })) });
      const before = native;
      const normalized = normalizeCloudGemmaOutput(native, operation);
      const parsed = parseFixtureInventory(normalized, EXTENDED_INVENTORY_OUTPUT_CONTRACT);
      expect(parsed.understanding.candidates[0].bounds).toEqual({
        left: 0.11,
        top: 0.23,
        right: 0.57,
        bottom: 0.89,
      });
      expect(native).toBe(before);
      expect(JSON.parse(native).items[0].bbox_2d).toEqual(yxyx);
      expect(JSON.parse(normalized).items[0].bbox_2d).toEqual(xyxy);
    },
  );

  it('does not guess or repair axes in historical Qwen inventory', () => {
    expect(
      parseFixtureInventory(JSON.stringify({ items }), EXTENDED_INVENTORY_OUTPUT_CONTRACT).understanding
        .candidates[0].bounds,
    ).toEqual({ left: 0.11, top: 0.23, right: 0.57, bottom: 0.89 });
  });

  it('never changes arbitrary arrays, named points, named bounds, or quoted coordinate text', () => {
    const raw = JSON.stringify({
      items: [
        {
          ...items[0],
          bbox_2d: yxyx,
          point: { x: 0.12, y: 0.34 },
          bounds: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 },
          other: [1, 2, 3, 4],
          note: 'literal "bbox_2d":[1,2,3,4]',
        },
      ],
    });
    const result = JSON.parse(normalizeCloudGemmaOutput(raw, 'inventory-extended'));
    expect(result.items[0]).toEqual({ ...JSON.parse(raw).items[0], bbox_2d: xyxy });
    const prompt = `Objects: ${JSON.stringify([{ bbox_2d: xyxy, point: { x: 0.12, y: 0.34 }, other: [1, 2, 3, 4], note: 'literal "bbox_2d":[1,2,3,4]' }])}`;
    const prepared = prepareCloudGemmaPrompt(prompt, 'identity');
    expect(prepared).toContain('"bbox_2d":[230,110,890,570]');
    expect(prepared).toContain('"point":{"x":0.12,"y":0.34}');
    expect(prepared).toContain('"other":[1,2,3,4]');
    expect(prepared).toContain(JSON.stringify('literal "bbox_2d":[1,2,3,4]'));
  });

  it.each([
    ['identity', identityObservationPrompt(inventory)],
    ['installation', installationObservationPrompt(inventory)],
    ['layout', layoutObservationPrompt(inventory)],
    ['target-existence', targetExistencePrompt(boxes[0].id, boxes)],
  ] satisfies [CloudGemmaOperation, string][])(
    'encodes only supplied box arrays in %s prompts',
    (operation, prompt) => {
      expect(prompt).toContain('"bbox_2d":[110,230,570,890]');
      const prepared = prepareCloudGemmaPrompt(prompt, operation);
      expect(prepared).toContain('"bbox_2d":[230,110,890,570]');
      expect(prepared).not.toContain('"bbox_2d":[110,230,570,890]');
      expect(prepared).not.toContain('[left,top,right,bottom]');
      expect(prepared).toContain(CLOUD_GEMMA_COORDINATE_CONTRACT);
      expect(prepareCloudGemmaPrompt(prepared, operation)).toBe(prepared);
    },
  );

  it.each([
    ['inventory', FIXTURE_INVENTORY_PROMPT],
    ['inventory-extended', EXTENDED_FIXTURE_INVENTORY_PROMPT],
  ] satisfies [CloudGemmaOperation, string][])(
    'declares the native %s output convention in both prompt and embedded schema',
    (operation, prompt) => {
      const prepared = prepareCloudGemmaPrompt(prompt, operation);
      expect(prepared).toContain('bbox_2d=[ymin,xmin,ymax,xmax]');
      expect(prepared).not.toContain('bbox_2d=[left,top,right,bottom]');
      expect(prepared).toContain('"description":"Gemma bbox_2d: [ymin,xmin,ymax,xmax]');
      expect(prompt).toContain('bbox_2d=[left,top,right,bottom]');
    },
  );

  it.each([
    ['shower-detail', showerObservationPrompt(inventory)],
    ['divider-material', dividerObservationPrompt([{ id: boxes[2].id, bounds: boxes[2].bounds }])],
  ] satisfies [CloudGemmaOperation, string][])(
    'preserves unambiguous named bounds in %s prompts',
    (operation, prompt) => {
      expect(prepareCloudGemmaPrompt(prompt, operation)).toBe(prompt);
      expect(prompt).toContain('"left":0.11,"top":0.23,"right":0.57,"bottom":0.89');
    },
  );

  it('adds the required appearance envelope once while preserving all original evidence and named bounds', () => {
    const prompt = fixtureAppearancePrompt(inventory);
    const prepared = prepareCloudGemmaPrompt(prompt, 'appearance');
    expect(prompt).not.toContain('schemaVersion');
    expect(prepared.startsWith(prompt + '\n')).toBe(true);
    expect(prepared).toContain('"left":0.11,"top":0.23,"right":0.57,"bottom":0.89');
    expect(prepared).not.toContain(CLOUD_GEMMA_COORDINATE_CONTRACT);
    const envelope = prepared.slice(prompt.length);
    expect(envelope).toContain('root JSON object');
    expect(envelope).toContain('schemaVersion equal to the number 1');
    expect(envelope).toContain('observations containing exactly the provided IDs');
    expect(envelope).toContain('complete the root object and stop');
    expect(prepareCloudGemmaPrompt(prepared, 'appearance')).toBe(prepared);
    expect(fixtureAppearancePrompt(inventory)).toBe(prompt);
  });

  it.each([
    'identity',
    'installation',
    'layout',
    'appearance',
    'shower-detail',
    'divider-material',
    'target-existence',
  ] as const)('does not reinterpret the coordinate-free %s response', (operation) => {
    const untouched = ' { "observations":[], "point":{"x":0.1,"y":0.2}, "other":[1,2,3,4] } ';
    expect(normalizeCloudGemmaOutput(untouched, operation)).toBe(untouched);
  });

  it('annotates bbox_2d schema properties without mutating schema, changing scale, or touching points', () => {
    const original = structuredClone(extendedFixtureInventoryJsonSchema);
    const prepared = prepareCloudGemmaSchema(extendedFixtureInventoryJsonSchema);
    expect(prepared.properties.items.items.properties.bbox_2d).toEqual({
      ...original.properties.items.items.properties.bbox_2d,
      description: expect.stringContaining('[ymin,xmin,ymax,xmax]'),
    });
    expect(extendedFixtureInventoryJsonSchema).toEqual(original);
    const points = {
      type: 'object',
      properties: {
        point: { properties: { x: { type: 'number' }, y: { type: 'number' } } },
        arbitrary: { type: 'array', items: { type: 'number' } },
      },
    };
    expect(prepareCloudGemmaSchema(points)).toEqual(points);
  });

  it('encodes the actual untyped appearance constant as a typed singleton enum without mutating legacy schema', () => {
    // A provider-compatibility hypothesis, not proof of the cause of an upstream termination failure.
    const schema = fixtureAppearanceJsonSchemaFor(inventory);
    const original = structuredClone(schema);
    const prepared = prepareCloudGemmaSchema(schema);
    expect(schema.properties.schemaVersion).toEqual({ const: 1 });
    expect(prepared.properties.schemaVersion).toEqual({ type: 'integer', enum: [1] });
    expect(prepared).toEqual({
      ...original,
      properties: { ...original.properties, schemaVersion: { type: 'integer', enum: [1] } },
    });
    expect(schema).toEqual(original);
    expect(prepareCloudGemmaSchema(prepared)).toEqual(prepared);
  });

  it.each([
    { literal: 1, type: 'integer' },
    { literal: 0, type: 'integer' },
    { literal: -2, type: 'integer' },
    { literal: 1.25, type: 'number' },
    { literal: '1', type: 'string' },
    { literal: true, type: 'boolean' },
    { literal: false, type: 'boolean' },
    { literal: null, type: 'null' },
  ])('encodes untyped primitive const=$literal as a matching typed singleton enum', ({ literal, type }) => {
    const schema = { type: 'object', properties: { value: { const: literal } }, required: ['value'] };
    const original = structuredClone(schema);
    const prepared = prepareCloudGemmaSchema(schema);
    expect(prepared.properties.value).toEqual({ type, enum: [literal] });
    expect(schema).toEqual(original);
    expect(prepared.required).toEqual(original.required);
  });

  it('leaves typed constants and actual typed shower schema unchanged', () => {
    const typed = {
      anyOf: [
        { type: 'number', const: 1 },
        { type: 'integer', const: 2 },
        { type: 'string', const: '1' },
        { type: 'boolean', const: false },
        { type: 'null', const: null },
      ],
    };
    expect(prepareCloudGemmaSchema(typed)).toEqual(typed);
    const shower = showerObservationJsonSchemaFor(inventory);
    expect(shower.properties!.schemaVersion).toEqual({ type: 'number', const: 1 });
    expect(prepareCloudGemmaSchema(shower)).toEqual(shower);
    const inventorySchema = prepareCloudGemmaSchema(extendedFixtureInventoryJsonSchema);
    expect(inventorySchema.properties.items.items.properties.basin).toEqual(
      extendedFixtureInventoryJsonSchema.properties.items.items.properties.basin,
    );
  });

  it('does not invent types for composite constants', () => {
    const schema = { anyOf: [{ const: [1, 2] }, { const: { left: 1, top: 2 } }] };
    expect(prepareCloudGemmaSchema(schema)).toEqual(schema);
  });

  it.each([
    [1, 2, 3],
    [0, 0, 1001, 1000],
    [0, 0, 1.5, 2],
    ['0', 0, 1, 2],
  ])('rejects invalid box encoding %j without guessing a scale', (...box) => {
    expect(() =>
      normalizeCloudGemmaOutput(JSON.stringify({ items: [{ bbox_2d: box }] }), 'inventory-extended'),
    ).toThrow('four integer coordinates');
  });
});
