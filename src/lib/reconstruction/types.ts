import type { Point, Quad } from '../types';
import type { RoomFace } from '../room-types';
import type { ProductColorEvidence } from './product-color';

export type ReconstructionKind =
  | 'toilet'
  | 'basin'
  | 'vanity'
  | 'bath'
  | 'mirror'
  | 'door'
  | 'window'
  | 'glassPartition'
  | 'mirrorCabinet'
  | 'wallShelf'
  | 'shower'
  | 'wallCabinet'
  | 'lowPartition'
  | 'showerCurtain';
export type ReconstructionProvenance = 'model' | 'inferred' | 'default' | 'user';
export type ShowerVariant = 'hand-spray' | 'handheld-rail' | 'overhead-set' | 'handheld-wall' | 'overhead-head';
export type CurtainHardware = 'rod' | 'track' | 'none';
/** Explicit user or observation-grounded estimated support; historical height-only data stays independent. */
export type SupportDecisionSource = 'user' | 'inferred';
export type RaisedGlassSupport = {
  kind: 'bath-rim' | 'shower-curb' | 'partition-top';
  heightMm: number;
  provenance: { kind: SupportDecisionSource; height: 'user' | 'default' | 'parent' | 'inferred' };
  /** Required for inferred decisions; descriptive observed relation, never executable text. */
  evidence?: string[];
  /** Fixture relation. Offset runs from the selected rim centre; inferred fields retain their evidence. */
  bathRim?: {
    parentFixtureId: string;
    side: 'left' | 'right' | 'front' | 'back';
    offsetMm: number;
    provenance: { parent: SupportDecisionSource; side: SupportDecisionSource; offset: SupportDecisionSource };
  };
  /** Glass along the horizontal long axis of an independent low-partition parent. */
  partitionTop?: {
    parentFixtureId: string;
    offsetMm: number;
    provenance: { parent: SupportDecisionSource; offset: SupportDecisionSource };
  };
  /** Optional modeled curb. Absence keeps historical height-only glass unchanged. */
  curb?: {
    widthMm: number;
    depthMm: number;
    provenance: { width: 'default' | 'user'; depth: 'default' | 'user' };
  };
};
/** Serializable model options shared by storage, placement and rendering. Dimensions are estimates. */
export type ReconstructionStandardOptions = {
  version?: 1 | 2;
  /** Photo proposals and explicit confirmations are never silently fitted to the room. */
  placementPolicy?: 'preserve';
  /** Lower bound of the whole model in its placement frame, including curtain hardware. */
  baseHeightMm?: number;
  support?: RaisedGlassSupport;
  yawDegrees?: number;
  basinVariant?: 'wall' | 'pedestal' | 'vanity';
  basinShape?: 'rectangular' | 'round';
  /** Independent support cross-section. Absence keeps the historic round pedestal. */
  pedestalShape?: 'round' | 'rectangular';
  /** Explicit bowls in the standard model; absence keeps pre-field saved geometry compatible. */
  bowlCount?: 1 | 2;
  /** Absence preserves the original seat-only geometry of saved fixtures. */
  toiletLidState?: 'open' | 'closed';
  hasFrame?: boolean;
  opacity?: number;
  doorCount?: number;
  shelfStyle?: 'solid' | 'rack';
  sourceMaterialVersionId?: string;
  colorEvidence?: ProductColorEvidence;
  /** Optional interior/rim finish. Absence preserves historical single-color bath geometry. */
  bathLiningColor?: string;
  /** Explicit silhouette; omitted fields preserve older geometry. */
  mirrorShape?: 'rectangular' | 'oval' | 'arched';
  vanityStyle?: 'enclosed' | 'open-counter';
  counterSupport?: 'wall' | 'left-panel' | 'right-panel' | 'both-panels';
  /** Explicit kit form. Omission preserves the historical generic shower geometry. */
  showerVariant?: ShowerVariant;
  /** Optional top hardware; dimensions cover the whole curtain model. Omission is preserved on read. */
  curtainHardware?: CurtainHardware;
  /** Per-axis width/height/depth sources override the legacy aggregate dimensions source. */
  provenance?: Partial<
    Record<
      | 'kind'
      | 'mounting'
      | 'wall'
      | 'position'
      | 'dimensions'
      | 'width'
      | 'height'
      | 'depth'
      | 'shape'
      | 'bowlCount'
      | 'pedestalShape'
      | 'appearance'
      | 'color'
      | 'bathLiningColor'
      | 'mirrorShape'
      | 'vanityStyle'
      | 'counterSupport'
      | 'showerVariant'
      | 'curtainHardware',
      ReconstructionProvenance
    >
  > & { toiletLidState?: 'inferred' | 'default' | 'user' };
};
export type ReconstructionInstallation = {
  /** Suspended describes support; floor coordinates are not evidence of floor contact. */
  mode: 'wall' | 'floor' | 'suspended' | 'unknown';
  wall?: Exclude<RoomFace, 'floor'>;
  basinVariant?: ReconstructionStandardOptions['basinVariant'];
  reason: string;
  source: ReconstructionProvenance;
};
export type ReconstructionCandidate = {
  id: string;
  kind: ReconstructionKind;
  /** A cabinet semantic class alone is not evidence of a vanity or mirrored cabinet. */
  detectedLabel?: string;
  proposedKind?: ReconstructionKind;
  source?: 'deeplab' | 'qwen' | 'gemma' | 'user';
  installation?: ReconstructionInstallation;
  trace?: {
    stage: 'analysis' | 'candidate' | 'installation' | 'placement' | 'model';
    outcome: 'accepted' | 'held' | 'merged';
    reason: string;
  }[];
  /** Original proposed geometry and physical validation; never a source-camera reprojection. */
  placementReview?: {
    version: 1;
    status: 'accepted' | 'held';
    requested: {
      kind: ReconstructionKind;
      face: RoomFace;
      u: number;
      v: number;
      widthMm: number;
      heightMm: number;
      depthMm: number;
      baseHeightMm?: number;
      yawDegrees?: number;
      scale?: number;
      orientation?: 'back' | 'left' | 'right';
      provenance?: ReconstructionStandardOptions['provenance'];
      support?: RaisedGlassSupport;
    };
    reasons: string[];
    worldBoundsMm?: { min: [number, number, number]; max: [number, number, number] };
    overflowMm?: { left: number; right: number; back: number; front: number; below: number; above: number };
  };
  reflectionOf?: string;
  bounds: { left: number; top: number; right: number; bottom: number };
  foot: Point;
  color: string;
  colorEvidence?: ProductColorEvidence;
  pixels: number;
  /** Internal model evidence, never a calibrated accuracy percentage. */
  evidence: {
    semanticPixels: number;
    meanMargin: number;
    mirrorCompetition?: number;
    /** Geometry of the actual basin-class component, not a calibrated mounting prediction. */
    basinShape?: { coverage: number; fitError: number } & (
      | { value: 'rectangular' | 'round'; source: 'semantic-contour'; curvature: number }
      | {
          value: 'rectangular';
          source: 'semantic-rgb-contour';
          edgeSlopes: [number, number];
          rimIntersection: Point;
          observedEdgeCoverage: [number, number];
        }
    );
    bowlCount?: { value: 2; source: 'separate-basin-components'; candidateIds: string[] };
    pedestalSupport?: { stemWidthRatio: number; stemHeightRatio: number; coverage: number };
    /** Fraction of a mirror-class boundary adjacent to observed toilet pixels. */
    toiletSurround?: number;
    contextualKind?: 'toilet-assembly';
    contextualParts?: {
      toiletPixels: number;
      surroundRatio: number;
      bowlPixels: number;
      lidBounds?: ReconstructionCandidate['bounds'];
      bowlBounds?: ReconstructionCandidate['bounds'];
    };
  };
  fixtureId?: string;
  requiresReview?: boolean;
  status: 'placed' | 'unplaced' | 'ignored';
  warning?: string;
};
export type ReconstructionPlane = {
  id: string;
  face: RoomFace;
  quad: Quad;
  /** Portion of the room depth visible in this photo rectangle, not a measured depth. */
  depthStart: number;
  depthEnd: number;
  confirmed: boolean;
  /** Appearance regions do not establish physical wall identity or full-height coordinates. */
  geometrySource?: 'room-boundaries' | 'appearance-region' | 'visible-floor-region';
  /** Partial line geometry is estimated; intersections are not observed camera corners. */
  geometryEvidence?: import('./partial-wall-geometry').PartialWallEvidence;
  /** Normalized physical room-width interval represented by this visible source rectangle. */
  horizontalStart?: number;
  horizontalEnd?: number;
  verticalStart?: number;
  verticalEnd?: number;
  tile: {
    color: string;
    widthMm: number;
    heightMm: number;
    groutWidth: number;
    groutColor?: string;
    estimated: boolean;
    pattern?: 'grid' | 'brick';
  };
  /** Vertical intervals in the rectified source plane: 0 is its top, 1 its bottom. */
  bands?: { from: number; to: number; tile: ReconstructionPlane['tile'] }[];
};
export type ReconstructionReview = {
  version: 1 | 2;
  /** Optional on old projects; never triggers an automatic reanalysis. */
  analysisProfile?: import('./quality-contract').ReconstructionAnalysisProfile;
  analysisSummary?: import('./quality-contract').ReconstructionAnalysisSummary;
  warnings: string[];
  candidates: ReconstructionCandidate[];
  planes: ReconstructionPlane[];
  analysis: 'complete' | 'manual' | 'partial';
};
export const reconstructionLabels: Record<ReconstructionKind, string> = {
  toilet: '변기',
  basin: '세면대',
  vanity: '세면대 하부장',
  bath: '욕조',
  mirror: '거울',
  door: '문',
  window: '창',
  glassPartition: '유리 파티션',
  mirrorCabinet: '거울 수납장',
  wallShelf: '벽 선반',
  shower: '샤워 설비',
  wallCabinet: '벽 수납장',
  lowPartition: '낮은 칸막이',
  showerCurtain: '샤워 커튼',
};
export const RECONSTRUCTION_DEFAULTS: Record<
  ReconstructionKind,
  ReconstructionStandardOptions & {
    widthMm: number;
    heightMm: number;
    depthMm: number;
    color: string;
    face: RoomFace;
  }
