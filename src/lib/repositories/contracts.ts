import type {
  AssetRecord,
  Material,
  MaterialInput,
  MaterialVersion,
  ProjectDocument,
  ProjectInput,
  ProjectSummary,
} from '../types';
import type { MaterialCard } from '../catalog/cards';
import type { ListImagePage } from '../d1/list-images';
import type { LibraryScope, MaterialPage, MaterialPageQuery } from '../catalog/paging';
/** A complete in-memory project export; imported together or not at all. */
export type ProjectResourceBundle = {
  document: ProjectDocument;
  assets: AssetRecord[];
  versions: MaterialVersion[];
};
export interface ProjectRepository {
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<ProjectDocument>;
  create(document: ProjectInput): Promise<ProjectDocument>;
  save(document: ProjectInput, expectedStorageRevision: number): Promise<ProjectDocument>;
  duplicate(id: string): Promise<ProjectDocument>;
  remove(id: string): Promise<void>;
}
export type MaterialEntry = { material: Material; version: MaterialVersion };
/** `getVersions`: the readable versions asked for, and (when asked) each one's material as lists show it. */
export type VersionBatch = { versions: MaterialVersion[]; current: MaterialEntry[] };
/** A reconstruction material the photo analysis made before (same code and kind). */
export type ReconstructionMatch = {
  code: string;
  reconstruction: { version: 1 | 2 } | { kind: 'tile' };
};
export type MaterialListOptions = { view?: 'picker' | 'library'; scope?: LibraryScope; active?: boolean };
export interface MaterialRepository {
  createProjectResource?(input: MaterialInput): Promise<MaterialVersion>;
  /** One page of the list a screen shows (docs/material-paging-results-20261022.md). */
  page(query: MaterialPageQuery, options?: MaterialListOptions): Promise<MaterialPage<MaterialCard>>;
  /** Versions in one request (up to 100 per call; more are split). */
  getVersions(ids: string[], options?: { withCurrent?: boolean }): Promise<VersionBatch>;
  find(match: ReconstructionMatch): Promise<MaterialVersion | null>;
  /** Administrator list image backfill: card images and whether each has a list image (by ids or a page). */
  listImages?(
    request: { ids: string[] } | { cursor?: string },
  ): Promise<ListImagePage | { listed: string[] }>;
  getVersion(id: string): Promise<MaterialVersion>;
  create(input: MaterialInput): Promise<MaterialVersion>;
  update(id: string, input: MaterialInput, expectedVersionId: string): Promise<MaterialVersion>;
  setActive(id: string, active: boolean): Promise<void>;
  /** Administrator: a shared material's priority in the lists (1 first), or null to clear it. */
  setPriority?(id: string, priority: number | null): Promise<{ priority: number | null }>;
}
export interface AssetRepository {
  put(asset: AssetRecord): Promise<void>;
  get(id: string): Promise<AssetRecord>;
  /** A card's small copy of image `id` (the image itself when it has none); same permission as `get`. */
  getListImage?(id: string): Promise<AssetRecord>;
  removeUnused(): Promise<number>;
}
/** Storage operations usable by temporary analysis stores as well as authenticated repositories. */
export type RepositoryOperations = {
  projects: ProjectRepository;
  materials: MaterialRepository;
  assets: AssetRepository;
};
/** The only persistent application repository; temporary analysis stores use operations directly. */
export type Repositories = RepositoryOperations & {
  mode: 'd1';
  materials: MaterialRepository & Required<Pick<MaterialRepository, 'createProjectResource'>>;
};
