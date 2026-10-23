import { projectScenes } from '@/lib/comparison';
import type { MaterialRepository } from '@/lib/repositories/contracts';
import type { MaterialVersion, ProjectDocument } from '@/lib/types';

/** `known` plus every version `project`'s scenes use that it lacks, read in one request. */
export async function withSceneVersions(
  repo: { materials: Pick<MaterialRepository, 'getVersions'> },
  known: Record<string, MaterialVersion>,
  project: ProjectDocument,
): Promise<Record<string, MaterialVersion>> {
  const versions = { ...known };
  const missing = [
    ...new Set(
      projectScenes(project).flatMap((scene) => [
        ...scene.surfaces.map((surface) => surface.materialVersionId),
        ...scene.fixtures.map((fixture) => fixture.materialVersionId),
      ]),
    ),
  ].filter((id): id is string => !!id && !versions[id]);
  if (!missing.length) return versions;
  for (const version of (await repo.materials.getVersions(missing)).versions) versions[version.id] = version;
  if (missing.some((id) => !versions[id])) throw new Error('사용한 자재를 찾을 수 없어요.');
  return versions;
}
