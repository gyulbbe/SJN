import type { ProductMesh, ProductPose } from './state-types';
export interface Product3dProgress {
  stage:
    | 'checking'
    | 'loading-runtime'
    | 'download'
    | 'initializing'
    | 'encoding'
    | 'reconstructing'
    | 'geometry'
    | 'coloring';
  message: string;
  loadedBytes?: number;
  totalBytes?: number;
  completed?: number;
  total?: number;
}
export interface Product3dTimings {
  downloadMs: number;
  initializationMs: number;
  processingMs: number;
  cacheSource: 'network' | 'cache';
  cacheNotice?: string;
  backend?: 'webgpu' | 'wasm';
  modelId: string;
  modelRevision: string;
}
export interface Product3dResult {
  mesh: ProductMesh;
  timings: Product3dTimings;
}
export type Product3dRequest = { type: 'run'; id: number; blob: Blob; forceCpu?: boolean };
export type Product3dReply =
  | { type: 'progress'; id: number; progress: Product3dProgress }
  | ({ type: 'mesh'; id: number } & Product3dResult)
  | { type: 'error'; id: number; message: string; retryCpu?: boolean; timings?: Product3dTimings };
export interface ProductInput {
  blob: Blob;
  name: string;
  sourceAssetId: string;
  existingAssetId?: string;
}
export interface Product3dApplication {
  mesh: ProductMesh;
  meshAssetId?: string;
  input: ProductInput;
  pose: ProductPose;
  modelId: string;
  modelRevision: string;
  capture: { blob: Blob; width: number; height: number; anchor: { x: number; y: number } };
}
