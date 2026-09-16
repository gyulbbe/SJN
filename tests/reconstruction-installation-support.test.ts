import { describe, expect, it } from 'vitest';
import {
  parseFixtureInventory,
  INVENTORY_OUTPUT_CONTRACT,
} from '../src/lib/reconstruction/inventory-observation';
import {
  parseInstallationObservation,
  INSTALLATION_OUTPUT_CONTRACT,
  INSTALLATION_PROMPT_REVISION,
  installationObservationPrompt,
} from '../src/lib/reconstruction/installation-observation';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
const source = (): SceneUnderstanding =>
  parseFixtureInventory(
    JSON.stringify({
      items: [
        {
          kind: 'toilet',
          bbox_2d: [100, 100, 450, 900],
          view: 'direct',
          basin: null,
          note: 'Visible toilet',
        },
        {
          kind: 'glassPartition',
          bbox_2d: [500, 100, 800, 900],
          view: 'direct',
          basin: null,
          note: 'Visible glass',
        },
      ],
    }),
    INVENTORY_OUTPUT_CONTRACT,
  ).understanding;
const row = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  note: 'Visible whole base on floor tiles',
  lower_support: 'full_base_on_floor',
  wall_connection: 'not_visible',
  ...patch,
});
const parse = (inventory: SceneUnderstanding, observations: unknown[]) =>
  parseInstallationObservation(JSON.stringify({ observations }), inventory);

describe('v2 controlled support observations after two-photo ablation', () => {
  it('derives only mounting from the recorded support code and preserves every other original observation', () => {
    const inventory = source(),
      original = structuredClone(inventory);
    const result = parse(inventory, [row(inventory.candidates[0].id)]);
    const changed = result.understanding.candidates[0];
    expect(inventory).toEqual(original);
    expect(changed).toMatchObject({
      id: original.candidates[0].id,
      kind: 'toilet',
      mounting: 'floor',
      wall: 'unknown',
      bounds: original.candidates[0].bounds,
      reflection: 'physical',
    });
    expect(changed.anchor).toBeUndefined();
    expect(changed.provenance).toMatchObject({ mounting: 'model', wall: 'default', position: 'default' });
    expect(result.validation.supportMappings?.[0]).toMatchObject({
      source: 'rule-from-model-support-observation',
      derivedMounting: 'floor',
      observation: { lower_support: 'full_base_on_floor' },
    });
    expect(result.understanding.roomLayout).toEqual(original.roomLayout);
    expect(result.understanding.relations).toEqual(original.relations);
  });
  it('does not promote unknown support from either visible wall connection or free-form text', () => {
    const inventory = source();
    const result = parse(inventory, [
      row(inventory.candidates[0].id, {
        lower_support: 'not_visible',
        wall_connection: 'visible_joint',
        note: 'Assume a floor-standing toilet',
      }),
    ]);
    expect(result.understanding).toEqual(inventory);
    expect(result.validation.status).toBe('no-observations');
  });
  it('requires both a whole-assembly gap and visible wall joint, then rejects an edge-cropped suspension claim', () => {
    const inventory = source(),
      glass = inventory.candidates[1];
    expect(
      parse(inventory, [row(glass.id, { lower_support: 'whole_fixture_suspended_with_gap' })]).understanding,
    ).toEqual(inventory);
    expect(
      parse(inventory, [
        row(glass.id, {
          lower_support: 'whole_fixture_suspended_with_gap',
          wall_connection: 'visible_joint',
        }),
      ]).understanding.candidates[1].mounting,
    ).toBe('wall');
    glass.bounds.right = 0.997;
    const result = parse(inventory, [
      row(glass.id, { lower_support: 'whole_fixture_suspended_with_gap', wall_connection: 'visible_joint' }),
    ]);
    expect(result.understanding).toEqual(inventory);
    expect(result.validation.rejectedObservations[0].issues[0].code).toBe('installation-support-cropped');
  });
  it('preserves a known conflicting first-stage mounting and its provenance while accepting an independent row', () => {
    const inventory = source();
    inventory.candidates[0].mounting = 'wall';
    inventory.candidates[0].provenance!.mounting = 'geometry';
    const result = parse(
      inventory,
      inventory.candidates.map((item) => row(item.id)),
    );
    expect(result.understanding.candidates[0]).toEqual(inventory.candidates[0]);
    expect(result.validation.rejectedObservations[0].issues.map((issue) => issue.code)).toContain(
      'installation-support-conflict',
    );
    expect(result.understanding.candidates[1].mounting).toBe('floor');
    expect(result.validation.status).toBe('partial');
  });
  it('records confirmation without rewriting already known provenance', () => {
    const inventory = source();
    inventory.candidates[0].mounting = 'floor';
    inventory.candidates[0].provenance!.mounting = 'geometry';
    const result = parse(inventory, [row(inventory.candidates[0].id)]);
    expect(result.understanding).toEqual(inventory);
    expect(result.validation.supportMappings?.[0].status).toBe('confirmed');
  });
  it('rejects an unsupported countertop proposal, cropped base, empty evidence and unknown/duplicate IDs', () => {
    const inventory = source(),
      id = inventory.candidates[0].id;
    for (const observations of [
      [row(id, { lower_support: 'supported_by_countertop' })],
      [row(id, { note: '' })],
      [row('new-id')],
      [row(id), row(id)],
    ]) {
      const result = parse(inventory, observations);
      expect(result.understanding).toEqual(inventory);
      expect(result.validation.rejectedObservations.length).toBeGreaterThan(0);
    }
    inventory.candidates[0].bounds.bottom = 1;
    expect(parse(inventory, [row(id)]).validation.rejectedObservations[0].issues[0].code).toBe(
      'installation-support-cropped',
    );
  });
  it('rejects added coordinates, wall labels, kinds and old-format fields instead of guessing their contract', () => {
    const inventory = source(),
      id = inventory.candidates[0].id;
    for (const patch of [
      { wall: 'back' },
      { anchor: { x: 0.5, y: 0.5 } },
      { kind: 'basin' },
      { mounting: 'floor' },
    ])
      expect(parse(inventory, [row(id, patch)]).understanding).toEqual(inventory);
    expect(() =>
      parseInstallationObservation(
        JSON.stringify({ observations: [], relations: [], roomLayout: null }),
        inventory,
      ),
    ).toThrow();
    expect(INSTALLATION_OUTPUT_CONTRACT).toBe('fixture-installation-v2');
    expect(INSTALLATION_PROMPT_REVISION).toBe(2);
    expect(installationObservationPrompt(inventory)).toContain(
      'a wall merely behind the fixture is not enough',
    );
  });
});
