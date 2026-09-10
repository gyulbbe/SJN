export interface BackgroundRemovalProgress {
  stage: 'loading-runtime' | 'checking' | 'download' | 'initializing' | 'processing' | 'encoding';
  message: string;
  loadedBytes?: number;
  totalBytes?: number;
}

export interface BackgroundRemovalResult {
  blob: Blob;
  width: number;
  height: number;
  analysisWidth: 512;
  analysisHeight: 512;
  backend: 'webgpu' | 'wasm';
  precision: 'fp16' | 'fp32';
  /** Network model transfer only. Cache reads and runtime loading are initialization time. */
  downloadMs: number;
  initializationMs: number;
  /** Decoding, preparation, inference, mask upsampling and PNG encoding; excludes model loading. */
  processingMs: number;
  inferenceMs: number;
  cacheSource: 'network' | 'cache' | 'memory';
  fallbackReason?: string;
  cacheNotice?: string;
}

export type BackgroundRemovalAttemptTimings = Pick<
  BackgroundRemovalResult,
  'downloadMs' | 'initializationMs' | 'processingMs' | 'inferenceMs' | 'cacheSource'
>;

export type BackgroundRemovalRequest = {
  type: 'run';
  id: number;
  blob: Blob;
  forceCpu?: boolean;
  fallbackReason?: string;
};
export type BackgroundRemovalReply =
  | { type: 'progress'; id: number; progress: BackgroundRemovalProgress }
  | { type: 'result'; id: number; result: BackgroundRemovalResult }
  | { type: 'error'; id: number; message: string }
  | { type: 'retry-cpu'; id: number; message: string; timings: BackgroundRemovalAttemptTimings };
