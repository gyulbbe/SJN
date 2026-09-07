import type {
  AssetRecord,
  Material,
  MaterialInput,
  MaterialVersion,
  ProjectDocument,
  ProjectInput,
  ProjectSummary,
} from '../types';
export interface ProjectRepository {
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<ProjectDocument>;
  create(document: ProjectInput): Promise<ProjectDocument>;
  save(document: ProjectInput, expectedStorageRevision: number): Promise<ProjectDocument>;
  duplicate(id: string): Promise<ProjectDocument>;
  remove(id: string): Promise<void>;
}
export interface MaterialRepository {
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
export type Repositories = {
  projects: ProjectRepository;
  materials: MaterialRepository;
  assets: AssetRepository;
  mode: 'local' | 'supabase';
};
