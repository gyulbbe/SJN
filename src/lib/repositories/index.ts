import type { Repositories } from './contracts';
import { createLocalRepositories } from './local';
import { createCloudRepositories } from './cloud';
export type { Repositories } from './contracts';
export { StorageConflictError, StorageNotFoundError } from './references';

let repositories: Repositories | undefined;
let namespace = '';
let reinitializationRequired = false;
/** Called only after runtime selection and, for cloud, authenticated identity are known. */
export function initializeRepositories(mode: Repositories['mode'], userId = ''): Repositories {
  if (mode !== 'local' && !userId) throw new Error('로그인 확인이 필요해요.');
  const nextNamespace = JSON.stringify([mode, userId]);
  if (repositories && namespace === nextNamespace) return repositories;
  reinitializationRequired = false;
  namespace = nextNamespace;
  repositories = mode === 'local' ? createLocalRepositories() : createCloudRepositories(mode, userId);
  return repositories;
}
export function resetRepositories(): void {
  repositories = undefined;
  namespace = '';
  reinitializationRequired = true;
}
export function getRepositories(): Repositories {
  // Unit utilities and explicit local imports can use the default without a React tree.
  // AppProvider prevents mounting app views before initialization has completed.
  if (reinitializationRequired) throw new Error('작업 공간이 변경됐어요. 계정을 확인한 뒤 다시 열어 주세요.');
  return repositories ?? initializeRepositories('local');
}
