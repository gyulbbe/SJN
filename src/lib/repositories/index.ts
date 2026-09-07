import type { Repositories } from './contracts';
import { createLocalRepositories } from './local';
import { createCloudRepositories } from './cloud';
export type { Repositories } from './contracts';
export { StorageConflictError, StorageNotFoundError } from './references';

let repositories: Repositories | undefined;
export function getRepositories(): Repositories {
  if (repositories) return repositories;
  const mode = process.env.NEXT_PUBLIC_STORAGE_MODE ?? 'local';
  if (mode === 'local') return (repositories = createLocalRepositories());
  if (mode === 'supabase') return (repositories = createCloudRepositories());
  throw new Error(`지원하지 않는 저장 모드예요: ${mode}`);
}
