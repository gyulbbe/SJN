import type { Repositories } from './contracts';
import { createCloudRepositories } from './cloud';
export type { Repositories } from './contracts';
export { StorageConflictError, StorageNotFoundError } from './references';

let repositories: Repositories | undefined;
let namespace = '';
let activeUserId = '';
let reinitializationRequired = false;
/** Called only after runtime selection and, for cloud, authenticated identity are known. */
export function initializeRepositories(mode: Repositories['mode'], userId = ''): Repositories {
  if (mode !== 'd1') throw new Error('D1 저장소만 사용할 수 있어요.');
  if (!userId) throw new Error('로그인 확인이 필요해요.');
  const nextNamespace = JSON.stringify([mode, userId]);
  if (repositories && namespace === nextNamespace) return repositories;
  reinitializationRequired = false;
  namespace = nextNamespace;
  activeUserId = userId;
  repositories = createCloudRepositories(mode, userId);
  return repositories;
}
export function resetRepositories(): void {
  repositories = undefined;
  namespace = '';
  activeUserId = '';
  reinitializationRequired = true;
}
export function getRepositories(): Repositories {
  if (reinitializationRequired) throw new Error('작업 공간이 변경됐어요. 계정을 확인한 뒤 다시 열어 주세요.');
  if (!repositories) throw new Error('로그인 확인 후 작업 공간을 열어 주세요.');
  return repositories;
}

/** Capture when an operation starts; never upload its result under a later account. */
export function getRepositoryUserId(): string {
  return activeUserId;
}
