import type { ProductFit } from './fit';
import type { PhotoCamera } from './photo-camera';
import type { ProductGloss } from './glaze';

export interface ProductMesh {
  positions: Float32Array;
  indices: Uint32Array;
  colors: Float32Array;
}
export interface ProductPose {
  objectQuaternion: [number, number, number, number];
  cameraQuaternion: [number, number, number, number];
  zoom: number;
}
export interface Product3dReference {
  version: 1;
  meshAssetId: string;
  inputAssetId: string;
  pose: ProductPose;
  modelId: string;
  modelRevision: string;
  /**
   * 'mixed': photographed side keeps the photo's detail, the rest is clean base colour (2026-10).
   * 'lit': base colours with viewer lighting. Absent (older saves) or 'baked': the model's own RGB.
   */
  shading?: ProductShading;
  /**
   * How the mesh is fitted to the product when it is loaded: real size, mirror symmetry, front
   * (2026-10). Absent (older saves): the mesh as it was made.
   */
  fit?: ProductFit;
  /**
   * The input photo's colours are put on the mesh through this camera (found from the outline, with
   * how well it matched). Absent (older saves, or the item off): the model's own colours (2026-10).
   */
  photoCamera?: PhotoCameraReference;
  /**
   * The glaze of a ceramic product in the lit modes (2026-10): 'light' or 'normal'. Absent (older
   * saves) or 'none': the matte material as before. Only ceramic categories use it (see glaze.ts).
   */
  gloss?: ProductGloss;
}
/** A camera found for the input photo and its outline match, 0–1. */
export type PhotoCameraReference = PhotoCamera & { iou: number };
export type ProductShading = 'mixed' | 'lit' | 'baked';
