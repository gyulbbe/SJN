import type { GeometryRequestMetadata } from '../geometry-contract';
import type { MOGE_ARTIFACT } from './artifact';
import type { MogeDensePrediction } from './postprocess';
import type { MogePlaneResult } from './planes';

export type MogeExecutionMode = 'auto' | 'webgpu' | 'wasm';
export type MogeBackend = Exclude<MogeExecutionMode, 'auto'>;
export type MogeProgress = {
  stage:
    | 'checking'
    | 'cache'
    | 'downloading'
    | 'verifying'
    | 'loading-runtime'
    | 'initializing'
    | 'preprocessing'
    | 'inference'
    | 'postprocessing'
    | 'planes';
  message: string;
  loaded?: number;
  total?: number;
  cacheSource?: 'network' | 'cache' | 'memory';
};
/** Actual ONNX forward outputs. BHWC vectors, BHW mask, batch=1; activations are already applied. */
export type MogeRawPrediction = {
  width: number;
  height: number;
  points: Float32Array;
  normal: Float32Array;
  mask: Float32Array;
  metricScale: number;
};
export type MogeGeometryInput = { metadata: GeometryRequestMetadata; floor: Uint8Array; wall: Uint8Array };
export type MogeTimings = {
  downloadMs: number;
  cacheMs: number;
  initializationMs: number;
  preprocessingMs: number;
  inferenceMs: number;
  postprocessingMs: number;
  planeExtractionMs: number;
  totalMs: number;
};
export type MogeBrowserResult = {
  raw: MogeRawPrediction;
  dense: MogeDensePrediction;
  planes?: MogePlaneResult;
  backend: MogeBackend;
  requestedMode: MogeExecutionMode;
  fallbackReason?: string;
  cacheSource: 'network' | 'cache' | 'memory';
  cacheNotice?: string;
  timings: MogeTimings;
  metadata: {
    artifact: typeof MOGE_ARTIFACT;
    runtimeVersion: string;
    preprocessVersion: string;
    sourceWidth: number;
    sourceHeight: number;
    inputWidth: number;
    inputHeight: number;
    numTokens: number;
    precision: 'fp32';
    wasmThreads: number;
    crossOriginIsolated: boolean;
    memoryBytes: null;
  };
};
export type MogeModelBytes = {
  bytes: Uint8Array<ArrayBuffer>;
  downloadMs: number;
  cacheMs: number;
  cacheSource: 'network' | 'cache' | 'memory';
  cacheNotice?: string;
};
export type MogeRequest = {
  type: 'run';
  id: number;
  blob: Blob;
  mode: MogeExecutionMode;
  modelUrl: string;
  geometry?: MogeGeometryInput;
  model?: MogeModelBytes;
  fallbackReason?: string;
  carryTimings?: MogeTimings;
};
export type MogeReply =
  | { type: 'progress'; id: number; progress: MogeProgress }
  | { type: 'result'; id: number; result: MogeBrowserResult }
  | { type: 'retry-cpu'; id: number; message: string; model: MogeModelBytes; timings: MogeTimings }
  | {
      type: 'error';
      id: number;
      message: string;
      code: 'download' | 'integrity' | 'runtime' | 'input' | 'geometry';
    };
