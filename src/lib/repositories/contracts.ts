import type {
  AssetRecord,
  Material,
  MaterialInput,
  MaterialVersion,
  ProjectDocument,
  ProjectInput,
  ProjectSummary,
} from '../types';
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
export interface MaterialRepository {
  createProjectResource?(input: MaterialInput): Promise<MaterialVersion>;
  list(): Promise<{ material: Material; version: MaterialVersion }[]>;
  getVersion(id: string): Promise<MaterialVersion>;
  create(input: MaterialInput): Promise<MaterialVersion>;
  update(id: string, input: MaterialInput, expectedVersionId: string): Promise<MaterialVersion>;
  setActive(id: string, active: boolean): Promise<void>;
}
export interface AssetRepository {
  put(asset: AssetRecord): Promise<void>;
  get(id: string): Promise<AssetRecord>;
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
