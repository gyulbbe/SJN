import type { RoomFace } from '../room-types';
import type { FixtureInstance } from '../types';
import type { ReconstructionCandidate, ReconstructionKind, ReconstructionStandardOptions } from './types';

type PropertyForm = ReconstructionStandardOptions & { face: RoomFace; u: number; v: number };
const commonFields = ['face', 'u', 'v', 'baseHeightMm', 'yawDegrees', 'support'] as const;
const shapeFields = [
  'basinVariant',
  'basinShape',
  'pedestalShape',
  'hasFrame',
  'opacity',
  'doorCount',
  'shelfStyle',
  'toiletLidState',
  'mirrorShape',
  'vanityStyle',
  'counterSupport',
  'showerVariant',
  'curtainHardware',
] as const;
type FormField = (typeof commonFields)[number] | (typeof shapeFields)[number];

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = Object.entries(a).filter(([key]) => key !== 'provenance');
  const right = Object.entries(b).filter(([key]) => key !== 'provenance');
  return (
    left.length === right.length &&
    left.every(([key, value]) => Object.hasOwn(b, key) && same(value, (b as Record<string, unknown>)[key]))
  );
}
function applies(kind: ReconstructionKind, field: FormField, form: PropertyForm) {
  if ((commonFields as readonly string[]).includes(field)) return true;
  if (field === 'basinVariant') return kind === 'basin';
  if (field === 'basinShape') return kind === 'basin' || kind === 'vanity';
  if (field === 'pedestalShape') return kind === 'basin' && form.basinVariant === 'pedestal';
  if (field === 'hasFrame') return ['mirror', 'mirrorCabinet', 'glassPartition'].includes(kind);
  if (field === 'opacity') return kind === 'glassPartition';
  if (field === 'doorCount') return kind === 'mirrorCabinet';
  if (field === 'shelfStyle') return kind === 'wallShelf';
  if (field === 'toiletLidState') return kind === 'toilet';
  if (field === 'mirrorShape') return kind === 'mirror';
  if (field === 'showerVariant') return kind === 'shower';
  if (field === 'curtainHardware') return kind === 'showerCurtain';
  return kind === 'vanity' || (kind === 'basin' && form.basinVariant === 'vanity');
}

/** UI fallbacks are for controls, not newly observed properties of unrelated products. */
export function fixturePropertyFormPatch(
  before: PropertyForm,
  after: PropertyForm,
  kind: ReconstructionKind,
  options: { convert?: boolean; kindChanged?: boolean } = {},
): Partial<PropertyForm> {
  const patch: Partial<PropertyForm> = {};
  for (const key of [...commonFields, ...shapeFields]) {
    if (applies(kind, key, after)) {
      if (options.convert || options.kindChanged || !same(before[key], after[key]))
        Object.assign(patch, { [key]: after[key] });
    } else if (options.kindChanged) {
      Object.assign(patch, { [key]: undefined });
    }
  }
  return patch;
}

export type FixturePropertyChanges = {
  kind: boolean;
  mounting: boolean;
  wall: boolean;
  position: boolean;
  shape: boolean;
  toiletLidState: boolean;
};

/** Compare the initial and final form values; touching a control is not blanket confirmation. */
export function inspectFixturePropertyChanges(input: {
  before: PropertyForm;
  after: PropertyForm;
  oldKind: ReconstructionKind;
  kind: ReconstructionKind;
  oldOrientation?: string;
  orientation?: string;
}): FixturePropertyChanges {
  const { before, after, kind, oldKind } = input;
  const changed = (key: FormField) => applies(kind, key, after) && !same(before[key], after[key]);
  const mode = (k: ReconstructionKind, form: PropertyForm) =>
    k === 'showerCurtain' ? 'suspended' : form.face === 'floor' ? 'floor' : 'wall';
  const supportIdentity = (form: PropertyForm) => ({
    kind: form.support?.kind,
    parent: form.support?.bathRim?.parentFixtureId ?? form.support?.partitionTop?.parentFixtureId,
  });
  return {
    kind: kind !== oldKind,
    mounting:
      mode(oldKind, before) !== mode(kind, after) ||
      changed('basinVariant') ||
      changed('counterSupport') ||
      !same(supportIdentity(before), supportIdentity(after)),
    wall: before.face !== after.face,
    position: commonFields.some(changed) || input.oldOrientation !== input.orientation,
    shape: shapeFields
      .filter((field) => field !== 'toiletLidState' && field !== 'basinVariant')
      .some(changed),
    toiletLidState: changed('toiletLidState'),
  };
}

/** A property edit is not an acknowledgement of the candidate's remaining review issues. */
export function updateCandidateFromPropertyEdit(
  candidate: ReconstructionCandidate,
  next: FixtureInstance,
  changes: FixturePropertyChanges,
  options: { colorChanged?: boolean } = {},
): ReconstructionCandidate {
  const updated = structuredClone(candidate);
  const model = next.reconstruction;
  if (!model) return updated;
  if (options.colorChanged) {
    updated.color = model.color;
    updated.colorEvidence = model.colorEvidence;
  }
  if (changes.kind) {
    updated.kind = model.kind as ReconstructionKind;
    updated.proposedKind = model.kind as ReconstructionKind;
    updated.source = 'user';
  }
  if (changes.mounting || changes.wall) {
    const placement = next.roomPlacement;
    const previous = candidate.installation;
    updated.installation = {
      mode: previous?.mode ?? 'unknown',
      ...previous,
      ...(changes.mounting
        ? {
            mode:
              model.kind === 'showerCurtain' ? 'suspended' : placement?.face === 'floor' ? 'floor' : 'wall',
            ...(model.kind === 'basin' ? { basinVariant: model.basinVariant } : {}),
          }
        : {}),
      ...(changes.wall ? { wall: placement?.face === 'floor' ? undefined : placement?.face } : {}),
      reason: '사용자가 변경한 설치 항목을 적용했어요. 다른 관측의 확인 상태는 유지했어요.',
      source: 'user',
    };
  }
  if (changes.kind && model.kind !== 'basin' && updated.installation)
    delete updated.installation.basinVariant;
  const labels = [
    ...(changes.kind ? ['종류'] : []),
    ...(changes.mounting ? ['설치 방식'] : []),
    ...(changes.wall ? ['설치 면'] : []),
    ...(changes.position ? ['위치·방향'] : []),
  ];
  if (labels.length) {
    updated.trace = [
      ...(candidate.trace ?? []),
      {
        stage: changes.kind ? 'candidate' : changes.position ? 'placement' : 'installation',
        outcome: 'accepted',
        reason: `사용자가 ${labels.join(', ')} 항목을 변경했어요. 나머지 관측과 검토 필요 상태는 유지했어요.`,
      },
    ];
  }
  return updated;
}
