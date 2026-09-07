import type { MaterialUsageState } from './material-usage-types';
import type { ReconstructionReview } from './reconstruction/types';
import type { RoomDefinition, RoomFace, RoomPlacement } from './room-types';
import type { MaterialPricing, QuoteDocument } from './quote-types';
export type Point = { x: number; y: number };
export type Quad = [Point, Point, Point, Point];
export type ColorAdjust = { exposure: number; contrast: number; saturation: number; warmth: number };
export const DEFAULT_COLOR: ColorAdjust = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
export type Stroke = { points: Point[]; radius: number; erase: boolean };
export type Mask = { polygon: Point[]; polygons?: Point[][]; holes?: Point[][]; strokes: Stroke[] };
export type TileSettings = {
  rotation: number;
  offsetX: number;
  offsetY: number;
  groutWidth: number;
  groutColor: string;
  pattern: 'grid' | 'brick';
  seed: number;
  shading: number;
};
export type Surface = {
  roomFace?: RoomFace;
  geometryMode?: 'room' | 'manual';
  /** Vertical interval of the whole generated wall, top=0 and floor=1. */
  reconstructionBand?: { from: number; to: number };
  id: string;
  name: string;
  kind: 'floor' | 'wall';
  mask: Mask;
  quad: Quad;
  widthMm: number;
  heightMm: number;
  calibrated: boolean;
  materialVersionId?: string;
  tile: TileSettings;
  color: ColorAdjust;
};
export type FixtureInstance = {
  reconstruction?: {
    version: 1;
    kind: string;
    color: string;
    widthMm: number;
    heightMm: number;
    depthMm: number;
    orientation?: 'back' | 'left' | 'right';
    appearanceAssetId?: string;
  };
  projectedQuad?: Quad;
  roomPlacement?: RoomPlacement;
  id: string;
  name: string;
  materialVersionId: string;
  viewIndex: number;
  position: Point;
  width: number;
  height: number;
  rotation: number;
  anchor: Point;
  locked: boolean;
  shadow: { x: number; y: number; opacity: number; blur: number; scale: number };
  occlusion: Mask;
  color: ColorAdjust;
};
export type MaterialCategory =
  'tile' | 'toilet' | 'basin' | 'vanity' | 'bath' | 'shower' | 'faucet' | 'mirror' | 'door' | 'window';
export type MaterialVersion = {
  reconstruction?: { version: 1; kind: string };
  pricing?: MaterialPricing;
  id: string;
  materialId: string;
  version: number;
  name: string;
  brand: string;
  code: string;
  category: MaterialCategory;
  scope: 'personal' | 'shared';
  description: string;
  color: string;
  finish: string;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  usage: 'wall' | 'floor' | 'both';
  installation: 'floor' | 'wall' | 'embedded';
  coverAssetId: string;
  imageAssetIds: string[];
  textureAssetIds: string[];
  views: { assetId: string; direction: string; anchor: Point }[];
  defaultGroutWidth: number;
  defaultGroutColor: string;
  defaultPattern: 'grid' | 'brick';
  createdAt: string;
};
export type Material = {
  id: string;
  ownerId: string;
  currentVersionId: string;
  active: boolean;
  scope: 'personal' | 'shared';
  updatedAt: string;
};
export type AssetRecord = {
  id: string;
  ownerId: string;
  name: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  kind: 'original' | 'preview' | 'texture' | 'product' | 'background' | 'thumbnail';
  sourceAssetId?: string;
  createdAt: string;
  blob: Blob;
};
export type Scene = {
  room?: RoomDefinition;
  originalAssetId: string;
  previewAssetId: string;
  backgroundAssetId?: string;
  imageWidth: number;
  imageHeight: number;
  surfaces: Surface[];
  protection: Mask;
  fixtures: FixtureInstance[];
  color: ColorAdjust;
};
export type ComparisonState = {
  before: Scene;
  room: RoomDefinition;
  cameraVersion: 1;
  aspect: number;
  referenceOriginalAssetId: string;
  referencePreviewAssetId: string;
  /** Before review metadata only; After editing, comparison, quotation and export remain available. */
  status: 'draft' | 'confirmed';
  review?: ReconstructionReview;
};
/** Read-only compatibility envelope for the original one-design documents and their frames. */
export type ProjectFrame = Scene & { comparison?: ComparisonState };
type ProjectMetadata = {
  id: string;
  ownerId: string;
  name: string;
  editRevision: number;
  storageRevision: number;
  createdAt: string;
  updatedAt: string;
  thumbnailAssetId?: string;
};
export type LegacyProjectDocument = ProjectMetadata & {
  schemaVersion: 1 | 2;
  scene: Scene;
  comparison?: ComparisonState;
  quote?: QuoteDocument;
  history: { past: ProjectFrame[]; future: ProjectFrame[] };
  viewport: { zoom: number; pan: Point };
};
export type DesignFrame = { scene: Scene; quote?: QuoteDocument; materialUsage?: MaterialUsageState };
export type BeforeFrame = { baseline: Scene; comparison?: ComparisonState };
export type DesignDocument = DesignFrame & {
  id: string;
  sourceDesignId?: string;
  name: string;
  revision: number;
  /** Advances only when the visible After scene changes, never for costs or names. */
  renderRevision?: number;
  history: { past: DesignFrame[]; future: DesignFrame[] };
  createdAt: string;
  updatedAt: string;
  thumbnailAssetId?: string;
};
export type SharedWorkspace = BeforeFrame & {
  revision: number;
  beforeHistory: { past: BeforeFrame[]; future: BeforeFrame[] };
  /** Original old-size/combined frames are retained without copying image bodies. */
  legacyHistory?: { past: ProjectFrame[]; future: ProjectFrame[] };
};
/** A complete room-change checkpoint has no checkpoint field of its own. */
export type WorkspaceSnapshot = {
  shared: SharedWorkspace;
  designs: DesignDocument[];
  activeDesignId: string | null;
  comparisonDesignIds: string[];
  viewport: { zoom: number; pan: Point };
};
export type ProjectDocument = ProjectMetadata &
  WorkspaceSnapshot & {
    schemaVersion: 3;
    roomHistory: { past?: WorkspaceSnapshot; future?: WorkspaceSnapshot };
  };
export type ProjectInput = LegacyProjectDocument | ProjectDocument;
export type ProjectSummary = Pick<ProjectDocument, 'id' | 'name' | 'updatedAt' | 'thumbnailAssetId'> & {
  previewAssetId: string;
  activeDesignId: string | null;
  activeDesignRevision: number;
  sharedRevision: number;
};
export type RenderSnapshot = {
  scene: Scene;
  beforeScene?: Scene;
  materials: Record<string, MaterialVersion>;
};
export type MaterialInput = Omit<MaterialVersion, 'id' | 'materialId' | 'version' | 'createdAt'>;
export const EMPTY_MASK = (): Mask => ({ polygon: [], strokes: [] });
export const DEFAULT_TILE: TileSettings = {
  rotation: 0,
  offsetX: 0,
  offsetY: 0,
  groutWidth: 2,
  groutColor: '#d5d1c9',
  pattern: 'grid',
  seed: 12,
  shading: 0.25,
};
export const categoryLabels: Record<MaterialCategory, string> = {
  tile: '타일',
  toilet: '변기',
  basin: '세면대',
  vanity: '하부장',
  bath: '욕조',
  shower: '샤워부스',
  faucet: '수전',
  mirror: '거울',
  door: '문',
  window: '창',
};
