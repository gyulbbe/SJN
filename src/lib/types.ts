import type { RoomViewState } from './room-viewer/view-state';
import type { WallFeatureV1 } from './wall-features';
import type { MaterialUsageState } from './material-usage-types';
import type { ReconstructionReview, ReconstructionStandardOptions } from './reconstruction/types';
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
  reconstruction?: ReconstructionStandardOptions & {
    version: 1 | 2;
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
  | 'tile'
  | 'toilet'
  | 'basin'
  | 'vanity'
  | 'bath'
  | 'shower'
  | 'faucet'
  | 'mirror'
  | 'door'
  | 'window'
  | 'glassPartition'
  | 'mirrorCabinet'
  | 'wallShelf'
  | 'wallCabinet'
  | 'lowPartition'
  | 'showerCurtain';
/**
 * Read-only compatibility: what a material saved with the removed 360° editor still carries (the
 * stored shape is checked by product3dReferenceSchema). Nothing writes it any more and nothing
 * opens the mesh it points at; the view's `assetId` is the flat capture shown instead
 * (docs/product3d-removal.md).
 */
export interface Product3dReference {
  version: 1;
  meshAssetId: string;
  inputAssetId: string;
  pose: {
    objectQuaternion: [number, number, number, number];
    cameraQuaternion: [number, number, number, number];
    zoom: number;
  };
  modelId: string;
  modelRevision: string;
  shading?: 'mixed' | 'lit' | 'baked';
  fit?: { upright: [number, number, number, number]; front: number; mirror?: number; size: boolean };
  photoCamera?: {
    azimuth: number;
    elevation: number;
    distance: number;
    focal: number;
    shift: [number, number];
    iou: number;
  };
  gloss?: 'none' | 'light' | 'normal';
}
export type MaterialVersion = {
  catalog?: import('./catalog/contract').CatalogSelection;
  composition?: string;
  subcategoryName?: string;
  reconstruction?: { version: 1 | 2; kind: string };
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
  installation: 'floor' | 'wall' | 'embedded' | 'suspended';
  /** @deprecated Read-only compatibility for older catalogs; current images come from views/textures. */
  coverAssetId?: string;
  /** @deprecated Old introduction images remain referenced until their material version is removed. */
  imageAssetIds?: string[];
  textureAssetIds: string[];
  /**
   * One photo per direction (see product-direction.ts). `direction` is on the closed list once read
   * (readMaterialViews); `directionWas` carries a stored name that could not be read until the
   * material is edited and saved again.
   */
  views: {
    assetId: string;
    direction: string;
    anchor: Point;
    /** Read-only compatibility: an older 360° material (docs/product3d-removal.md). `assetId` is its flat capture. */
    product3d?: Product3dReference;
    directionWas?: string;
  }[];
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
type AssetBase = {
  id: string;
  ownerId: string;
  name: string;
  mime: string;
  size: number;
  sourceAssetId?: string;
  createdAt: string;
  blob: Blob;
};
export type ImageAssetRecord = AssetBase & {
  width: number;
  height: number;
  kind: 'original' | 'preview' | 'texture' | 'product' | 'background' | 'thumbnail';
  /** Distinguishes a resized upload from a deliberately edited image. */
  derivation?: 'upload-preview' | 'manual-alpha' | 'ai-alpha' | 'ai-multiview' | 'ai-product3d' | 'rectified';
};
export type ProductMeshAssetRecord = AssetBase & {
  kind: 'product-mesh';
  mime: 'application/x-sjn-product-mesh';
  sourceAssetId: string;
};
export type AssetRecord = ImageAssetRecord | ProductMeshAssetRecord;
export function isImageAsset(asset: AssetRecord): asset is ImageAssetRecord {
  return asset.kind !== 'product-mesh';
}
export type Scene = {
  room?: RoomDefinition;
  /** Scene-specific, explicitly authored wall structure; absent for legacy and blank scenes. */
  wallFeatures?: WallFeatureV1[];
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
/** Original local lab report and the completed user input; never a replacement for the editable scene. */
export type LabProjectSource = {
  version: 1;
  runId: string;
  inputFingerprint: string;
  reportJson: string;
  assetIds: string[];
  materialVersionIds: string[];
};
/**
 * The reference photo's light (exposure and white balance), estimated from its pixels when a
 * comparison is created. Before tiles and fixtures observed in the photo are stored delit; the
 * renders multiply by this light (at `strength`, when `enabled`), so unchanged Before surfaces are
 * not lit twice and new After materials sit in the photo's light.
 */
export type PhotoLighting = {
  version: 1;
  exposureEv: number;
  /** Linear RGB light colour, luminance 1. */
  gains: [number, number, number];
  method: 'ceramic' | 'achromatic';
  enabled: boolean;
  /** 0–1. */
  strength: number;
};
export type ComparisonState = {
  labSource?: LabProjectSource;
  /** Absent on comparisons made before 2026-09-27 and when the photo gave no evidence. */
  photoLighting?: PhotoLighting;
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
  /** Common viewing camera; never part of a design edit/history frame. */
  roomView?: RoomViewState;
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
  designPreviewContextKey?: string;
  /** Server-derived summary cache identity; absent in older/local summaries. */
  designPreviewRendererRevision?: string;
};
export type RenderSnapshot = {
  /** Used only by the spatial viewer; the existing frontal compositor remains unchanged. */
  roomView?: RoomViewState;
  scene: Scene;
  beforeScene?: Scene;
  materials: Record<string, MaterialVersion>;
  /** Linear RGB multiplier of the photo's light for both sides; absent means none (1, 1, 1). */
  lighting?: [number, number, number];
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
  shower: '샤워 설비',
  faucet: '수전',
  mirror: '거울',
  door: '문',
  window: '창',
  glassPartition: '유리 파티션',
  mirrorCabinet: '거울 수납장',
  wallShelf: '벽 선반',
  wallCabinet: '벽 수납장',
  lowPartition: '낮은 칸막이',
  showerCurtain: '샤워 커튼',
};
