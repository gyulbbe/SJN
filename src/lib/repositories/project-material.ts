import type { MaterialInput } from '../types';
import type { RepositoryOperations } from './contracts';
/** Project-derived geometry is private data, never a published catalog entry. */
export function createProjectMaterial(
  repo: Pick<RepositoryOperations, 'materials'>,
  input: MaterialInput,
) {
  if (!repo.materials.createProjectResource) throw new Error('프로젝트 모형 저장 기능을 확인해 주세요.');
  return repo.materials.createProjectResource(input);
}
