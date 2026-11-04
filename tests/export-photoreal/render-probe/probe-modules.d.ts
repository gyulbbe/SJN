// three-gpu-pathtracer lives only in the probe's throwaway folder (tmp/export-photoreal/render-probe),
// never in the app, so its types are not installed here: the probe uses this much of it.
declare module 'three-gpu-pathtracer/webgpu' {
  export class WebGPUPathTracer {
    constructor(renderer: unknown);
    maxSamples: number;
    setScene(scene: unknown, camera: unknown): void;
    renderSample(): void;
    getSampleCountsAsync?(): Promise<unknown>;
    dispose(): void;
  }
}