> = {
  toilet: {
    widthMm: 400,
    heightMm: 750,
    depthMm: 680,
    color: '#efefea',
    face: 'floor',
    toiletLidState: 'closed',
  },
  basin: {
    widthMm: 600,
    heightMm: 320,
    depthMm: 450,
    color: '#efefea',
    face: 'back',
    baseHeightMm: 650,
    basinVariant: 'wall',
    basinShape: 'rectangular',
    bowlCount: 1,
  },
  vanity: {
    widthMm: 1200,
    heightMm: 850,
    depthMm: 550,
    color: '#d3ddd9',
    face: 'floor',
    basinShape: 'round',
    bowlCount: 1,
  },
  bath: { widthMm: 1500, heightMm: 600, depthMm: 750, color: '#efefea', face: 'floor' },
  mirror: { widthMm: 600, heightMm: 800, depthMm: 25, color: '#a9b6b8', face: 'back' },
  door: { widthMm: 800, heightMm: 2000, depthMm: 60, color: '#d6ccba', face: 'left' },
  window: { widthMm: 1000, heightMm: 800, depthMm: 100, color: '#c7dce2', face: 'right' },
  glassPartition: {
    widthMm: 800,
    heightMm: 1800,
    depthMm: 8,
    color: '#c6e0e3',
    face: 'floor',
    baseHeightMm: 0,
    yawDegrees: 90,
    hasFrame: true,
    opacity: 0.18,
  },
  mirrorCabinet: {
    widthMm: 800,
    heightMm: 700,
    depthMm: 150,
    color: '#d4dadd',
    face: 'back',
    baseHeightMm: 1200,
    doorCount: 2,
  },
  wallShelf: {
    widthMm: 600,
    heightMm: 30,
    depthMm: 250,
    color: '#c4c9ca',
    face: 'back',
    baseHeightMm: 1700,
    shelfStyle: 'solid',
  },
  shower: {
    widthMm: 300,
    heightMm: 1300,
    depthMm: 300,
    color: '#949c9e',
    face: 'back',
    baseHeightMm: 750,
  },
  wallCabinet: {
    widthMm: 600,
    heightMm: 700,
    depthMm: 180,
    color: '#e8e9e4',
    face: 'back',
    baseHeightMm: 1300,
    doorCount: 2,
  },
  showerCurtain: {
    version: 2,
    widthMm: 900,
    heightMm: 1900,
    depthMm: 50,
    color: '#e8e7e1',
    // A placement frame, not evidence of floor support or measured hanging height.
    face: 'floor',
    baseHeightMm: 0,
    yawDegrees: 0,
    curtainHardware: 'rod',
  },
  lowPartition: {
    widthMm: 1000,
    heightMm: 1000,
    depthMm: 120,
    color: '#c7c7c0',
    face: 'floor',
    baseHeightMm: 0,
  },
};

