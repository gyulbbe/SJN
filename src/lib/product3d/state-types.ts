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
}
export type ProductShading = 'mixed' | 'lit' | 'baked';
