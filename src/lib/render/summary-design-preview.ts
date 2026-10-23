import type { RepositoryOperations } from '../repositories/contracts';
import { projectPhotoLight } from '../reconstruction/photo-lighting';
import { DesignPreviewCancelled, DesignPreviewService, type PreviewDesign } from './design-preview';
import { getCachedDesignThumbnail, type DesignPreviewIdentity } from './design-preview-cache';
import {
  designPreviewMaterialIds,
  designPreviewRoomContextKey,
  projectDesignPreviewRoomContext,
} from './design-preview-context';

// Listing many projects must not allocate one WebGL context per card.
let pending: Promise<unknown> = Promise.resolve();
export function prepareSummaryRoomThumbnail(
  repositories: RepositoryOperations,
  identity: DesignPreviewIdentity,
  signal: AbortSignal,
): Promise<void> {
  const current = () => {
    if (signal.aborted) throw new DesignPreviewCancelled();
  };
  const job = pending
    .catch(() => {})
    .then(async () => {
      current();
      if (!identity.contextKey || (await getCachedDesignThumbnail(identity))) return;
      current();
      const project = await repositories.projects.load(identity.projectId);
      current();
      const roomContext = projectDesignPreviewRoomContext(project);
      if (!roomContext || (await designPreviewRoomContextKey(roomContext)) !== identity.contextKey)
        throw new DesignPreviewCancelled();
      const active = project.designs.find((design) => design.id === project.activeDesignId);
      const design: PreviewDesign = active ?? {
        id: 'baseline',
        name: project.name,
        scene: project.shared.baseline,
        revision: 0,
      };
      if (
        design.id !== identity.designId ||
        (design.renderRevision ?? design.revision) !== identity.revision ||
        project.shared.revision !== identity.sharedRevision
      )
        throw new DesignPreviewCancelled();
      const ids = designPreviewMaterialIds(design.scene, roomContext);
      const { versions } = ids.length ? await repositories.materials.getVersions(ids) : { versions: [] };
      // A version the list cannot read stops the preview, as one failed read did before.
      if (versions.length !== new Set(ids).size) throw new Error('시안에 쓴 자재를 불러오지 못했어요.');
      const entries = versions.map((version) => [version.id, version] as const);
      current();
      const service = new DesignPreviewService((id) => repositories.assets.get(id));
      const cancel = () => service.dispose();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        current();
        await service.request('summary', {
          projectId: project.id,
          sharedRevision: project.shared.revision,
          design,
          materials: Object.fromEntries(entries),
          roomContext,
          lighting: projectPhotoLight(project),
          purpose: 'thumbnail',
        });
      } finally {
        signal.removeEventListener('abort', cancel);
        service.dispose();
      }
    });
  pending = job.catch(() => {});
  return job;
}
