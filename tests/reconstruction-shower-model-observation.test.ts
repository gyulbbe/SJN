import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import actual from './fixtures/shower-observed-composition-v9.json';
import { decideObservedShowerModel } from '../src/lib/reconstruction/shower-model-observation';
import { canonicalTargetValue } from '../src/lib/reconstruction/target-existence-observation';
import {
  SHOWER_INSTALLATION_DECISION_REVISION,
  type ShowerInstallationDecision,
  type ShowerInstallationObservation,
} from '../src/lib/reconstruction/shower-installation-observation';
import { parseShowerObservation, type ShowerObservation } from '../src/lib/reconstruction/shower-observation';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import { buildEstimatedCandidatePipeline } from '../src/lib/reconstruction/estimated-layout';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';
import { showerObservedCorners } from '../src/lib/reconstruction/shower-layout-evidence';
import { showerVariantDefaults } from '../src/lib/reconstruction/fixture-variants';

// Copied, attributed actual v9 observations; tests run offline and never invoke AI.
function fixture(index = 0) {
  const value = structuredClone(actual[index]);
  const installation = value.installationDecision as ShowerInstallationDecision;
  return {
    candidate: installation.before.candidate,
    detail: value.detail as ShowerObservation,
    installation,
  };
}
function changeInstallation(
  value: ReturnType<typeof fixture>,
  patch: Partial<ShowerInstallationObservation>,
) {
  Object.assign(value.installation.analysis.observation, patch);
  value.installation.analysis.rawText = JSON.stringify(value.installation.analysis.observation);
  value.installation.analysis.rawTextSha256 = createHash('sha256')
    .update(value.installation.analysis.rawText)
    .digest('hex');
}
function changeHardware(
  value: ReturnType<typeof fixture>,
  field: keyof ShowerInstallationObservation['visibleHardware'],
  presence: 'present' | 'absent' | 'uncertain',
) {
  changeInstallation(value, {
    visibleHardware: { ...value.installation.analysis.observation.visibleHardware, [field]: presence },
  });
}
function rebind(value: ReturnType<typeof fixture>) {
  value.installation.before.candidate = structuredClone(value.candidate);
  value.installation.analysis.receipt.candidateSignature = canonicalTargetValue(value.candidate);
  value.installation.analysis.receipt.targetBounds = { ...value.candidate.bounds };
}
function pipelineArgs(value = fixture()) {
  const understanding: SceneUnderstanding = {
    schemaVersion: 1,
    candidates: [value.candidate],
    relations: [],
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  };
  const room = { ...DEFAULT_ROOM },
    image = { width: 960, height: 1280 };
  const baseline: ReconstructionReview = {
    version: 2,
    analysis: 'partial',
    planes: [],
    candidates: [],
    warnings: [],
  };
  return {
    understanding,
    room,
    image,
    baseline,
    strictResult: buildCandidatePipeline(understanding, baseline, room, image),
    showerDetails: [value.detail],
    showerInstallationDecisions: [value.installation],
  };
}

