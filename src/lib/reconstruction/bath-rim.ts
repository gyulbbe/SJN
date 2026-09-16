import { Vector3 } from 'three';
import { hasParentGlassSupport, raisedGlassSupportErrors } from './raised-glass-support';
import type { FixtureInstance, Scene } from '../types';
import type { RoomDefinition } from '../room-types';
import {
  projectReconstructionFixture,
  reconstructionModelTransform,
  type VolumePlacement,
} from './projection';
import { standardBathRimGeometry } from './bath-rim-geometry';
import { validateSourceFixture } from './source-camera';

export const bathRimSideLabels = {
  left: '욕조 왼쪽 테두리',
  right: '욕조 오른쪽 테두리',
  front: '욕조 앞쪽 테두리',
  back: '욕조 뒤쪽 테두리',
} as const;
export function canSupportBathGlass(fixture: FixtureInstance) {
  return (
    fixture.reconstruction?.version === 2 &&
    fixture.reconstruction.kind === 'bath' &&
    fixture.roomPlacement?.face === 'floor'
  );
}
export type BathRimResolution =
  | { status: 'independent' }
  | { status: 'held'; reason: string }
  | {
      status: 'attached';
      parentName: string;
      placement: VolumePlacement;
      availableLengthMm: number;
      availableThicknessMm: number;
    };
export function canSupportPartitionGlass(fixture: FixtureInstance) {
  return (
    fixture.reconstruction?.version === 2 &&
    fixture.reconstruction.kind === 'lowPartition' &&
    fixture.roomPlacement?.face === 'floor'
  );
}

/** A partition top is a solid rectangle, not a bath rim or a duplicate curb mesh. */
export function resolvePartitionTopPlacement(
  room: RoomDefinition,
  fixtures: readonly FixtureInstance[],
  child: VolumePlacement,
): BathRimResolution {
  const support = child.support,
    link = support?.partitionTop;
  if (!link) return { status: 'independent' };
  const held = (reason: string): BathRimResolution => ({ status: 'held', reason });
  const errors = raisedGlassSupportErrors({ ...child, baseHeightMm: support.heightMm });
  if (errors.length) return held(errors.join(' '));
  const parent = fixtures.find((f) => f.id === link.parentFixtureId);
  if (!parent || !canSupportPartitionGlass(parent))
    return held('연결한 낮은 칸막이가 없어요. 부모를 다시 선택하거나 연결을 해제해 주세요.');
  const meta = parent.reconstruction!,
    p = parent.roomPlacement!;
  const parentCheck = validateSourceFixture(room, undefined, { ...p, ...meta });
  if (!parentCheck.valid) return held('부모 칸막이: ' + parentCheck.reasons.join(' '));
  const availableLengthMm = meta.widthMm * p.scale,
    availableThicknessMm = meta.depthMm * p.scale;
  if (Math.abs(link.offsetMm) + child.widthMm / 2 > availableLengthMm / 2 + 0.001)
    return held('유리가 낮은 칸막이 상단 길이를 넘어요. 폭 또는 중앙 기준 거리를 확인해 주세요.');
  if (child.depthMm > availableThicknessMm + 0.001) return held('유리 두께가 낮은 칸막이 상단 폭을 넘어요.');
  const transform = reconstructionModelTransform(room, { ...p, ...meta });
  const world = new Vector3(link.offsetMm, meta.heightMm * p.scale, 0)
    .applyAxisAngle(new Vector3(0, 1, 0), transform.angle)
    .add(transform.origin);
  const placement: VolumePlacement = {
    ...child,
    face: 'floor',
    scale: 1,
    u: world.x / room.widthMm + 0.5,
    v: world.z / room.depthMm,
    baseHeightMm: world.y,
    yawDegrees: (((transform.angle * 180) / Math.PI + 540) % 360) - 180,
    support: {
      ...structuredClone(support),
      heightMm: world.y,
      provenance: { ...support.provenance, height: 'parent' },
    },
  };
  const check = validateSourceFixture(room, undefined, placement);
  if (!check.valid) return held(check.reasons.join(' '));
  return { status: 'attached', parentName: parent.name, placement, availableLengthMm, availableThicknessMm };
}

