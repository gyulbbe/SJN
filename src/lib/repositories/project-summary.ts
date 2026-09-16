import type { ProjectDocument, ProjectSummary } from '../types';
import { z } from 'zod';
import { ROOM_VIEWER_RENDERER_REVISION } from '../room-viewer/render-version';
import {
  designPreviewRoomContextKey,
  projectDesignPreviewRoomContext,
} from '../render/design-preview-context';

/** Bump the contract prefix if summary/context derivation changes independently of rendering. */
export const PROJECT_SUMMARY_PREVIEW_REVISION = 'project-summary-v1/' + ROOM_VIEWER_RENDERER_REVISION;
const currentSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().max(200),
    updatedAt: z.string(),
    thumbnailAssetId: z.string().uuid().optional(),
    previewAssetId: z.string().uuid(),
    activeDesignId: z.string().uuid().nullable(),
    activeDesignRevision: z.number().int().nonnegative(),
    sharedRevision: z.number().int().nonnegative(),
    designPreviewContextKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    designPreviewRendererRevision: z.literal(PROJECT_SUMMARY_PREVIEW_REVISION),
  })
  .passthrough();

/** Only server-authored summaries with the current contract/renderer can bypass the document read. */
export function readCurrentProjectSummary(serialized: string): ProjectSummary | undefined {
  try {
    const parsed = currentSummarySchema.safeParse(JSON.parse(serialized));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Derived from the current document and renderer, without saving or uploading a preview. */
export async function createProjectSummary(project: ProjectDocument): Promise<ProjectSummary> {
  const active = project.designs.find((design) => design.id === project.activeDesignId);
  const contextKey = await designPreviewRoomContextKey(projectDesignPreviewRoomContext(project));
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    thumbnailAssetId: project.thumbnailAssetId,
    previewAssetId: (active?.scene ?? project.shared.baseline).previewAssetId,
    activeDesignId: project.activeDesignId,
    activeDesignRevision: active?.renderRevision ?? active?.revision ?? 0,
    sharedRevision: project.shared.revision,
    designPreviewRendererRevision: PROJECT_SUMMARY_PREVIEW_REVISION,
    ...(contextKey ? { designPreviewContextKey: contextKey } : {}),
  };
}
