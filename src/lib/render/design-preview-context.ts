import type { ProjectDocument, Scene } from '../types';
import { normalizeRoomView, type RoomViewState } from '../room-viewer/view-state';
import { ROOM_VIEWER_RENDERER_REVISION } from '../room-viewer/render-version';

export type DesignPreviewRoomContext = {
  beforeScene: Scene;
  view: RoomViewState;
  fitScenes: readonly Scene[];
};

/** Current shared Before and every current design use one camera fit. History is excluded. */
export function projectDesignPreviewRoomContext(
  project: ProjectDocument,
): DesignPreviewRoomContext | undefined {
  const beforeScene = project.shared.comparison?.before ?? project.shared.baseline;
  const scenes = [
    beforeScene,
    ...(project.designs.length ? project.designs.map((design) => design.scene) : [project.shared.baseline]),
  ];
  if (!scenes.some((scene) => scene.wallFeatures?.length)) return undefined;
  const seen = new Set<string>();
  const fitScenes = scenes.filter((scene) => {
    const key = JSON.stringify(scene);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { beforeScene, view: normalizeRoomView(project.roomView), fitScenes };
}

export function designPreviewMaterialIds(scene: Scene, context?: DesignPreviewRoomContext): string[] {
  const scenes = context ? [scene, context.beforeScene, ...context.fitScenes] : [scene];
  return [
    ...new Set(
      scenes
        .flatMap((entry) => [
          ...entry.surfaces.map((surface) => surface.materialVersionId),
          ...entry.fixtures.map((fixture) => fixture.materialVersionId),
        ])
        .filter((id): id is string => !!id),
    ),
  ].sort();
}

/** A disposable image identity, never a persisted project revision or mutation. */
export async function designPreviewRoomContextKey(
  context?: DesignPreviewRoomContext,
): Promise<string | undefined> {
  if (!context) return undefined;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([ROOM_VIEWER_RENDERER_REVISION, context.beforeScene, context.view, context.fitScenes]),
    ),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
