import { resolveProductColor, type ProductColorOverride } from './product-color';
import type { WallAlignmentRecommendationEvidence } from './wall-alignment-suggestions';
import type { RoomFace } from '../room-types';
import type { WallAlignmentParent } from './wall-alignment';
import type { InstallationWall } from './wall-relative-placement';
import type { ManualCandidatePlacement } from './candidate-pipeline';
import type { LabEngineMetadata } from './lab-engine';
import type { SceneCandidate, SceneUnderstanding } from './pipeline-contract';

export type LabCorrectionFields = Pick<
  SceneCandidate,
  'kind' | 'mounting' | 'wall' | 'shape' | 'basinStyle' | 'reflection'
> & {
  bowlCount: 'unknown' | '1' | '2';
};
export type LabFieldCorrection = Partial<LabCorrectionFields> & {
  note?: string;
  falsePositive?: boolean;
  /** User-only appearance choice; never added to the model observation contract. */
  toiletLidState?: 'open' | 'closed';
  productColor?: ProductColorOverride;
  pedestalShape?: 'round' | 'rectangular';
};

export function labToiletLidStates(
  understanding: SceneUnderstanding,
  corrections: Record<string, LabFieldCorrection>,
): Record<string, 'open' | 'closed'> {
  return Object.fromEntries(
    understanding.candidates.flatMap((candidate) => {
      const correction = corrections[candidate.id];
      const state = correction?.toiletLidState;
      return candidate.kind === 'toilet' && !correction?.falsePositive && state
        ? [[candidate.id, state]]
        : [];
    }),
  );
}
/** User colour choices remain outside the AI observation schema. */
export function labProductColors(
  understanding: SceneUnderstanding,
  corrections: Record<string, LabFieldCorrection>,
): Record<string, ProductColorOverride> {
  const colors: Record<string, ProductColorOverride> = {};
  for (const candidate of understanding.candidates) {
    const correction = corrections[candidate.id];
    if (correction?.falsePositive || !correction?.productColor) continue;
    if (candidate.kind === 'unknown') throw new Error('제품 색을 적용할 설비 종류를 먼저 확인해 주세요.');
    resolveProductColor(candidate.kind, undefined, correction.productColor);
    colors[candidate.id] = structuredClone(correction.productColor);
  }
  return colors;
}
export function labPedestalShapes(
  understanding: SceneUnderstanding,
  corrections: Record<string, LabFieldCorrection>,
): Record<string, 'round' | 'rectangular'> {
  const shapes: Record<string, 'round' | 'rectangular'> = {};
  for (const candidate of understanding.candidates) {
    const correction = corrections[candidate.id];
    if (!correction?.pedestalShape || correction.falsePositive) continue;
    if (
      candidate.kind !== 'basin' ||
      candidate.basinStyle !== 'pedestal' ||
      !['round', 'rectangular'].includes(correction.pedestalShape)
    )
      throw new Error(
        '기둥 단면은 기둥형 세면대에서만 확인할 수 있어요. 종류·지지 구조를 확인하거나 단면 선택을 해제해 주세요.',
      );
    shapes[candidate.id] = correction.pedestalShape;
  }
  return shapes;
}
export type LabManualDraft = {
  /** Historical user copy only; not a live fixture relationship or new model observation. */
  positionReference?: {
    version: 1;
    mode: 'copy-above';
    recommendation?: WallAlignmentRecommendationEvidence;
    candidateId: string;
    label: string;
    parent: WallAlignmentParent;
    wall: InstallationWall;
    gapMm: number;
    gapSource: 'default' | 'user';
    room: { widthMm: number; depthMm: number; heightMm: number };
    result: { face: InstallationWall; u: number; v: number; baseHeightMm: number };
  };
  enabled: boolean;
  face: RoomFace;
  u: string;
  v: string;
  baseHeightMm: string;
  widthMm: string;
  heightMm: string;
  depthMm: string;
  yawDegrees: string;
  support?: {
    kind: '' | 'bath-rim' | 'shower-curb' | 'partition-top';
    heightMm: string;
    heightSource?: 'user' | 'default';
    evidence?: string[];
    bathRim?: {
      parentCandidateId: string;
      side: 'left' | 'right' | 'front' | 'back';
      offsetMm: string;
      provenance?: import('./candidate-bath-rim').CandidateBathRim['provenance'];
    };
    partitionTop?: {
      parentCandidateId: string;
      offsetMm: string;
      provenance?: import('./candidate-bath-rim').CandidatePartitionTop['provenance'];
    };
    curb?: {
      widthMm: string;
      depthMm: string;
      widthSource: 'default' | 'user';
      depthSource: 'default' | 'user';
    };
  };
  wallPosition?: { wall: '' | 'back' | 'left' | 'right'; alongMm: string; clearanceMm: string };
};
export type LabCorrectionDraft = {
  corrections: Record<string, LabFieldCorrection>;
  manual: Record<string, LabManualDraft>;
  additions: SceneCandidate[];
  disconnectedRelations?: string[];
  supportParents?: Record<string, string | null>;
};
/** The exact submitted inputs for one completed PNG; never the later editable draft. */
export type LabCorrectionSnapshot = {
  readonly version: 1;
  readonly capturedAt: string;
  readonly sourceRunId: string;
  readonly inputKey: string;
  readonly sourceEngineMetadata: LabEngineMetadata;
  readonly sourceModelRunId: string;
  readonly draft: LabCorrectionDraft;
  readonly input: {
    understanding: SceneUnderstanding;
    manualPlacements: Record<string, ManualCandidatePlacement>;
    toiletLidStates?: Record<string, 'open' | 'closed'>;
    productColors?: Record<string, ProductColorOverride>;
    pedestalShapes?: Record<string, 'round' | 'rectangular'>;
  };
  readonly changedFieldCount: number;
};