/** Resolve a recorded user/inferred relation. Missing parents remain in the saved child data. */
export function resolveBathRimPlacement(
  room: RoomDefinition,
  fixtures: readonly FixtureInstance[],
  child: VolumePlacement,
): BathRimResolution {
  if (child.support?.partitionTop) return resolvePartitionTopPlacement(room, fixtures, child);
  const support = child.support,
    link = support?.bathRim;
  if (!link) return { status: 'independent' };
  const held = (reason: string): BathRimResolution => ({ status: 'held', reason });
  if (
    child.kind !== 'glassPartition' ||
    child.version !== 2 ||
    child.face !== 'floor' ||
    support.kind !== 'bath-rim'
  )
    return held('욕조 연결은 바닥 좌표의 표준 유리 파티션에서만 사용할 수 있어요.');
  const supportErrors = raisedGlassSupportErrors({ ...child, baseHeightMm: support.heightMm });
  if (supportErrors.length) return held(supportErrors.join(' '));
  if ((child.scale ?? 1) !== 1)
    return held('욕조에 연결한 유리는 배율 대신 모형 규격으로 크기를 바꿔 주세요.');
  const parent = fixtures.find((f) => f.id === link.parentFixtureId);
  if (!parent || !canSupportBathGlass(parent))
    return held('연결한 표준 욕조가 없어요. 욕조를 다시 선택하거나 연결을 해제해 주세요.');
  const meta = parent.reconstruction!,
    p = parent.roomPlacement!;
  if (![meta.widthMm, meta.heightMm, meta.depthMm, p.scale].every((n) => Number.isFinite(n) && n > 0))
    return held('연결한 욕조의 규격을 확인해 주세요.');
  const parentCheck = validateSourceFixture(room, undefined, { ...p, ...meta });
  if (!parentCheck.valid) return held('부모 욕조: ' + parentCheck.reasons.join(' '));
  const geometry = standardBathRimGeometry(meta.widthMm, meta.heightMm, meta.depthMm),
    rim = geometry[link.side];
  if (!rim || !Number.isFinite(link.offsetMm)) return held('욕조 테두리와 중앙 기준 거리를 확인해 주세요.');
  const availableLengthMm = rim.lengthMm * p.scale,
    availableThicknessMm = rim.thicknessMm * p.scale;
  if (Math.abs(link.offsetMm) + child.widthMm / 2 > availableLengthMm / 2 + 0.001)
    return held(
      `유리가 테두리 끝을 넘어요. 사용 가능한 테두리 길이는 ${Math.floor(availableLengthMm)}mm예요. 폭이나 중앙 기준 거리를 줄여 주세요.`,
    );
  if (child.depthMm > availableThicknessMm + 0.001)
    return held(`유리 두께가 테두리의 평평한 폭 ${Math.floor(availableThicknessMm)}mm를 넘어요.`);
  const transform = reconstructionModelTransform(room, { ...p, ...meta });
  const alongX = link.side === 'back' || link.side === 'front';
  const local = new Vector3(
    rim.x * p.scale + (alongX ? link.offsetMm : 0),
    geometry.heightMm * p.scale,
    rim.z * p.scale + (alongX ? 0 : link.offsetMm),
  );
  const world = local.applyAxisAngle(new Vector3(0, 1, 0), transform.angle).add(transform.origin);
  const placement: VolumePlacement = {
    ...child,
    face: 'floor',
    scale: 1,
    u: world.x / room.widthMm + 0.5,
    v: world.z / room.depthMm,
    baseHeightMm: world.y,
    yawDegrees: (((transform.angle * 180) / Math.PI + rim.yawDegrees + 540) % 360) - 180,
    support: {
      ...structuredClone(support),
      heightMm: world.y,
      provenance: { ...support.provenance, height: 'parent' },
    },
  };
  // Do not make an invalid inherited height/rotation look valid by moving/shrinking the child.
  const check = validateSourceFixture(room, undefined, placement);
  if (!check.valid) return held(check.reasons.join(' '));
  return { status: 'attached', parentName: parent.name, placement, availableLengthMm, availableThicknessMm };
}
export function resolveBathRimFixture(
  scene: Pick<Scene, 'room' | 'fixtures'>,
  fixture: FixtureInstance,
): BathRimResolution {
  if (!hasParentGlassSupport(fixture.reconstruction?.support)) return { status: 'independent' };
  if (!scene.room || !fixture.roomPlacement)
    return { status: 'held', reason: '부모 지지 연결을 계산할 공간 정보가 없어요.' };
  return resolveBathRimPlacement(scene.room, scene.fixtures, {
    ...fixture.roomPlacement,
    ...fixture.reconstruction!,
  });
}
/** Parents have already been normalized; this second pass is one atomic scene edit/history frame. */
export function syncBathRimAttachments(scene: Scene) {
  for (const fixture of scene.fixtures) {
    const result = resolveBathRimFixture(scene, fixture);
    if (result.status !== 'attached' || !fixture.reconstruction || !fixture.roomPlacement || !scene.room)
      continue;
    const p = result.placement;
    Object.assign(fixture.roomPlacement, {
      face: p.face,
      u: p.u,
      v: p.v,
      scale: 1,
      widthMm: p.widthMm,
      heightMm: p.heightMm,
    });
    Object.assign(fixture.reconstruction, {
      baseHeightMm: p.baseHeightMm,
      yawDegrees: p.yawDegrees,
      support: p.support,
    });
    projectReconstructionFixture(scene.room, fixture, scene.imageWidth / scene.imageHeight);
  }
}
/** Read/preview/export resolution never mutates a saved document or erases a held reference. */
export function resolvedBathRimScene<T extends Scene>(scene: T): T {
  if (!scene.fixtures.some((f) => hasParentGlassSupport(f.reconstruction?.support))) return scene;
  const copy = structuredClone(scene);
  syncBathRimAttachments(copy);
  return copy;
}
