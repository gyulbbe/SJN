import type { Point, Quad } from '../types';
import type { ProductBounds, RoomFace } from '../room-types';
import type { ReconstructionKind } from './types';

export const OBSERVED_ANCHOR_BOUNDS_TOLERANCE = 0.01;

/** Only observations belong here: no generated geometry or photograph-derived millimetres. */
/** Internal support vocabulary. New values do not extend a frozen model response grammar. */
export type SceneMounting = 'wall' | 'floor' | 'countertop' | 'ceiling' | 'suspended' | 'unknown';
export type SceneWall = Exclude<RoomFace, 'floor'> | 'unknown';
export type SceneBasinStyle = 'wall' | 'pedestal' | 'vanity' | 'unknown';
export type SceneShape = 'rectangular' | 'round' | 'unknown';
export type SceneReflection = 'physical' | 'reflected' | 'uncertain';
export type SceneFieldSource = 'model' | 'geometry' | 'default' | 'user';
export type SourceRoomCorner =
  | 'back-top-left'
  | 'back-top-right'
  | 'back-bottom-right'
  | 'back-bottom-left'
  | 'front-top-left'
  | 'front-top-right'
  | 'front-bottom-right'
  | 'front-bottom-left';
export type SceneValidationIssue = { code: string; message: string };
export type SceneCandidate = {
  id: string;
  kind: ReconstructionKind | 'unknown';
  bounds: ProductBounds;
  mounting: SceneMounting;
  wall: SceneWall;
  basinStyle: SceneBasinStyle;
  /** Observed or user-confirmed bowls, never inferred from cabinet width. Omission means unknown. */
  bowlCount?: 1 | 2;
  shape: SceneShape;
  reflection: SceneReflection;
  evidence: string[];
  uncertainty: string[];
  /** Explicitly observed contact/attachment, never an automatically labelled bbox centre. */
  anchor?: {
    point: Point;
    kind: 'floor-contact' | 'wall-attachment' | 'countertop-contact';
    evidence: string[];
    uncertainty: string[];
  };
  /** Structurally readable observations with semantic errors remain visible but cannot auto-place. */
  validation?: { status: 'needs-review'; issues: SceneValidationIssue[] };
  provenance?: Partial<
    Record<'kind' | 'mounting' | 'wall' | 'shape' | 'position' | 'bowlCount', SceneFieldSource>
  >;
};
/** reflectionOf: frontId is reflected, behindId physical. partOf: frontId basin child, behindId vanity support. */
export type SceneRelation = {
  frontId: string;
  behindId: string;
  relation: 'occludes' | 'visibleThrough' | 'reflectionOf' | 'partOf' | 'uncertain';
  evidence: string[];
  /** Internal metadata. Model JSON cannot declare this field; user overrides are validated separately. */
  provenance?: 'model' | 'user';
};
export type SourceRoomLine = {
  axis: 'width' | 'height' | 'depth';
  start: Point;
  end: Point;
  /** Actual parallel room edges/tile lines, never invented continuation across an occluder. */
  evidence: string[];
};
export type SceneRoomLayout = {
  /** TL, TR, BR, BL of the actual complete back wall. Cropped/unseen corners must be null. */
  backWallQuad?: Quad | null;
  orthogonal: boolean | 'unknown';
  evidence: string[];
  uncertainty: string[];
  lines?: SourceRoomLine[];
  /** Front corners are actual room corners, never the image crop boundary. */
  corners?: { corner: SourceRoomCorner; point: Point; evidence: string[] }[];
};
export type SceneUnderstanding = {
  schemaVersion: 1;
  candidates: SceneCandidate[];
  relations: SceneRelation[];
  roomLayout: SceneRoomLayout;
  /** Derived validation, not model assertions. Invalid relations are retained here rather than applied. */
  validation?: {
    rawCandidateCount: number;
    quarantinedRelations: { relation: SceneRelation; issues: SceneValidationIssue[] }[];
    roomLayoutIssues: SceneValidationIssue[];
  };
};
