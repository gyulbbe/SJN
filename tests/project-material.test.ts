import { describe, expect, it, vi } from 'vitest';
import { createProjectMaterial } from '../src/lib/repositories/project-material';
import type { RepositoryOperations } from '../src/lib/repositories/contracts';
import type { MaterialInput } from '../src/lib/types';

const input = { name: '프로젝트 전용 모형' } as MaterialInput;
describe('project-derived material storage boundary', () => {
  it('uses the project resource operation without publishing to the catalog', async () => {
    const result = { id: 'version' };
    const create = vi.fn();
    const createProjectResource = vi.fn().mockResolvedValue(result);
    const repo = { materials: { create, createProjectResource } } as unknown as RepositoryOperations;
    expect(await createProjectMaterial(repo, input)).toBe(result);
    expect(createProjectResource).toHaveBeenCalledWith(input);
    expect(create).not.toHaveBeenCalled();
  });
  it('fails closed when project resources are unsupported instead of using legacy catalog creation', () => {
    const create = vi.fn();
    const repo = { materials: { create } } as unknown as RepositoryOperations;
    expect(() => createProjectMaterial(repo, input)).toThrow('프로젝트 모형 저장 기능');
    expect(create).not.toHaveBeenCalled();
  });
});
