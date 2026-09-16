import { describe, expect, it } from 'vitest';
import {
  parseFixtureInventory,
  INVENTORY_OUTPUT_CONTRACT,
} from '../src/lib/reconstruction/inventory-observation';
import {
  parseInstallationObservation,
  installationObservationV1Prompt,
  INSTALLATION_V1_OUTPUT_CONTRACT,
  validateInstallationInventory,
  skippedInstallationAnalysis,
} from '../src/lib/reconstruction/installation-observation';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';

export function inventory(): SceneUnderstanding {
  return parseFixtureInventory(
    JSON.stringify({
      items: [
        {
          kind: 'toilet',
          bbox_2d: [100, 200, 400, 900],
          view: 'direct',
          basin: null,
          note: 'Visible toilet',
        },
        {
          kind: 'glassPartition',
          bbox_2d: [500, 100, 800, 950],
          view: 'direct',
          basin: null,
          note: 'Glass edge',
        },
      ],
    }),
    INVENTORY_OUTPUT_CONTRACT,
  ).understanding;
}
const emptyObservation = (id: string) => ({
  id,
  mounting: null,
  wall: null,
  reflection: null,
  anchor: null,
  uncertainty: [],
});
const run = (
  source: SceneUnderstanding,
  observations: unknown[] = [],
  relations: unknown[] = [],
  roomLayout: unknown = null,
) =>
  parseInstallationObservation(
    JSON.stringify({ observations, relations, roomLayout }),
    source,
    INSTALLATION_V1_OUTPUT_CONTRACT,
  );
const room = () => ({
  backWallQuad: null,
  orthogonal: 'unknown',
  lines: [],
  corners: [],
  evidence: [],
  uncertainty: [],
});

