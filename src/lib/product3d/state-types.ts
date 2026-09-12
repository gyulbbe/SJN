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
}
