import { candidateBathRimErrors, candidatePartitionTopErrors } from './candidate-bath-rim';
import type { RoomDefinition } from '../room-types';
import type { ManualCandidatePlacement } from './candidate-pipeline';
import type { LabManualDraft } from './lab-correction';
import { placementFromWallReference } from './wall-relative-placement';

export function resolveManualDraft(
  draft: LabManualDraft,
  room: RoomDefinition,
  defaultDepthMm: number,
): ManualCandidatePlacement {
  const support = draft.support;
  if (support?.bathRim) {
    if (support.kind !== 'bath-rim' || draft.face !== 'floor' || support.bathRim.offsetMm.trim() === '')
      throw new Error('욕조 테두리 연결과 중앙 기준 거리를 확인해 주세요.');
    const bathRim = {
      ...support.bathRim,
      offsetMm: Number(support.bathRim.offsetMm),
      provenance: support.bathRim.provenance ?? {
        parent: 'user' as const,
        side: 'user' as const,
        offset: 'user' as const,
      },
      ...(support.evidence ? { evidence: [...support.evidence] } : {}),
    };
    const errors = candidateBathRimErrors(bathRim);
    if (errors.length) throw new Error(errors.join(' '));
    // Temporary coordinates are not a placement or observation. The accepted parent plan resolves them.
    return {
      face: 'floor',
      u: 0.5,
      v: 0.5,
      baseHeightMm: 0,
      bathRim,
      ...(draft.widthMm !== '' ? { widthMm: Number(draft.widthMm) } : {}),
      ...(draft.heightMm !== '' ? { heightMm: Number(draft.heightMm) } : {}),
      ...(draft.depthMm !== '' ? { depthMm: Number(draft.depthMm) } : {}),
    };
  }

  if (support?.partitionTop) {
    if (
      support.kind !== 'partition-top' ||
      support.bathRim ||
      draft.face !== 'floor' ||
      support.partitionTop.offsetMm.trim() === ''
    )
      throw new Error('낮은 칸막이 연결과 중앙 기준 거리를 확인해 주세요.');
    const partitionTop = {
      ...support.partitionTop,
      offsetMm: Number(support.partitionTop.offsetMm),
      provenance: support.partitionTop.provenance ?? { parent: 'user' as const, offset: 'user' as const },
      ...(support.evidence ? { evidence: [...support.evidence] } : {}),
    };
    const errors = candidatePartitionTopErrors(partitionTop);
    if (errors.length) throw new Error(errors.join(' '));
    return {
      face: 'floor',
      u: 0.5,
      v: 0.5,
      baseHeightMm: 0,
      partitionTop,
      ...(draft.widthMm !== '' ? { widthMm: Number(draft.widthMm) } : {}),
      ...(draft.heightMm !== '' ? { heightMm: Number(draft.heightMm) } : {}),
      ...(draft.depthMm !== '' ? { depthMm: Number(draft.depthMm) } : {}),
    };
  }
  if (
    support &&
    (draft.face !== 'floor' ||
      !['bath-rim', 'shower-curb'].includes(support.kind) ||
      support.heightMm.trim() === '' ||
      !Number.isFinite(Number(support.heightMm)) ||
      Number(support.heightMm) <= 0 ||
      Number(support.heightMm) >= room.heightMm)
  )
    throw new Error('유리 지지면을 고르고 바닥보다 높고 천장보다 낮은 지지 높이를 입력해 주세요.');
  if (
    support?.curb &&
    (support.kind !== 'shower-curb' ||
      [support.curb.widthMm, support.curb.depthMm].some(
        (n) => n.trim() === '' || !Number.isFinite(Number(n)) || Number(n) <= 0 || Number(n) > 20000,
      ))
  )
    throw new Error('샤워 턱 폭과 깊이는 0보다 큰 규격으로 입력해 주세요.');
  const raised: ManualCandidatePlacement['support'] = support
    ? {
        kind: support.kind as 'bath-rim' | 'shower-curb',
        heightMm: Number(support.heightMm),
        provenance: { kind: 'user', height: support.heightSource ?? 'user' },
        ...(support.curb
          ? {
              curb: {
                widthMm: Number(support.curb.widthMm),
                depthMm: Number(support.curb.depthMm),
                provenance: { width: support.curb.widthSource, depth: support.curb.depthSource },
              },
            }
          : {}),
      }
    : undefined;
  const dimensions = {
    ...(draft.widthMm !== '' ? { widthMm: Number(draft.widthMm) } : {}),
    ...(draft.heightMm !== '' ? { heightMm: Number(draft.heightMm) } : {}),
    ...(draft.depthMm !== '' ? { depthMm: Number(draft.depthMm) } : {}),
  };
  if (draft.face === 'floor' && draft.wallPosition) {
    const reference = draft.wallPosition;
    if (!reference.wall || [reference.alongMm, reference.clearanceMm].some((n) => n.trim() === ''))
      throw new Error('제품의 뒤쪽이 향하는 벽과 두 거리(mm)를 입력해 주세요.');
    const wallReference = {
      wall: reference.wall,
      alongMm: Number(reference.alongMm),
      clearanceMm: Number(reference.clearanceMm),
    };
    return {
      ...placementFromWallReference(room, wallReference, dimensions.depthMm ?? defaultDepthMm),
      ...dimensions,
      ...(raised ? { support: raised, baseHeightMm: raised.heightMm } : {}),
      wallReference,
    };
  }
  return {
    face: draft.face,
    u: Number(draft.u),
    v: Number(draft.v),
    baseHeightMm: raised?.heightMm ?? Number(draft.baseHeightMm),
    ...(raised ? { support: raised } : {}),
    yawDegrees: Number(draft.yawDegrees),
    ...dimensions,
  };
}