describe('installation second-pass immutable inventory and evidence validation', () => {
  it('clones inventory, keeps kind/bounds/IDs/default provenance, and applies observed supporting wall and contact', () => {
    const source = inventory(),
      before = structuredClone(source),
      id = source.candidates[0].id;
    const result = run(source, [
      {
        ...emptyObservation(id),
        mounting: { value: 'floor', evidence: ['Pedestal meets floor'] },
        wall: { value: 'back', evidence: ['Cistern rear against back wall'] },
        anchor: {
          point: { x: 0.25, y: 0.89 },
          kind: 'floor-contact',
          evidence: ['Visible base touches floor'],
          uncertainty: [],
        },
      },
    ]);
    expect(source).toEqual(before);
    expect(result.understanding.candidates[0]).toMatchObject({
      id,
      kind: before.candidates[0].kind,
      bounds: before.candidates[0].bounds,
      mounting: 'floor',
      wall: 'back',
      provenance: { wall: 'model', mounting: 'model', position: 'model' },
    });
    expect(result.understanding.candidates[1]).toEqual(source.candidates[1]);
    expect(result.validation).toMatchObject({ status: 'valid', appliedCandidateIds: [id] });
    expect(result.understanding.candidates[0].provenance?.kind).toBe(source.candidates[0].provenance?.kind);
  });
  it('does not turn null/unknown or unsupported evidence into model defaults', () => {
    const source = inventory();
    const result = run(source, [
      {
        ...emptyObservation(source.candidates[0].id),
        wall: { value: 'unknown', evidence: ['Hidden'] },
        mounting: { value: 'wall', evidence: [] },
      },
    ]);
    expect(result.understanding).toEqual(source);
    expect(result.validation).toMatchObject({ status: 'partial', appliedCandidateIds: [] });
  });
  it('isolates unknown, duplicate, reclassified and moved rows without altering the first inventory', () => {
    const source = inventory(),
      id = source.candidates[0].id;
    for (const observations of [
      [{ ...emptyObservation('new-fixture'), mounting: { value: 'wall', evidence: ['Wall'] } }],
      [emptyObservation(id), emptyObservation(id)],
      [{ ...emptyObservation(id), kind: 'basin' }],
      [{ ...emptyObservation(id), bounds: { left: 0, top: 0, right: 1, bottom: 1 } }],
    ]) {
      const result = run(source, observations);
      expect(result.understanding).toEqual(source);
      expect(result.validation.rejectedObservations).toHaveLength(observations.length);
    }
  });
  it('quarantines an out-of-box contact but retains a valid independent row', () => {
    const source = inventory();
    const result = run(source, [
      {
        ...emptyObservation(source.candidates[0].id),
        anchor: { point: { x: 0.9, y: 0.8 }, kind: 'floor-contact', evidence: ['Contact'], uncertainty: [] },
      },
      {
        ...emptyObservation(source.candidates[1].id),
        wall: { value: 'right', evidence: ['Glass attachment to right wall'] },
      },
    ]);
    expect(result.understanding.candidates[0]).toEqual(source.candidates[0]);
    expect(result.understanding.candidates[1].wall).toBe('right');
    expect(
      result.validation.rejectedObservations[0].issues.some((issue) => issue.code === 'anchor-outside'),
    ).toBe(true);
    expect(result.validation.status).toBe('partial');
  });
  it('accepts glass depth evidence and rejects missing IDs/self links without poisoning valid observations', () => {
    const source = inventory(),
      [toilet, glass] = source.candidates;
    const result = run(
      source,
      [],
      [
        {
          frontId: glass.id,
          behindId: toilet.id,
          relation: 'visibleThrough',
          evidence: ['Toilet visible behind clear glass'],
        },
        { frontId: toilet.id, behindId: 'absent', relation: 'occludes', evidence: ['Occluded edge'] },
        { frontId: toilet.id, behindId: toilet.id, relation: 'occludes', evidence: ['Self'] },
      ],
    );
    expect(result.understanding.relations).toEqual([
      {
        frontId: glass.id,
        behindId: toilet.id,
        relation: 'visibleThrough',
        evidence: ['Toilet visible behind clear glass'],
        provenance: 'model',
      },
    ]);
    expect(result.validation.rejectedRelations).toHaveLength(2);
  });
  it('preserves reflected status evidence and a validated mirror-copy relation', () => {
    const source = inventory(),
      [physical, copy] = source.candidates;
    copy.kind = 'toilet';
    const result = run(
      source,
      [
        {
          ...emptyObservation(copy.id),
          reflection: { value: 'reflected', evidence: ['Duplicated toilet within mirror boundary'] },
        },
      ],
      [
        {
          frontId: copy.id,
          behindId: physical.id,
          relation: 'reflectionOf',
          evidence: ['Same toilet is visible directly and in mirror'],
        },
      ],
    );
    expect(result.understanding.candidates[1].reflection).toBe('reflected');
    expect(result.understanding.relations[0].relation).toBe('reflectionOf');
  });
  it('validates existing bowl/cabinet partOf and contact together without adding a cabinet', () => {
    const source = inventory(),
      [bowl, cabinet] = source.candidates;
    Object.assign(bowl, {
      kind: 'basin',
      basinStyle: 'vanity',
      mounting: 'unknown',
      bounds: { left: 0.1, top: 0.2, right: 0.6, bottom: 0.5 },
    });
    Object.assign(cabinet, {
      kind: 'vanity',
      mounting: 'floor',
      bounds: { left: 0.1, top: 0.45, right: 0.6, bottom: 0.9 },
    });
    const result = run(
      source,
      [
        {
          ...emptyObservation(bowl.id),
          mounting: { value: 'countertop', evidence: ['Bowl rests on cabinet'] },
          anchor: {
            kind: 'countertop-contact',
            point: { x: 0.35, y: 0.48 },
            evidence: ['Visible bowl support seam'],
            uncertainty: [],
          },
        },
      ],
      [
        {
          frontId: bowl.id,
          behindId: cabinet.id,
          relation: 'partOf',
          evidence: ['Bowl and cabinet support are contiguous'],
        },
      ],
    );
    expect(result.validation.rejectedObservations).toEqual([]);
    expect(result.understanding.candidates[0].mounting).toBe('countertop');
    expect(result.understanding.relations[0].relation).toBe('partOf');
    expect(result.understanding.candidates).toHaveLength(2);
  });
  it('preserves observed room edges but rejects an inferred complete wall and zero-length lines', () => {
    const observed = {
      ...room(),
      evidence: ['Visible wall seam'],
      backWallQuad: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ],
      lines: [
        {
          axis: 'height',
          start: { x: 0.2, y: 0.2 },
          end: { x: 0.2, y: 0.8 },
          evidence: ['Visible vertical corner'],
        },
        { axis: 'width', start: { x: 0.5, y: 0.5 }, end: { x: 0.5, y: 0.5 }, evidence: ['Guess'] },
      ],
    };
    const result = run(inventory(), [], [], observed);
    expect(result.understanding.roomLayout.backWallQuad).toBeNull();
    expect(result.understanding.roomLayout.lines).toHaveLength(1);
    expect(result.validation.roomLayoutIssues.map((issue) => issue.code)).toContain(
      'room-quad-visible-corners',
    );
    expect(result.validation.status).toBe('partial');
  });
  it('accepts a complete wall only with four independently observed matching corners', () => {
    const quad = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ];
    const corners = ['back-top-left', 'back-top-right', 'back-bottom-right', 'back-bottom-left'].map(
      (corner, i) => ({ corner, point: quad[i], evidence: ['Visible wall corner'] }),
    );
    const result = run(inventory(), [], [], {
      ...room(),
      backWallQuad: quad,
      corners,
      evidence: ['All four full wall corners are visible'],
    });
    expect(result.understanding.roomLayout.backWallQuad).toEqual(quad);
    expect(result.validation.status).toBe('valid');
  });
  it('rejects a broken envelope or duplicate inventory and records empty-inventory skip without a model revision', () => {
    expect(() => parseInstallationObservation('{', inventory())).toThrow();
    const source = inventory();
    source.candidates.push(source.candidates[0]);
    expect(() => validateInstallationInventory(source)).toThrow();
    source.candidates = [];
    expect(skippedInstallationAnalysis(source)).toMatchObject({
      skipped: 'empty-inventory',
      modelRevision: null,
      rawText: '',
      measurement: { requestMs: 0 },
    });
    const prompt = installationObservationV1Prompt(inventory());
    expect(prompt).toContain('It is NOT the left/right side of the picture');
    expect(prompt).toContain('Never extend across occlusion or infer hidden corners');
  });
});
