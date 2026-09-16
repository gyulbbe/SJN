import type { MaterialInput } from '../types';
import type { Repositories } from './contracts';
/** Project-derived geometry is private data, never a published catalog entry. */
export function createProjectMaterial(
  repo: Pick<Repositories, 'materials'> & Partial<Pick<Repositories, 'mode'>>,
  input: MaterialInput,
) {
  if (repo.mode === 'd1') {
    if (!repo.materials.createProjectResource) throw new Error('프로젝트 모형 저장 기능을 확인해 주세요.');
    return repo.materials.createProjectResource(input);
  }
  return repo.materials.create(input);
}
