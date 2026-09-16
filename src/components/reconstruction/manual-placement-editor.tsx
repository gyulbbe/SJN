'use client';

import type { WallAlignmentObservation } from '@/lib/reconstruction/wall-alignment-suggestions';
import { LabWallAlignment, type LabWallReference } from './lab-wall-alignment';
import { LabBathRimControls, type LabBathParent } from './lab-bath-rim-controls';
import {
  resolveCandidateBathRim,
  resolveCandidatePartitionTop,
} from '@/lib/reconstruction/candidate-bath-rim';
import { LabPartitionTopControls } from './lab-partition-top-controls';
import type { ReconstructionKind } from '@/lib/reconstruction/types';
import type { RoomDefinition, RoomFace } from '@/lib/room-types';
import type { LabManualDraft as ManualDraft } from '@/lib/reconstruction/lab-correction';
import { PlacementPicker } from './placement-picker';
import { resolveManualDraft } from '@/lib/reconstruction/lab-manual-placement';
import { defaultShowerCurb } from '@/lib/reconstruction/raised-glass-support';
import { validateSourceFixture } from '@/lib/reconstruction/source-camera';
import {
  wallReferenceFromPlacement,
  type InstallationWall,
} from '@/lib/reconstruction/wall-relative-placement';
import styles from './reconstruction-lab.module.css';

