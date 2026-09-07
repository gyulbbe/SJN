import { MAX_COMPARISON_DESIGNS } from '../designs';
import type { DesignDocument, MaterialVersion, RenderSnapshot } from '../types';
import { PhotoCompositor, type AssetReader } from './compositor';
import { fitOutput } from './math';
import {
  DESIGN_RENDER_REVISION,
  readDesignPreviewCache,
  writeDesignPreviewCache,
  type DesignPreviewCacheRecord,
} from './design-preview-cache';

export type PreviewDesign = Pick<DesignDocument, 'id' | 'name' | 'scene' | 'revision' | 'renderRevision'>;
export type DesignPreviewInput = {
  projectId: string;
  sharedRevision: number;
  design: PreviewDesign;
  materials: Record<string, MaterialVersion>;
  purpose?: 'thumbnail' | 'comparison';
  edge?: number;
};
export type DesignPreviewResult = { key: string; blob: Blob; width: number; height: number };
export class DesignPreviewCancelled extends Error {
  constructor() {
    super('미리보기 요청이 새 요청으로 바뀌었어요.');
    this.name = 'DesignPreviewCancelled';
  }
}
export interface DesignPreviewRenderer {
  readonly maxOutputEdge: number;
  setSnapshot(
    snapshot: RenderSnapshot,
    reader: AssetReader,
    options?: { maxPreviewEdge?: number },
  ): Promise<void>;
  render(width: number, height: number, mode?: 'after'): HTMLCanvasElement;
  exportImage(
    snapshot: RenderSnapshot,
    width: number,
    height: number,
    format: 'image/png',
    compare: boolean,
  ): Promise<Blob>;
  dispose(): void;
}
type Dependencies = {
  createRenderer?: () => DesignPreviewRenderer;
  capture?: (canvas: HTMLCanvasElement) => Promise<Blob>;
  readCache?: typeof readDesignPreviewCache;
  writeCache?: typeof writeDesignPreviewCache;
};
type Job = {
  channel: string;
  ticket: number;
  run: (current: () => void) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};