export function reconstructionCandidateLabel(candidate: ReconstructionCandidate) {
  return candidate.detectedLabel === 'cabinet' && !candidate.proposedKind
    ? '수납장 · 종류 확인 필요'
    : reconstructionLabels[candidate.proposedKind ?? candidate.kind];
}

/** Central defaults for the simple add/edit controls; no dimensions are claimed as measured. */
export function reconstructionDefaults(
  kind: ReconstructionKind,
  basinVariant?: ReconstructionStandardOptions['basinVariant'],
) {
  if (!RECONSTRUCTION_DEFAULTS[kind]) throw new Error('지원하는 기본 모형 종류를 선택해 주세요.');
  const defaults = { ...RECONSTRUCTION_DEFAULTS[kind] };
  if (kind === 'basin' && basinVariant === 'pedestal')
    Object.assign(defaults, {
      face: 'floor',
      widthMm: 600,
      heightMm: 800,
      depthMm: 480,
      baseHeightMm: 0,
      basinVariant,
      basinShape: 'round',
    });
  if (kind === 'basin' && basinVariant === 'vanity')
    Object.assign(defaults, {
      face: 'floor',
      widthMm: 900,
      heightMm: 850,
      depthMm: 550,
      baseHeightMm: 0,
      basinVariant,
      basinShape: 'rectangular',
    });
  return defaults;
}

/** Keep model margins untouched; a connected toilet rim/lid/bowl provides an explicit alternative basis. */
export function hasSupportedReconstructionKind(candidate: ReconstructionCandidate): boolean {
  if (candidate.source === 'user' || candidate.evidence.meanMargin >= 1.5) return true;
  const parts = candidate.evidence.contextualParts;
  return (
    candidate.kind === 'toilet' &&
    candidate.evidence.contextualKind === 'toilet-assembly' &&
    !!parts &&
    parts.toiletPixels >= 100 &&
    parts.bowlPixels >= 100 &&
    parts.surroundRatio >= 0.5 &&
    candidate.evidence.meanMargin >= 0.8
  );
}