export function ManualPlacementEditor({
  value,
  prefix,
  disabled,
  room,
  defaults,
  kind,
  bathParents = [],
  wallReferences = [],
  wallObservation,
  onChange: onDraftChange,
}: {
  value: ManualDraft;
  kind?: ReconstructionKind;
  bathParents?: LabBathParent[];
  wallReferences?: LabWallReference[];
  wallObservation?: WallAlignmentObservation;
  room: RoomDefinition;
  defaults: { widthMm: number; heightMm: number; depthMm: number };
  prefix: string;
  disabled: boolean;
  onChange: (value: ManualDraft) => void;
}) {
  const newCurb = () => {
    const curb = defaultShowerCurb(
      value.widthMm === '' ? defaults.widthMm : Number(value.widthMm),
      value.depthMm === '' ? defaults.depthMm : Number(value.depthMm),
    );
    return {
      widthMm: String(curb.widthMm),
      depthMm: String(curb.depthMm),
      widthSource: 'default' as const,
      depthSource: 'default' as const,
    };
  };
  const roomHeight = room.heightMm;
  const bathMode = !!(value.support?.bathRim || value.support?.partitionTop);
  const wallMode = value.face === 'floor' && !!value.wallPosition;
  const onChange = (next: ManualDraft) => {
    if (next.support?.bathRim || next.support?.partitionTop)
      next = { ...next, face: 'floor', wallPosition: undefined };
    if (next.face === 'floor' && next.wallPosition) {
      try {
        const resolved = resolveManualDraft(next, room, defaults.depthMm);
        next = {
          ...next,
          u: String(resolved.u),
          v: String(resolved.v),
          baseHeightMm: String(resolved.baseHeightMm),
          yawDegrees: String(resolved.yawDegrees),
        };
      } catch {
        /* Incomplete text stays editable and is rejected on submission. */
      }
    } else if (next.face !== 'floor') next = { ...next, wallPosition: undefined, support: undefined };
    onDraftChange(next);
  };
  let bathPositionReady = false;
  let validationMessage: string | undefined;
  let activePlacement: ReturnType<typeof resolveManualDraft> | undefined;
  try {
    const resolved = resolveManualDraft(value, room, defaults.depthMm);
    activePlacement = resolved;
    if (resolved.bathRim) {
      const linked = resolveCandidateBathRim(
        room,
        resolved.bathRim,
        bathParents.find((parent) => parent.id === resolved.bathRim!.parentCandidateId)?.plan,
        { ...defaults, ...resolved, kind: kind ?? 'glassPartition', version: 2 },
      );
      if (linked.status === 'held') validationMessage = '유리 배치 보류: ' + linked.reason;
      else if (linked.status === 'attached') {
        activePlacement = { ...resolved, ...linked.placement, baseHeightMm: linked.placement.baseHeightMm! };
        bathPositionReady = true;
        validationMessage = `욕조 모형에서 계산한 지지 높이 ${linked.placement.baseHeightMm!.toFixed(1)}mm · 실측값 아님. 실제 적용 시 부모 검증을 다시 확인해요.`;
      }
    }
    if (resolved.partitionTop) {
      const linked = resolveCandidatePartitionTop(
        room,
        resolved.partitionTop,
        bathParents.find((parent) => parent.id === resolved.partitionTop!.parentCandidateId)?.plan,
        { ...defaults, ...resolved, kind: kind ?? 'glassPartition', version: 2 },
      );
      if (linked.status === 'held') validationMessage = '유리 배치 보류: ' + linked.reason;
      else if (linked.status === 'attached') {
        activePlacement = { ...resolved, ...linked.placement, baseHeightMm: linked.placement.baseHeightMm! };
        bathPositionReady = true;
        validationMessage =
          '낮은 칸막이 상단에서 계산한 지지 높이 ' +
          linked.placement.baseHeightMm!.toFixed(1) +
          'mm · 실측값 아님.';
      }
    }
    const check: ReturnType<typeof validateSourceFixture> =
      resolved.bathRim || resolved.partitionTop
        ? { valid: true, reasons: [], visibleCornerCount: 0 }
        : validateSourceFixture(room, undefined, { version: 2, kind, ...defaults, ...resolved });
    if (!check.valid) {
      const walls = {
        left: '왼쪽',
        right: '오른쪽',
        back: '정면',
        front: '앞쪽',
        below: '바닥 아래',
        above: '천장 위',
      };
      const overflow = Object.entries(check.overflowMm ?? {})
        .filter(([, mm]) => mm > 1)
        .map(([wall, mm]) => `${walls[wall as keyof typeof walls]} ${Math.round(mm)}mm`)
        .join(', ');
      validationMessage = check.reasons.join(' ') + (overflow ? ` 초과: ${overflow}` : '');
    }
  } catch (error) {
    validationMessage = error instanceof Error ? error.message : '위치를 확인해 주세요.';
  }

  return (
    <div className={styles.manualPlacement}>
      {kind && (
        <LabWallAlignment
          value={value}
          kind={kind}
          defaults={defaults}
          room={room}
          references={wallReferences}
          observation={wallObservation}
          prefix={prefix}
          disabled={disabled}
          onChange={onChange}
        />
      )}
      <label>
        <input
          type="checkbox"
          aria-label={prefix + ' 수동 위치 지정'}
          checked={value.enabled}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />{' '}
        위치·규격을 직접 지정
      </label>
      {value.enabled && (
        <>
          <p>
            그림에서 위치를 정하고 방향을 선택할 수 있어요. 제안 위치가 있으면 그 위치에서 시작하며, 없으면
            임시 중앙값을 사용해요. 사용자가 확인한 위치는 AI 자동 배치와 구분해요.
          </p>
          {kind === 'glassPartition' && value.face === 'floor' && (
            <>
              <div className={styles.manualFields}>
                <label>
                  유리 지지면
                  <select
                    aria-label={prefix + ' 유리 지지면'}
                    value={value.support?.kind ?? 'floor'}
                    disabled={disabled}
                    onChange={(e) => {
                      const supportKind = e.target.value as
                        'floor' | 'bath-rim' | 'shower-curb' | 'partition-top';
                      onChange({
                        ...value,
                        baseHeightMm: supportKind === 'floor' ? '0' : (value.support?.heightMm ?? ''),
                        support:
                          supportKind === 'floor'
                            ? undefined
                            : {
                                kind: supportKind,
                                heightMm: value.support?.heightMm ?? '',
                                heightSource: value.support?.heightSource ?? 'user',
                                ...(supportKind === 'shower-curb'
                                  ? { curb: value.support?.curb ?? newCurb() }
                                  : {}),
                              },
                      });
                    }}
                  >
                    <option value="floor">바닥에 직접 설치</option>
                    <option value="bath-rim">욕조 테두리 위 — 사용자 확인</option>
                    <option value="shower-curb">샤워 턱 위 — 사용자 확인</option>
                    <option value="partition-top">낮은 칸막이 상단 — 부모 선택</option>
                  </select>
                </label>
                {value.support && !bathMode && (
                  <label>
                    바닥에서 지지면까지 높이 mm
                    <input
                      type="number"
                      min="1"
                      max={roomHeight - 1}
                      step="1"
                      aria-label={prefix + ' 지지 높이 mm'}
                      disabled={disabled}
                      value={value.support.heightMm}
                      placeholder="높이 입력 필요"
                      onChange={(e) =>
                        onChange({
                          ...value,
                          baseHeightMm: e.target.value,
                          support: { ...value.support!, heightMm: e.target.value, heightSource: 'user' },
                        })
                      }
                    />
                  </label>
                )}
              </div>
              {value.support?.kind === 'bath-rim' && (
                <LabBathRimControls
                  value={value}
                  prefix={prefix}
                  parents={bathParents.filter((parent) => !parent.kind || parent.kind === 'bath')}
                  disabled={disabled}
                  onChange={onChange}
                />
              )}
              {value.support?.kind === 'partition-top' && (
                <LabPartitionTopControls
                  value={value}
                  prefix={prefix}
                  parents={bathParents.filter((parent) => parent.kind === 'lowPartition')}
                  disabled={disabled}
                  onChange={onChange}
                />
              )}
              {value.support?.kind === 'shower-curb' &&
                (value.support.curb ? (
                  <div className={styles.manualFields}>
                    {(
                      [
                        ['widthMm', '턱 폭 mm', 'widthSource'],
                        ['depthMm', '턱 깊이 mm', 'depthSource'],
                      ] as const
                    ).map(([key, label, source]) => (
                      <label key={key}>
                        {label} · {value.support!.curb![source] === 'default' ? '기본값' : '사용자 입력'}
                        <input
                          type="number"
                          min="1"
                          max="20000"
                          step="1"
                          aria-label={prefix + ' ' + label}
                          disabled={disabled}
                          value={value.support!.curb![key]}
                          onChange={(e) =>
                            onChange({
                              ...value,
                              support: {
                                ...value.support!,
                                curb: { ...value.support!.curb!, [key]: e.target.value, [source]: 'user' },
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.button}
                    disabled={disabled}
                    onClick={() => onChange({ ...value, support: { ...value.support!, curb: newCurb() } })}
                  >
                    확인한 샤워 턱 모형 추가
                  </button>
                ))}
              {value.support && (
                <p>
                  {bathMode
                    ? '기존 욕조 또는 낮은 칸막이 후보에 연결해요. 부모가 미배치·제외되면 유리 후보와 교정 입력은 보존하고 배치를 보류해요.'
                    : value.support.kind === 'shower-curb' && value.support.curb
                      ? '입력한 폭·깊이·높이의 턱을 유리 중앙 아래부터 바닥까지 함께 만들어요. 턱 치수와 회색 마감은 기본값 또는 사용자 입력이며 사진에서 측정한 값이 아니에요.'
                      : '확인한 높이만 적용해요. 욕조나 턱 모형을 만들지 않으며 실제 지지 물체를 옮겨도 함께 이동하지 않아요.'}
                </p>
              )}
            </>
          )}
          {value.face === 'floor' && !bathMode && (
            <>
              <label>
                <input
                  type="checkbox"
                  aria-label={prefix + ' 벽 기준 거리로 배치'}
                  checked={wallMode}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      wallPosition: e.target.checked ? { wall: '', alongMm: '', clearanceMm: '' } : undefined,
                    })
                  }
                />{' '}
                벽 기준 거리로 배치
              </label>
              {wallMode && value.wallPosition && (
                <>
                  <p>
                    제품 뒤쪽이 향하는 벽을 고르면 그 벽을 등지는 방향으로 놓아요. 거리는 현재 위치를 바탕으로
                    제안하며 실측값이 아니에요. 제품 깊이를 바꿔도 벽과의 간격은 유지해요.
                  </p>
                  <div className={styles.manualFields}>
                    <label>
                      제품 뒤쪽 벽
                      <select
                        aria-label={prefix + ' 제품 뒤쪽 벽'}
                        value={value.wallPosition.wall}
                        disabled={disabled}
                        onChange={(e) => {
                          const wall = e.target.value as InstallationWall | '';
                          if (!wall)
                            return onChange({
                              ...value,
                              wallPosition: { wall: '', alongMm: '', clearanceMm: '' },
                            });
                          let estimate;
                          try {
                            estimate = wallReferenceFromPlacement(
                              room,
                              wall,
                              { u: Number(value.u), v: Number(value.v) },
                              value.depthMm === '' ? defaults.depthMm : Number(value.depthMm),
                            );
                          } catch {
                            return onChange({
                              ...value,
                              wallPosition: { wall, alongMm: '', clearanceMm: '' },
                            });
                          }
                          onChange({
                            ...value,
                            wallPosition: {
                              wall,
                              alongMm: String(Math.round(estimate.alongMm)),
                              clearanceMm: String(Math.round(estimate.clearanceMm)),
                            },
                          });
                        }}
                      >
                        <option value="">벽 선택</option>
                        <option value="back">정면 벽</option>
                        <option value="left">왼쪽 벽</option>
                        <option value="right">오른쪽 벽</option>
                      </select>
                    </label>
                    <label>
                      {value.wallPosition.wall === 'back'
                        ? '왼쪽 모서리에서 제품 중심까지'
                        : '정면 모서리에서 제품 중심까지'}{' '}
                      mm
                      <input
                        type="number"
                        min="0"
                        step="1"
                        aria-label={prefix + ' 벽을 따른 중심 거리 mm'}
                        disabled={disabled}
                        value={value.wallPosition.alongMm}
                        onChange={(e) =>
                          onChange({
                            ...value,
                            wallPosition: { ...value.wallPosition!, alongMm: e.target.value },
                          })
                        }
                      />
                    </label>
                    <label>
                      벽과 제품 뒤쪽 간격 mm
                      <input
                        type="number"
                        min="0"
                        step="1"
                        aria-label={prefix + ' 벽과 제품 뒤쪽 간격 mm'}
                        disabled={disabled}
                        value={value.wallPosition.clearanceMm}
                        onChange={(e) =>
                          onChange({
                            ...value,
                            wallPosition: { ...value.wallPosition!, clearanceMm: e.target.value },
                          })
                        }
                      />
                    </label>
                  </div>
                </>
              )}
            </>
          )}
          {validationMessage && <p role="status">{validationMessage}</p>}
          <div className={styles.manualFields}>
            <label>
              설치 면
              <select
                aria-label={prefix + ' 설치 면'}
                value={value.face}
                disabled={disabled || bathMode}
                onChange={(e) => {
                  const face = e.target.value as RoomFace;
                  onChange({
                    ...value,
                    face,
                    ...(face === 'floor'
                      ? { baseHeightMm: value.support?.heightMm ?? '0' }
                      : { v: String(1 - Number(value.baseHeightMm) / roomHeight) }),
                  });
                }}
              >
                {Object.entries({ floor: '바닥', left: '왼쪽 벽', back: '정면 벽', right: '오른쪽 벽' }).map(
                  ([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ),
                )}
              </select>
            </label>
            {(
              [
                ['u', '가로 위치 u'],
                ['v', '깊이/세로 위치 v'],
                ['baseHeightMm', '하단 높이 mm'],
                ['widthMm', '폭 mm'],
                ['heightMm', '높이 mm'],
                ['depthMm', '깊이 mm'],
                ['yawDegrees', '방향 °'],
              ] as const
            )
              .filter(([key]) => !(value.support && key === 'baseHeightMm'))
              .filter(([key]) => !bathMode || !['u', 'v', 'baseHeightMm', 'yawDegrees'].includes(key))
              .filter(([key]) => !wallMode || !['u', 'v', 'baseHeightMm', 'yawDegrees'].includes(key))
              .map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    step={key === 'u' || key === 'v' ? 0.01 : 1}
                    aria-label={prefix + ' ' + label}
                    value={
                      wallMode && activePlacement && ['u', 'v', 'baseHeightMm', 'yawDegrees'].includes(key)
                        ? String(activePlacement[key as 'u' | 'v' | 'baseHeightMm' | 'yawDegrees'])
                        : value[key]
                    }
                    disabled={
                      disabled ||
                      (wallMode && ['u', 'v', 'baseHeightMm', 'yawDegrees'].includes(key)) ||
                      (key === 'yawDegrees' && value.face !== 'floor')
                    }
                    placeholder="기본값 유지"
                    onChange={(e) => {
                      const number = e.target.value;
                      onChange({
                        ...value,
                        [key]: number,
                        ...(value.face !== 'floor' && number.trim() !== '' && Number.isFinite(Number(number))
                          ? key === 'v'
                            ? { baseHeightMm: String(Math.round((1 - Number(number)) * roomHeight)) }
                            : key === 'baseHeightMm'
                              ? { v: String(1 - Number(number) / roomHeight) }
                              : {}
                          : {}),
                      });
                    }}
                  />
                  {key === 'yawDegrees' && value.face !== 'floor' && <small>설치 벽 방향을 따름</small>}
                </label>
              ))}
          </div>
          {(!bathMode || bathPositionReady) && (
            <PlacementPicker
              room={room}
              face={value.face}
              u={activePlacement?.u ?? Number(value.u)}
              v={activePlacement?.v ?? Number(value.v)}
              widthMm={value.widthMm === '' ? defaults.widthMm : Number(value.widthMm)}
              heightMm={value.heightMm === '' ? defaults.heightMm : Number(value.heightMm)}
              depthMm={value.depthMm === '' ? defaults.depthMm : Number(value.depthMm)}
              yawDegrees={activePlacement?.yawDegrees ?? Number(value.yawDegrees)}
              disabled={
                disabled ||
                bathMode ||
                (wallMode &&
                  (!value.wallPosition?.wall ||
                    !Number.isFinite(value.depthMm === '' ? defaults.depthMm : Number(value.depthMm)) ||
                    (value.depthMm === '' ? defaults.depthMm : Number(value.depthMm)) <= 0))
              }
              prefix={prefix}
              readOnlyMessage={
                bathMode
                  ? '선택한 욕조와 테두리·거리에서 위치를 계산해요.'
                  : wallMode
                    ? '그림을 누르거나 끌면 선택한 벽 방향을 유지하며 두 거리가 함께 바뀌어요. 방향키로도 이동할 수 있어요.'
                    : undefined
              }
              onChange={({ u, v }) => {
                const next = {
                  ...value,
                  u: String(u),
                  v: String(v),
                  ...(value.face !== 'floor' ? { baseHeightMm: String((1 - v) * roomHeight) } : {}),
                };
                if (wallMode && value.wallPosition?.wall) {
                  const reference = wallReferenceFromPlacement(
                    room,
                    value.wallPosition.wall,
                    { u, v },
                    value.depthMm === '' ? defaults.depthMm : Number(value.depthMm),
                  );
                  // Keep wall crossings visible. A negative gap remains invalid until the user moves back.
                  next.wallPosition = {
                    wall: reference.wall,
                    alongMm: String(reference.alongMm),
                    clearanceMm: String(reference.clearanceMm),
                  };
                }
                onChange(next);
              }}
            />
          )}
          {value.face === 'floor' && !wallMode && !bathMode && (
            <div className={styles.actions} aria-label={prefix + ' 방향 선택'}>
              {(
                [
                  ['앞쪽으로', 0],
                  ['왼쪽으로', -90],
                  ['오른쪽으로', 90],
                  ['뒤쪽으로', 180],
                ] as const
              ).map(([label, degrees]) => (
                <button
                  key={degrees}
                  type="button"
                  className={styles.button}
                  disabled={disabled}
                  aria-pressed={Number(value.yawDegrees) === degrees}
                  onClick={() => onChange({ ...value, yawDegrees: String(degrees) })}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <small>
            규격을 비우면 모형 기본값({defaults.widthMm} × {defaults.heightMm} × {defaults.depthMm}mm)을
            유지해요. 위의 설치 방식과 설치 면도 함께 맞춰 주세요.
          </small>
        </>
      )}
    </div>
  );
}
