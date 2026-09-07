import type { Point, Quad } from '../types';
import type { RoomFace } from '../room-types';

export type ReconstructionKind = 'toilet' | 'basin' | 'vanity' | 'bath' | 'mirror' | 'door' | 'window';
export type ReconstructionCandidate = {
  id: string;
  kind: ReconstructionKind;
  bounds: { left: number; top: number; right: number; bottom: number };
  foot: Point;
  color: string;
  pixels: number;
  /** Internal model evidence, never a calibrated accuracy percentage. */
  evidence: { semanticPixels: number; meanMargin: number };
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
  };
  /** Vertical intervals in the rectified source plane: 0 is its top, 1 its bottom. */
  bands?: { from: number; to: number; tile: ReconstructionPlane['tile'] }[];
};
export type ReconstructionReview = {
  version: 1;
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
};
export const RECONSTRUCTION_DEFAULTS: Record<
  ReconstructionKind,
  {
    widthMm: number;
    heightMm: number;
    depthMm: number;
    color: string;
    face: RoomFace;
  }
> = {
  toilet: { widthMm: 400, heightMm: 750, depthMm: 680, color: '#efefea', face: 'floor' },
  basin: { widthMm: 600, heightMm: 800, depthMm: 480, color: '#efefea', face: 'floor' },
  vanity: { widthMm: 1200, heightMm: 850, depthMm: 550, color: '#d3ddd9', face: 'floor' },
  bath: { widthMm: 1500, heightMm: 600, depthMm: 750, color: '#efefea', face: 'floor' },
  mirror: { widthMm: 600, heightMm: 800, depthMm: 25, color: '#a9b6b8', face: 'back' },
  door: { widthMm: 800, heightMm: 2000, depthMm: 60, color: '#d6ccba', face: 'left' },
  window: { widthMm: 1000, heightMm: 800, depthMm: 100, color: '#c7dce2', face: 'right' },
};