describe('independently observed shower composition, no new AI', () => {
  it.each([0, 1])('reparses preserved v9 source detail %i against its original fixed candidate', (index) => {
    const value = fixture(index),
      input = pipelineArgs(value);
    expect(parseShowerObservation(actual[index].detailRawText, input.understanding).observations).toEqual([
      value.detail,
    ]);
    expect(value.installation.policyRevision).toBe(SHOWER_INSTALLATION_DECISION_REVISION);
  });
  it('links actual connected head/hose/control evidence to an ordinary wall handset without editing its conflicting scope', () => {
    const value = fixture(),
      before = structuredClone(value),
      out = decideObservedShowerModel(value);
    expect(out).toMatchObject({
      action: 'apply',
      variant: 'handheld-wall',
      variantSource: 'inferred',
      projectionPart: 'handset',
      scopeComparison: 'different-described-scope',
      requiresReview: true,
    });
    expect(out.installation?.inputSha256).toBe(value.installation.analysis.receipt.inputSha256);
    expect(out.installation?.rawTextSha256).toBe(value.installation.analysis.rawTextSha256);
    expect(out.reasons.join(' ')).toContain('범위');
    expect(value).toEqual(before);
  });
  it('links actual fixed head and explicitly absent flexible parts to a head-only model', () => {
    const out = decideObservedShowerModel(fixture(1));
    expect(out).toMatchObject({ action: 'apply', variant: 'overhead-head', projectionPart: 'overhead-head' });
    // The independent support field is absent; do not change it to agree with the detail arm.
    expect(out.installation?.observation.visibleHardware.headMountOrSupport).toBe('absent');
  });
  it('does not claim an unknown outlet face makes a visibly installed wall handset absent', () => {
    const value = fixture();
    expect(value.installation.analysis.observation.visibleHardware.sprayOutletFace).toBe('uncertain');
    expect(decideObservedShowerModel(value).variant).toBe('handheld-wall');
  });
  it('preserves legacy compact adoption without an independent installation record', () => {
    const value = fixture();
    expect(decideObservedShowerModel({ candidate: value.candidate, detail: value.detail }).variant).toBe(
      'hand-spray',
    );
  });
  it('keeps independently observed compact hardware distinct when a completed control is absent', () => {
    const value = fixture();
    changeHardware(value, 'finishedUserControl', 'absent');
    expect(decideObservedShowerModel(value).variant).toBe('hand-spray');
  });
  it.each([
    'recognizableSprayHeadBody',
    'headMountOrSupport',
    'flexibleWaterHose',
    'finishedUserControl',
  ] as const)('does not create a wall assembly with uncertain %s', (field) => {
    const value = fixture();
    changeHardware(value, field, 'uncertain');
    expect(decideObservedShowerModel(value).variant).not.toBe('handheld-wall');
  });
  it.each(['uncertain', 'multiple-targets', 'separate-component'] as const)(
    'does not promote %s to a connected wall assembly',
    (scope) => {
      const value = fixture();
      changeInstallation(value, { scope });
      expect(decideObservedShowerModel(value).variant).not.toBe('handheld-wall');
    },
  );
  it.each(['reflected', 'uncertain'] as const)(
    'does not generate a new assembly from installation view %s',
    (view) => {
      const value = fixture();
      changeInstallation(value, { view });
      expect(decideObservedShowerModel(value).action).toBe('unchanged');
    },
  );
  it.each(['verticalRail', 'overheadHead'] as const)(
    'does not create an unrailed assembly when detail confirms %s',
    (field) => {
      const value = fixture();
      value.detail.visibleParts[field] = 'present';
      expect(decideObservedShowerModel(value).action).toBe('unchanged');
    },
  );
  it.each(['handheldHead', 'hose', 'verticalRail'] as const)(
    'does not select head-only when %s is uncertain',
    (field) => {
      const value = fixture(1);
      value.detail.visibleParts[field] = 'uncertain';
      expect(decideObservedShowerModel(value).variant).not.toBe('overhead-head');
    },
  );
  it.each(['present', 'uncertain'] as const)('does not suppress a %s independent hose', (presence) => {
    const value = fixture(1);
    changeHardware(value, 'flexibleWaterHose', presence);
    expect(decideObservedShowerModel(value).action).toBe('unchanged');
  });
  it('preserves an authoritative installedness hold and original candidate', () => {
    const value = fixture();
    value.installation.action = 'hold';
    const before = structuredClone(value);
    expect(decideObservedShowerModel(value).action).toBe('hold');
    expect(value).toEqual(before);
  });
  it.each(['id', 'bounds', 'snapshot', 'revision', 'raw'] as const)(
    'rejects mismatched %s evidence',
    (field) => {
      const value = fixture();
      if (field === 'id') value.installation.analysis.receipt.targetId = 'other';
      if (field === 'bounds') value.installation.analysis.receipt.targetBounds.left += 0.01;
      if (field === 'snapshot') value.candidate.evidence.push('edited later');
      if (field === 'revision') value.installation.policyRevision = 'explicit-unfinished-services-hold-v1';
      if (field === 'raw')
        value.installation.analysis.observation.visibleHardware.flexibleWaterHose = 'absent';
      expect(decideObservedShowerModel(value).action).toBe('unchanged');
    },
  );
  it('protects explicit manual IDs, candidate values and model options', () => {
    const value = fixture();
    expect(decideObservedShowerModel({ ...value, protectedByUser: true }).action).toBe('unchanged');
    expect(
      decideObservedShowerModel({
        ...value,
        existingOptions: { showerVariant: 'hand-spray', provenance: { showerVariant: 'user' } },
      }).action,
    ).toBe('unchanged');
    value.candidate.provenance = { ...value.candidate.provenance, mounting: 'user' };
    rebind(value);
    expect(decideObservedShowerModel(value).action).toBe('unchanged');
  });
  it.each(['basin', 'toilet', 'glassPartition', 'showerCurtain'] as const)(
    'does not change %s fixtures',
    (kind) => {
      const value = fixture();
      value.candidate.kind = kind;
      rebind(value);
      expect(decideObservedShowerModel(value).action).toBe('unchanged');
    },
  );
  it('preserves stored original observations and records the applied plan separately', () => {
    const value = fixture(),
      input = pipelineArgs(value),
      original = structuredClone(input);
    const out = buildEstimatedCandidatePipeline(input),
      node = out.pipeline.estimatedLayout.nodes[0];
    expect(input).toEqual(original);
    expect(node.showerModelDecision?.variant).toBe('handheld-wall');
    expect(out.plans[value.candidate.id]?.showerVariant).toBe('handheld-wall');
    expect(out.plans[value.candidate.id]?.heightMm).toBeGreaterThan(600);
    expect(out.plans[value.candidate.id]?.provenance?.showerVariant).toBe('inferred');
    expect(node.showerModelDecision?.detail.observedPart).toBe('handset');
    expect(out.pipeline.estimatedLayout.revision).toBe('visible-relation-layout-v13-inconclusive-direction-hold');
  });
  it('selects a short head-only plan, not a full-height generic kit', () => {
    const value = fixture(1),
      out = buildEstimatedCandidatePipeline(pipelineArgs(value));
    expect(out.plans[value.candidate.id]?.showerVariant).toBe('overhead-head');
    expect(out.plans[value.candidate.id]?.heightMm).toBeLessThan(300);
  });
  it('does not overwrite a previously explicit user plan while automatic alternatives are scored', () => {
    const value = fixture(),
      input = pipelineArgs(value),
      id = value.candidate.id;
    input.strictResult.plans[id] = {
      kind: 'shower',
      version: 2,
      ...showerVariantDefaults('hand-spray'),
      u: 0.3,
      v: 0.5,
      widthMm: 211,
      heightMm: 501,
      depthMm: 131,
      baseHeightMm: 600,
      provenance: { showerVariant: 'user', dimensions: 'user' },
    };
    const before = structuredClone(input.strictResult.plans[id]),
      out = buildEstimatedCandidatePipeline(input);
    expect(out.plans[id]).toEqual(before);
    expect(out.pipeline.estimatedLayout.nodes[0].showerModelDecision?.action).toBe('unchanged');
  });
  it('maps overhead and handset observations to their real named vertex extents', () => {
    const room = { ...DEFAULT_ROOM },
      head = { kind: 'shower' as const, ...showerVariantDefaults('overhead-head'), u: 0.5, v: 0.5 };
    const corners = showerObservedCorners(room, head, 'overhead-head')!;
    expect(corners).toHaveLength(8);
    expect(Math.max(...corners.map((p) => p.y)) - Math.min(...corners.map((p) => p.y))).toBeCloseTo(
      head.heightMm,
      2,
    );
    expect(showerObservedCorners(room, head, 'handset')).toBeUndefined();
    const wall = { ...head, ...showerVariantDefaults('handheld-wall') },
      part = showerObservedCorners(room, wall, 'handset')!;
    expect(Math.max(...part.map((p) => p.y)) - Math.min(...part.map((p) => p.y))).toBeLessThan(
      wall.heightMm * 0.5,
    );
  });
});
