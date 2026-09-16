/** Structural subsets shared by Workers and the local Miniflare test bindings. */
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes?: number; [key: string]: unknown };
}
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
export interface D1DatabaseLike {
  prepare(query: string): D1Statement;
  batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}
export interface R2ObjectLike {
  key: string;
  size: number;
  etag: string;
}
export interface R2BodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2BodyLike | null>;
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
    },
  ): Promise<R2ObjectLike | null>;
  delete(key: string | string[]): Promise<void>;
}
export interface D1Bindings {
  DB: D1DatabaseLike;
  ASSET_BUCKET: R2BucketLike;
}
export interface D1Actor {
  id: string;
  isAdmin: boolean;
}
export type D1Resource =
  'projects' | 'materials' | 'assets' | 'cleanup' | 'role' | 'catalog' | 'project-materials';
