'use client';

import { useState } from 'react';
import type { RoomDefinition } from '@/lib/room-types';
import type { LabManualDraft } from '@/lib/reconstruction/lab-correction';
import { proposeWallAlignment, type WallAlignmentParent } from '@/lib/reconstruction/wall-alignment';
import type { ReconstructionKind } from '@/lib/reconstruction/types';
import type { InstallationWall } from '@/lib/reconstruction/wall-relative-placement';
import {
  suggestWallAlignments,
  type WallAlignmentObservation,
  type WallAlignmentRecommendationEvidence,
} from '@/lib/reconstruction/wall-alignment-suggestions';
import styles from './reconstruction-lab.module.css';

export type LabWallReference = {
  id: string;
  label: string;
  wall?: InstallationWall;
  plan?: WallAlignmentParent;
  reason?: string;
};

const wallLabels = { left: '왼쪽 벽', back: '정면 벽', right: '오른쪽 벽' };

/** Explicit snapshot copy. It never adds a model relationship or follows later parent movement. */
export function LabWallAlignment({
  value,
  kind,
  defaults,
  room,
  references,
  observation,
  prefix,
  disabled,
  onChange,
}: {
  value: LabManualDraft;
  kind: ReconstructionKind;
  defaults: { widthMm: number; heightMm: number; depthMm: number };
  room: RoomDefinition;
  references: LabWallReference[];
  observation?: WallAlignmentObservation;
  prefix: string;
  disabled: boolean;
  onChange: (value: LabManualDraft) => void;
}) {
  const [referenceId, setReferenceId] = useState('');
  const [selectedRecommendation, setSelectedRecommendation] = useState<WallAlignmentRecommendationEvidence>();
  const [wallOverride, setWallOverride] = useState<InstallationWall | ''>('');
  const [gap, setGap] = useState('150');
  const [gapSource, setGapSource] = useState<'default' | 'user'>('default');
  if (!['mirror', 'mirrorCabinet', 'wallShelf'].includes(kind)) return null;
  const reference = references.find((item) => item.id === referenceId);
  const wall = wallOverride || reference?.wall;
  const dimensions = {
    widthMm: value.widthMm.trim() ? Number(value.widthMm) : defaults.widthMm,
    heightMm: value.heightMm.trim() ? Number(value.heightMm) : defaults.heightMm,
    depthMm: value.depthMm.trim() ? Number(value.depthMm) : defaults.depthMm,
  };
  const result =
    reference?.plan && wall && gap.trim()
      ? proposeWallAlignment({
          room,
          parent: reference.plan,
          wall,
          target: { kind: kind as 'mirror' | 'mirrorCabinet' | 'wallShelf', ...dimensions },
          gapMm: Number(gap),
        })
      : undefined;
  const suggestions = suggestWallAlignments({
    observation,
    references,
    room,
    target: { kind: kind as 'mirror' | 'mirrorCabinet' | 'wallShelf', ...dimensions },
    gapMm: gap.trim() ? Number(gap) : NaN,
  });
  const copy = (
    chosen: LabWallReference,
    chosenResult: ReturnType<typeof proposeWallAlignment> | undefined,
    chosenWall: InstallationWall | undefined,
    recommendation?: WallAlignmentRecommendationEvidence,
  ) => {
    if (disabled || chosenResult?.status !== 'ready' || !chosen.plan || !chosenWall) return;
    const { face, u, v, baseHeightMm } = chosenResult.placement;
    onChange({
      ...value,
      enabled: true,
      face,
      u: String(u),
      v: String(v),
      baseHeightMm: String(baseHeightMm),
      yawDegrees: '0',
      support: undefined,
      wallPosition: undefined,
      positionReference: {
        version: 1,
        mode: 'copy-above',
        candidateId: chosen.id,
        label: chosen.label,
        parent: structuredClone(chosen.plan),
        wall: chosenWall,
        gapMm: Number(gap),
        gapSource,
        room: { widthMm: room.widthMm, depthMm: room.depthMm, heightMm: room.heightMm },
        result: { face, u, v, baseHeightMm },
        ...(recommendation
          ? { recommendation: { ...structuredClone(recommendation), confirmation: 'user' as const } }
          : {}),
      },
    });
  };
  const priorCopy = value.positionReference;
  const samePosition =
    priorCopy &&
    value.face === priorCopy.result.face &&
    Number(value.u) === priorCopy.result.u &&
    Number(value.v) === priorCopy.result.v &&
    Number(value.baseHeightMm) === priorCopy.result.baseHeightMm;

  return (
    <details data-testid="wall-alignment">
      <summary>세면대·하부장 위에 맞추기</summary>
      <p>
        선택한 설비의 현재 중심과 상단을 참고해 벽·가로 위치·하단 높이를 함께 가져와요. 복사 후에는 각각
        이동해요.
      </p>
      {suggestions.length > 0 && (
        <section aria-label={prefix + ' 위치 참고 추천'} data-testid="wall-alignment-suggestions">
          <p>
            사진에서 위·아래에 있는 참고 후보예요. 실제 연결은 아직 확인하지 않았어요. 원하는 위치를 확인해
            선택하세요.
          </p>
          {suggestions.map((suggestion) => (
            <div key={suggestion.reference.id}>
              <strong>{suggestion.reference.label}</strong>
              <p>{suggestion.evidence.reason}</p>
              <p>
                {suggestion.reference.wall ? wallLabels[suggestion.reference.wall] : '설치 벽 확인 필요'}
                {' · '}간격 {gap}mm ({gapSource === 'default' ? '기본값' : '사용자 입력'})
                {suggestion.result?.status === 'ready' &&
                  ` · 하단 ${Math.round(suggestion.result.placement.baseHeightMm)}mm · 가로 ${Math.round(suggestion.result.placement.u * 100)}%`}
              </p>
              {suggestion.result?.status === 'held' && (
                <p role="status">{suggestion.result.reasons.join(' ')}</p>
              )}
              <button
                type="button"
                className={styles.button}
                aria-label={prefix + ' 추천 ' + suggestion.reference.id + ' 위치 확인'}
                disabled={disabled || suggestion.result?.status === 'held'}
                onClick={() => {
                  setReferenceId(suggestion.reference.id);
                  setWallOverride('');
                  setSelectedRecommendation(suggestion.evidence);
                  copy(
                    suggestion.reference,
                    suggestion.result,
                    suggestion.reference.wall,
                    suggestion.evidence,
                  );
                }}
              >
                {suggestion.result?.status === 'ready'
                  ? '이 위치로 맞추기 · 사용자 확인'
                  : '이 설비 선택 후 벽 확인'}
              </button>
            </div>
          ))}
          <small>
            벽·높이는 참고 설비의 현재 배치와 간격에서 가져와요. 사진 왼쪽이라는 이유로 왼쪽 벽에 놓지 않으며,
            이후 각각 이동해요.
          </small>
        </section>
      )}
      <div className={styles.manualFields}>
        <label>
          위치를 참고할 설비
          <select
            aria-label={prefix + ' 위치 참고 설비'}
            disabled={disabled}
            value={referenceId}
            onChange={(event) => {
              setReferenceId(event.target.value);
              setWallOverride('');
              setSelectedRecommendation(undefined);
            }}
          >
            <option value="">세면대 또는 하부장 선택</option>
            {referenceId && !reference && <option value={referenceId}>기존 설비 없음 · 다시 선택</option>}
            {references.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
                {item.plan ? '' : ' · 설치 확인 필요'}
              </option>
            ))}
          </select>
        </label>
        {reference && (
          <label>
            맞출 벽
            <select
              aria-label={prefix + ' 맞출 벽'}
              disabled={disabled || !reference.plan || reference.plan.face !== 'floor'}
              value={wall ?? ''}
              onChange={(event) => setWallOverride(event.target.value as InstallationWall | '')}
            >
              <option value="">설치 벽 확인 필요</option>
              {Object.entries(wallLabels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          설비 상단과의 간격 mm · {gapSource === 'default' ? '기본값' : '사용자 입력'}
          <input
            type="number"
            min="0"
            step="10"
            aria-label={prefix + ' 위 간격 mm'}
            value={gap}
            disabled={disabled}
            onChange={(event) => {
              setGap(event.target.value);
              setGapSource('user');
            }}
          />
        </label>
      </div>
      {references.length === 0 && <p>먼저 세면대나 하부장의 설치 위치를 지정해 주세요.</p>}
      {reference && !reference.plan && (
        <p role="status">{reference.reason ?? '참고할 설비의 종류·설치 방식·위치를 먼저 확인해 주세요.'}</p>
      )}
      {reference?.plan && !wall && (
        <p>제품 뒤쪽의 설치 벽을 확인해 주세요. 기본 회전만으로 벽을 정하지 않아요.</p>
      )}
      {result?.status === 'held' && <p role="status">{result.reasons.join(' ')}</p>}
      {result?.status === 'ready' && (
        <p data-testid="wall-alignment-preview">
          {wallLabels[result.placement.face]} · 가로 {Math.round(result.placement.u * 100)}% · 하단{' '}
          {Math.round(result.placement.baseHeightMm)}mm. 현재 모형 상단과 선택한 간격으로 계산하며 사진
          실측값은 아니에요. 비운 규격은 모형 기본값을 유지해요.
        </p>
      )}
      <button
        type="button"
        className={styles.button}
        aria-label={prefix + ' 위에 위치 맞추기'}
        disabled={disabled || result?.status !== 'ready'}
        onClick={() => {
          if (reference)
            copy(
              reference,
              result,
              wall,
              selectedRecommendation
                ? suggestions.find((item) => item.reference.id === reference.id)?.evidence
                : undefined,
            );
        }}
      >
        위에 위치 맞추기
      </button>
      {priorCopy && (
        <p data-testid="wall-alignment-history">
          {priorCopy.label} 위 위치를 가져왔어요 · 간격 {priorCopy.gapMm}mm (
          {priorCopy.gapSource === 'default' ? '기본값' : '사용자 입력'}).{' '}
          {samePosition ? '복사한 위치를 사용 중이에요.' : '복사 이후 위치를 직접 수정했어요.'} 참고 설비를
          옮기거나 삭제해도 이 위치는 유지돼요.
          {priorCopy.recommendation &&
            ' 사진 위치에서 제안한 참고 후보를 사용자가 확인했어요. AI가 실제 설치 연결을 확정한 결과는 아니에요.'}
        </p>
      )}
    </details>
  );
}