function freezeTree(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeTree(child);
  Object.freeze(value);
}

/** Capture before awaiting rendering so edits, retries and exports cannot relabel past results. */
export function captureLabCorrection(value: Omit<LabCorrectionSnapshot, 'version'>): LabCorrectionSnapshot {
  const snapshot: LabCorrectionSnapshot = structuredClone({ ...value, version: 1 });
  freezeTree(snapshot);
  return snapshot;
}

export function appliedCorrectionReview(snapshot: LabCorrectionSnapshot) {
  return {
    recordType: 'applied-correction' as const,
    capturedAt: snapshot.capturedAt,
    sourceRunId: snapshot.sourceRunId,
    corrections: structuredClone(snapshot.draft.corrections),
    changedFieldCount: snapshot.changedFieldCount,
    manuallyPlacedCandidateCount: Object.keys(snapshot.input.manualPlacements).length,
    addedCandidateCount: snapshot.draft.additions.filter((candidate) =>
      snapshot.input.understanding.candidates.some((item) => item.id === candidate.id),
    ).length,
    additions: structuredClone(snapshot.draft.additions),
    disconnectedRelations: [...(snapshot.draft.disconnectedRelations ?? [])],
    supportParents: structuredClone(snapshot.draft.supportParents ?? {}),
    manualPlacements: structuredClone(snapshot.draft.manual),
    scope:
      'Inputs captured for this completed correction. User confirmation is not AI detection or measured geometry.',
  };
}

/** Restore a fresh editable copy on the same source observation and photo/room conditions. */
export function restoreLabCorrectionDraft(
  snapshot: LabCorrectionSnapshot,
  sourceRunId: string,
  inputKey: string,
): LabCorrectionDraft {
  if (snapshot.sourceRunId !== sourceRunId || snapshot.inputKey !== inputKey)
    throw new Error('교정 당시의 원 분석과 사진·공간 조건에서만 입력을 복원할 수 있어요.');
  return structuredClone(snapshot.draft);
}