const snapshotFor = (input: DesignPreviewInput): RenderSnapshot => {
  const ids = new Set(
    [
      ...input.design.scene.surfaces.map((surface) => surface.materialVersionId),
      ...input.design.scene.fixtures.map((fixture) => fixture.materialVersionId),
    ].filter((id): id is string => !!id),
  );
  return structuredClone({
    scene: input.design.scene,
    materials: Object.fromEntries([...ids].sort().map((id) => [id, input.materials[id]])),
  });
};
export function designPreviewSize(input: DesignPreviewInput) {
  const edge =
    input.purpose === 'thumbnail' || !input.purpose
      ? 360
      : Math.max(256, Math.min(2048, Math.round(input.edge ?? 1200)));
  return fitOutput(input.design.scene.imageWidth, input.design.scene.imageHeight, edge);
}
export async function designPreviewKey(input: DesignPreviewInput): Promise<string> {
  const source = JSON.stringify([
    DESIGN_RENDER_REVISION,
    input.projectId,
    input.design.id,
    input.design.renderRevision ?? input.design.revision,
    input.sharedRevision,
    input.purpose ?? 'thumbnail',
    designPreviewSize(input),
    snapshotFor(input),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function canvasBlob(source: HTMLCanvasElement): Promise<Blob> {
  // Copy before asynchronous PNG encoding; the next queued render cannot change this image.
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  const context = copy.getContext('2d');
  if (!context) return Promise.reject(new Error('시안 이미지를 준비하지 못했어요.'));
  context.drawImage(source, 0, 0);
  return new Promise((resolve, reject) =>
    copy.toBlob((blob) => {
      copy.width = copy.height = 1;
      if (blob) resolve(blob);
      else reject(new Error('시안 이미지를 만들지 못했어요.'));
    }, 'image/png'),
  );
}
export function designGrid(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_COMPARISON_DESIGNS)
    throw new Error('비교할 시안은 1–5개여야 해요.');
  const columns = count === 4 ? 2 : Math.min(count, 3);
  return { columns, rows: Math.ceil(count / columns) };
}

/** One DOM/WebGL renderer with a serial queue. This is deliberately not advertised as a worker. */
export class DesignPreviewService {
  private renderer?: DesignPreviewRenderer;
  private queue: Job[] = [];
  private running = false;
  private disposed = false;
  private sequence = 0;
  private latest = new Map<string, number>();
  private active?: Job;
  private memory = new Map<string, DesignPreviewResult>();
  private readonly dependencies: Required<Dependencies>;
  constructor(
    private readonly reader: AssetReader,
    dependencies: Dependencies = {},
  ) {
    this.dependencies = {
      createRenderer: dependencies.createRenderer ?? (() => new PhotoCompositor()),
      capture: dependencies.capture ?? canvasBlob,
      readCache: dependencies.readCache ?? readDesignPreviewCache,
      writeCache: dependencies.writeCache ?? writeDesignPreviewCache,
    };
  }
  private getRenderer() {
    if (this.disposed) throw new DesignPreviewCancelled();
    return (this.renderer ??= this.dependencies.createRenderer());
  }
  private remember(result: DesignPreviewResult) {
    this.memory.delete(result.key);
    this.memory.set(result.key, result);
    let bytes = [...this.memory.values()].reduce((sum, entry) => sum + entry.blob.size, 0);
    for (const [key, entry] of this.memory) {
      if (this.memory.size <= 24 && bytes <= 32 * 1024 * 1024) break;
      this.memory.delete(key);
      bytes -= entry.blob.size;
    }
  }
  cancel(channel: string) {
    this.latest.delete(channel);
    for (const job of this.queue) if (job.channel === channel) job.reject(new DesignPreviewCancelled());
    this.queue = this.queue.filter((job) => job.channel !== channel);
    if (this.active?.channel === channel) this.active.reject(new DesignPreviewCancelled());
  }
  private schedule<T>(channel: string, run: (current: () => void) => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new DesignPreviewCancelled());
    this.cancel(channel);
    const ticket = ++this.sequence;
    this.latest.set(channel, ticket);
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({ channel, ticket, run, resolve: (value) => resolve(value as T), reject });
    });
    void this.drain();
    return promise;
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.disposed) {
        const job = this.queue.shift()!;
        this.active = job;
        const current = () => {
          if (this.disposed || this.latest.get(job.channel) !== job.ticket)
            throw new DesignPreviewCancelled();
        };
        try {
          current();
          const result = await job.run(current);
          current();
          job.resolve(result);
        } catch (error) {
          job.reject(error);
        } finally {
          this.active = undefined;
        }
        // Allow input/paint between complete images, without relying on fake progress or fixed delays.
        if (this.queue.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      this.running = false;
    }
  }
  request(channel: string, source: DesignPreviewInput): Promise<DesignPreviewResult> {
    const snapshot = snapshotFor(source);
    const input = {
      ...source,
      design: { ...source.design, scene: snapshot.scene },
      materials: snapshot.materials,
    };
    return this.schedule(channel, async (current) => {
      const key = await designPreviewKey(input),
        size = designPreviewSize(input);
      current();
      const remembered = this.memory.get(key);
      if (remembered) {
        this.remember(remembered);
        return remembered;
      }
      const cached = await this.dependencies.readCache(key);
      current();
      if (cached) {
        const result = { key, blob: cached.blob, width: cached.width, height: cached.height };
        this.remember(result);
        return result;
      }
      const renderer = this.getRenderer();
      await renderer.setSnapshot(snapshot, this.reader, {
        maxPreviewEdge: Math.max(size.width, size.height),
      });
      current();
      const canvas = renderer.render(size.width, size.height, 'after');
      const blob = await this.dependencies.capture(canvas);
      current();
      const result = { key, blob, width: size.width, height: size.height };
      const record: DesignPreviewCacheRecord = {
        ...result,
        projectId: input.projectId,
        designId: input.design.id,
        revision: input.design.renderRevision ?? input.design.revision,
        sharedRevision: input.sharedRevision,
        purpose: input.purpose ?? 'thumbnail',
        rendererRevision: DESIGN_RENDER_REVISION,
        updatedAt: Date.now(),
      };
      await this.dependencies.writeCache(record);
      current();
      this.remember(result);
      return result;
    });
  }
  exportDesign(channel: string, input: DesignPreviewInput): Promise<Blob> {
    const snapshot = snapshotFor(input);
    return this.schedule(channel, async (current) => {
      const renderer = this.getRenderer();
      await renderer.setSnapshot(snapshot, this.reader, { maxPreviewEdge: 360 });
      current();
      const blob = await renderer.exportImage(snapshot, 4096, 4096, 'image/png', false);
      current();
      return blob;
    });
  }
  exportComparison(channel: string, inputs: DesignPreviewInput[]): Promise<Blob> {
    const snapshots = inputs.map(snapshotFor),
      grid = designGrid(inputs.length);
    return this.schedule(channel, async (current) => {
      const renderer = this.getRenderer();
      const aspect = snapshots[0].scene.imageWidth / snapshots[0].scene.imageHeight;
      if (snapshots.some(({ scene }) => Math.abs(scene.imageWidth / scene.imageHeight - aspect) > 0.00001))
        throw new Error('같은 비율의 공간만 나란히 비교할 수 있어요.');
      const edge = Math.min(
        renderer.maxOutputEdge,
        4096,
        ...snapshots.map(({ scene }) => Math.max(scene.imageWidth, scene.imageHeight)),
      );
      const ratio = (aspect * grid.columns) / grid.rows;
      const width = Math.round(ratio >= 1 ? edge : edge * ratio),
        height = Math.round(ratio >= 1 ? edge / ratio : edge);
      const cellWidth = Math.floor(width / grid.columns),
        cellHeight = Math.floor(height / grid.rows);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('비교 이미지를 준비하지 못했어요.');
      context.fillStyle = '#f3f4f2';
      context.fillRect(0, 0, width, height);
      for (const [index, snapshot] of snapshots.entries()) {
        current();
        await renderer.setSnapshot(snapshot, this.reader, { maxPreviewEdge: 360 });
        const blob = await renderer.exportImage(
          snapshot,
          Math.max(cellWidth, cellHeight),
          Math.max(cellWidth, cellHeight),
          'image/png',
          false,
        );
        current();
        const bitmap = await createImageBitmap(blob);
        try {
          current();
          context.drawImage(
            bitmap,
            (index % grid.columns) * cellWidth,
            Math.floor(index / grid.columns) * cellHeight,
            cellWidth,
            cellHeight,
          );
        } finally {
          bitmap.close();
        }
      }
      const blob = await canvasBlob(canvas);
      canvas.width = canvas.height = 1;
      current();
      return blob;
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.latest.clear();
    this.active?.reject(new DesignPreviewCancelled());
    for (const job of this.queue) job.reject(new DesignPreviewCancelled());
    this.queue = [];
    this.memory.clear();
    this.renderer?.dispose();
    this.renderer = undefined;
  }
}
const sessions = new Map<string, { service: DesignPreviewService; references: number }>();
export function acquireDesignPreviewSession(projectId: string, reader: AssetReader) {
  let entry = sessions.get(projectId);
  if (!entry) {
    entry = { service: new DesignPreviewService(reader), references: 0 };
    sessions.set(projectId, entry);
  }
  entry.references++;
  const captured = entry;
  let released = false;
  return {
    service: captured.service,
    release() {
      if (released) return;
      released = true;
      captured.references--;
      if (captured.references === 0) {
        // React effect replacement releases then reacquires in the same flush. Retain decoded
        // assets for that handover; a genuine unmount closes the context on the next task.
        setTimeout(() => {
          if (captured.references !== 0) return;
          captured.service.dispose();
          if (sessions.get(projectId) === captured) sessions.delete(projectId);
        }, 0);
      }
    },
  };
}
export async function renderDesignThumbnail(
  input: Omit<DesignPreviewInput, 'purpose' | 'edge'>,
  reader: AssetReader,
) {
  const session = acquireDesignPreviewSession(input.projectId, reader);
  try {
    return await session.service.request('save-thumbnail:' + input.design.id, {
      ...input,
      purpose: 'thumbnail',
    });
  } finally {
    session.release();
  }
}
