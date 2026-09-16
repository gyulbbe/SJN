'use client';

import {
  confirmedPlacementProvenance,
  inspectStrictPlacement,
  StrictPlacementError,
  type PlacementReview,
} from '@/lib/reconstruction/strict-placement';
import { reconstructionReviewSchema } from '@/lib/supabase/validation';
import { resolveProductColor } from '@/lib/reconstruction/product-color';
import { resolveBathRimFixture } from '@/lib/reconstruction/bath-rim';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { AssetImage } from '@/components/materials/asset-image';
import { useEditor } from '@/lib/editor-store';
import { getEditingScene } from '@/lib/comparison';
import {
  createReconstructionFixture,
  mapReconstructionCandidate,
  inferToiletLidState,
  estimateCandidateFixture,
} from '@/lib/reconstruction';
import {
  reconstructionLabels,
  reconstructionCandidateLabel,
  reconstructionDefaults,
  type ReconstructionStandardOptions,
  type ReconstructionCandidate,
  type ReconstructionKind,
} from '@/lib/reconstruction/types';
import { useAccess } from '@/components/app-provider';
import styles from './reconstruction.module.css';
import ReconstructionRebuild from './reconstruction-rebuild';
import { ReviewPlacementPicker } from './review-placement-picker';

export default function ReconstructionReviewPanel({
  open,
  onClose,
  onMaterialsChanged,
  onError,
  onShowProperties,
}: {
  open: boolean;
  onClose: () => void;
  onMaterialsChanged: () => Promise<void>;
  onError: (message: string) => void;
  onShowProperties: () => void;
}) {
  const st = useEditor(),
    { writable } = useAccess();
  const project = st.project,
    comparison = project?.shared.comparison,
    review = comparison?.review;
  const [busy, setBusy] = useState(false);
  const [candidateKinds, setCandidateKinds] = useState<Record<string, ReconstructionKind>>({});
  const [candidateVariants, setCandidateVariants] = useState<Record<string, 'wall' | 'pedestal' | 'vanity'>>(
    {},
  );
  const [placementBases, setPlacementBases] = useState<Record<string, PlacementReview['requested']>>({});
  const [placementEdits, setPlacementEdits] = useState<Record<string, Partial<PlacementReview['requested']>>>(
    {},
  );
  const [confirmedPresets, setConfirmedPresets] = useState<Record<string, boolean>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!project || !comparison) return null;
  const scene = st.draft || getEditingScene(project, st.editing);
  function resetPlacement(
    candidate: ReconstructionCandidate,
    kind: ReconstructionKind,
    basinVariant?: ReconstructionStandardOptions['basinVariant'],
  ) {
    if (!comparison) return;
    const defaults = reconstructionDefaults(kind, basinVariant);
    const baseHeightMm = defaults.baseHeightMm ?? 0;
    setPlacementBases((all) => ({
      ...all,
      [candidate.id]: {
        kind,
        face: defaults.face,
        u: 0.5,
        v: defaults.face === 'floor' ? 0.5 : 1 - baseHeightMm / comparison.room.heightMm,
        widthMm: defaults.widthMm,
        heightMm: defaults.heightMm,
        depthMm: defaults.depthMm,
        baseHeightMm,
        yawDegrees: defaults.yawDegrees ?? 0,
        orientation: defaults.face === 'floor' ? 'back' : defaults.face,
        support: undefined,
        provenance: {
          position: 'default',
          dimensions: 'default',
          width: 'default',
          height: 'default',
          depth: 'default',
          shape: 'default',
        },
      },
    }));
    setPlacementEdits((all) => ({ ...all, [candidate.id]: {} }));
    setConfirmedPresets((all) => ({ ...all, [candidate.id]: false }));
  }
  function initialPlacement(
    candidate: ReconstructionCandidate,
    kind: ReconstructionKind,
    basinVariant?: ReconstructionStandardOptions['basinVariant'],
  ): PlacementReview['requested'] {
    const existing = placementBases[candidate.id] ?? candidate.placementReview?.requested;
    if (existing) return existing;
    const defaults = reconstructionDefaults(kind, basinVariant);
    const mapped =
      kind === candidate.kind && review ? mapReconstructionCandidate(candidate, review) : undefined;
    if (mapped && review && comparison)
      return {
        kind,
        face: mapped.face,
        ...estimateCandidateFixture(candidate, review, comparison.room, mapped),
      };
    const baseHeightMm = defaults.baseHeightMm ?? 0;
    return {
      kind,
      face: defaults.face,
      u: 0.5,
      v: defaults.face === 'floor' ? 0.5 : 1 - baseHeightMm / comparison!.room.heightMm,
      widthMm: defaults.widthMm,
      heightMm: defaults.heightMm,
      depthMm: defaults.depthMm,
      baseHeightMm,
      orientation: defaults.face === 'floor' ? 'back' : defaults.face,
      provenance: {
        position: 'default',
        wall: 'default',
        width: 'default',
        height: 'default',
        depth: 'default',
        dimensions: 'default',
        shape: 'default',
      },
    };
  }
  async function add(
    kind: ReconstructionKind,
    candidate?: ReconstructionCandidate,
    basinVariant?: ReconstructionStandardOptions['basinVariant'],
  ) {
    const captured = useEditor.getState().project;
    if (!captured?.shared.comparison || !writable || busy) return;
    setBusy(true);
    const current = () =>
      alive.current &&
      useEditor.getState().editing === 'before' &&
      useEditor.getState().project?.id === captured.id &&
      useEditor.getState().project?.activeDesignId === captured.activeDesignId &&
      useEditor.getState().project?.editRevision === captured.editRevision;
    try {
      const defaults = reconstructionDefaults(kind, basinVariant ?? candidate?.installation?.basinVariant);
      const mapped =
        candidate &&
        kind === candidate.kind &&
        (!basinVariant || basinVariant === candidate.installation?.basinVariant) &&
        captured.shared.comparison.review
          ? mapReconstructionCandidate(candidate, captured.shared.comparison.review)
          : undefined;
      const originalProposal = candidate
        ? initialPlacement(candidate, kind, basinVariant ?? candidate.installation?.basinVariant)
        : undefined;
      const originalMatches =
        candidate &&
        kind === candidate.kind &&
        (!basinVariant || basinVariant === candidate.installation?.basinVariant);
      const proposal =
        candidate && originalProposal
          ? { ...originalProposal, ...placementEdits[candidate.id] }
          : originalMatches && mapped && captured.shared.comparison.review
            ? estimateCandidateFixture(
                candidate,
                captured.shared.comparison.review,
                captured.shared.comparison.room,
                mapped,
              )
            : undefined;
      const placementProvenance =
        candidate && originalProposal
          ? confirmedPlacementProvenance(originalProposal, placementEdits[candidate.id])
          : proposal?.provenance;
      const colorEvidence = resolveProductColor(
        kind,
        candidate && kind === candidate.kind ? candidate : undefined,
      );
      const lidObservation =
        candidate && kind === candidate.kind ? inferToiletLidState(candidate) : undefined;
      const fixture = await createReconstructionFixture({
        ...defaults,
        ...mapped,
        kind,
        basinVariant: basinVariant ?? candidate?.installation?.basinVariant ?? defaults.basinVariant,
        basinShape:
          candidate && kind === candidate.kind
            ? (candidate.evidence.basinShape?.value ?? defaults.basinShape)
            : defaults.basinShape,
        bowlCount:
          candidate && kind === candidate.kind
            ? (candidate.evidence.bowlCount?.value ?? defaults.bowlCount)
            : defaults.bowlCount,
        face:
          defaults.face === 'floor'
            ? 'floor'
            : (candidate?.installation?.wall ?? mapped?.face ?? defaults.face),
        ...proposal,
        color: colorEvidence.color,
        colorEvidence,
        placementPolicy: candidate ? 'preserve' : undefined,
        toiletLidState: lidObservation?.value ?? defaults.toiletLidState,
        provenance: {
          ...placementProvenance,
          ...(candidate && confirmedPresets[candidate.id]
            ? { position: 'user' as const, wall: 'user' as const }
            : {}),
          kind: 'user',
          mounting: 'user',
          position:
            candidate && confirmedPresets[candidate.id]
              ? 'user'
              : (placementProvenance?.position ?? (mapped ? 'inferred' : 'default')),
          dimensions: placementProvenance?.dimensions ?? 'default',
          shape:
            candidate && kind === candidate.kind && candidate.evidence.basinShape
              ? 'inferred'
              : (placementProvenance?.shape ?? 'default'),
          appearance: colorEvidence.source,
          color: colorEvidence.source,
          ...(kind === 'toilet' ? { toiletLidState: lidObservation?.source ?? 'default' } : {}),
        },
        room: captured.shared.comparison.room,
        aspect: captured.shared.comparison.aspect,
      });
      if (!current()) return;
      await onMaterialsChanged();
      if (!current()) return;
      st.changeProject((p) => {
        if (!p.shared.comparison) return;
        p.shared.comparison.before.fixtures.push(fixture);
        if (candidate && p.shared.comparison.review) {
          const found = p.shared.comparison.review.candidates.find((c) => c.id === candidate.id);
          if (found) {
            found.fixtureId = fixture.id;
            found.status = 'placed';
            found.kind = kind;
            found.proposedKind = kind;
            found.source = 'user';
            found.color = fixture.reconstruction!.color;
            found.colorEvidence = fixture.reconstruction!.colorEvidence;
            found.installation = {
              mode:
                kind === 'showerCurtain'
                  ? 'suspended'
                  : fixture.roomPlacement!.face === 'floor'
                    ? 'floor'
                    : 'wall',
              wall: fixture.roomPlacement!.face === 'floor' ? undefined : fixture.roomPlacement!.face,
              basinVariant: fixture.reconstruction!.basinVariant,
              source: 'user',
              reason: '사용자가 종류·설치 방식·위치를 확인했어요.',
            };
            found.requiresReview = false;
            found.placementReview = inspectStrictPlacement(captured.shared.comparison!.room, {
              ...fixture.reconstruction!,
              ...fixture.roomPlacement!,
              kind,
              depthMm: fixture.reconstruction!.depthMm,
            });
            found.warning = mapped
              ? '사용자가 종류를 확인하고 추정 위치에 추가했어요. 설치 높이와 규격을 확인해 주세요.'
              : '사용자가 선택한 모형을 기본 위치에 추가했어요. 설치 벽·높이·규격을 수정해 주세요.';
            found.trace = [
              ...(found.trace ?? []),
              { stage: 'placement', outcome: 'accepted', reason: found.warning },
            ];
          }
        }
      });
      st.select(fixture.id);
      st.setTool('select');
      onShowProperties();
    } catch (error) {
      if (current()) {
        if (
          candidate &&
          error instanceof StrictPlacementError &&
          captured.shared.comparison.review &&
          reconstructionReviewSchema.safeParse({
            ...captured.shared.comparison.review,
            candidates: captured.shared.comparison.review.candidates.map((item) =>
              item.id === candidate.id ? { ...item, placementReview: error.review } : item,
            ),
          }).success
        ) {
          st.changeProject((p) => {
            const found = p.shared.comparison?.review?.candidates.find((c) => c.id === candidate.id);
            if (!found) return;
            found.placementReview = error.review;
            found.requiresReview = true;
            found.status = 'unplaced';
            found.warning = `입력한 위치와 규격을 보존하고 배치를 보류했어요. ${error.message}`;
          });
        }
        onError(error instanceof Error ? error.message : '기구를 추가하지 못했어요.');
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <aside className={styles.review + ' ' + (!open ? styles.reviewHidden : '')} aria-label="Before 초안 보정">
      <div className="row between">
        <h3>기존 공간 확인</h3>
        <button className="icon-btn mobile-close" onClick={onClose} aria-label="초안 보정 닫기">
          <X size={17} />
        </button>
      </div>
      <AssetImage
        assetId={comparison.referencePreviewAssetId}
        alt="기존 공간 참고 사진"
        className={styles.reference}
      />
      <p className="muted" style={{ fontSize: 11, lineHeight: 1.6, marginTop: 9 }}>
        사진과 같은 제품이 아닌 유사 모형이에요. 오른쪽 공간에서 기구를 선택하면 위치·규격·색을 고칠 수
        있어요.
      </p>
      <ReconstructionRebuild onMaterialsChanged={onMaterialsChanged} />
      {review?.warnings.slice(0, 5).map((warning, i) => (
        <p key={i} className={styles.warning}>
          {warning.split('. ')[0]}
        </p>
      ))}
      <fieldset
        disabled={!writable || busy || !!st.draft}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <h4>기존 타일 수정</h4>
        <div className={styles.miniGrid}>
          {scene.surfaces.map((surface) => (
            <button
              key={surface.id}
              className="btn small"
              onClick={() => {
                st.select(surface.id);
                onShowProperties();
              }}
            >
              {surface.name}
            </button>
          ))}
        </div>
        <h4>빠진 기구 추가</h4>
        <div className={styles.miniGrid}>
          {Object.entries(reconstructionLabels).map(([kind, label]) => (
            <button key={kind} className="btn small" onClick={() => void add(kind as ReconstructionKind)}>
              {label} 추가
            </button>
          ))}
        </div>
        {busy && (
          <p role="status" style={{ fontSize: 12, marginTop: 8 }}>
            재구성 모형을 준비하고 있어요…
          </p>
        )}
        {scene.fixtures.length > 0 && (
          <>
            <h4>배치한 기구</h4>
            {scene.fixtures.map((fixture) => (
              <button
                key={fixture.id}
                className="btn small"
                style={{ width: '100%', marginTop: 5 }}
                onClick={() => {
                  st.select(fixture.id);
                  onShowProperties();
                }}
              >
                {fixture.name}
                {(() => {
                  const result = resolveBathRimFixture(scene, fixture);
                  return result.status === 'held' ? (
                    <small style={{ display: 'block' }}>배치 보류: {result.reason}</small>
                  ) : null;
                })()}
              </button>
            ))}
          </>
        )}
        {!!review?.candidates.length && (
          <>
            <h4>사진에서 찾은 기구</h4>
            {review.candidates.map((candidate) => {
              const fixture = scene.fixtures.find((f) => f.id === candidate.fixtureId);
              const choice =
                candidateKinds[candidate.id] ??
                (candidate.detectedLabel === 'cabinet' && !candidate.proposedKind
                  ? ''
                  : (candidate.proposedKind ?? candidate.kind));
              const variant =
                candidateVariants[candidate.id] ?? candidate.installation?.basinVariant ?? 'wall';
              const requestedPlacement = choice
                ? {
                    ...initialPlacement(candidate, choice, choice === 'basin' ? variant : undefined),
                    ...placementEdits[candidate.id],
                  }
                : undefined;
              return (
                <div key={candidate.id} data-candidate-id={candidate.id} className={styles.candidate}>
                  <strong>
                    {reconstructionCandidateLabel(candidate)} ·{' '}
                    {fixture ? '배치 확인' : candidate.status === 'ignored' ? '제외함' : '미배치'}
                  </strong>
                  <p>{candidate.warning || '종류와 위치를 직접 확인해 주세요.'}</p>
                  <div className={styles.provenance}>
                    <span>
                      {candidate.source === 'user'
                        ? '사용자 확인'
                        : candidate.proposedKind
                          ? '형태 관계로 추정'
                          : candidate.source === 'gemma'
                            ? 'Gemma 관측'
                            : candidate.source === 'qwen'
                            ? 'Qwen 관측'
                            : 'DeepLab 관측'}
                    </span>
                    {candidate.installation && (
                      <span>
                        {candidate.installation.mode === 'unknown'
                          ? '설치 확인 필요'
                          : candidate.installation.mode === 'wall'
                            ? candidate.installation.source === 'user'
                              ? '벽 설치 · 사용자 설정'
                              : '벽 설치 추정'
                            : candidate.installation.source === 'user'
                              ? '바닥 설치 · 사용자 설정'
                              : '바닥 설치 추정'}
                      </span>
                    )}
                  </div>
                  {candidate.installation?.reason && <p>{candidate.installation.reason}</p>}
                  {!fixture && requestedPlacement && (
                    <details open>
                      <summary>
                        {candidate.placementReview ? '원래 위치·규격 확인' : '설치 위치·규격 확인'}
                      </summary>
                      {!candidate.placementReview && (
                        <p>
                          설치 위치 근거가 부족해 기본값으로 시작해요. 사진에서 알아낸 위치가 아니에요. 설치
                          면과 위치를 확인한 뒤 추가해 주세요.
                        </p>
                      )}
                      <p>
                        그림에서 위치를 정하고 방향을 선택해 주세요. 방 범위를 넘는 제품을 자동으로 이동하거나
                        줄이지 않아요. 종류·설치 방식을 바꾸면 해당 모형의 기본값으로 다시 시작해요.
                      </p>
                      {requestedPlacement && (
                        <ReviewPlacementPicker
                          room={comparison.room}
                          request={requestedPlacement}
                          prefix={reconstructionCandidateLabel(candidate)}
                          disabled={!writable || busy || !!st.draft}
                          onChange={(edits) =>
                            setPlacementEdits((all) => ({
                              ...all,
                              [candidate.id]: { ...all[candidate.id], ...edits },
                            }))
                          }
                          onChooseWall={(edits) => {
                            setPlacementEdits((all) => ({
                              ...all,
                              [candidate.id]: { ...all[candidate.id], ...edits },
                            }));
                            setConfirmedPresets((all) => ({ ...all, [candidate.id]: true }));
                          }}
                        />
                      )}
                      <label className={styles.control}>
                        설치 면
                        <select
                          aria-label="보류 후보 설치 면"
                          value={placementEdits[candidate.id]?.face ?? requestedPlacement.face}
                          onChange={(e) =>
                            setPlacementEdits((all) => ({
                              ...all,
                              [candidate.id]: {
                                ...all[candidate.id],
                                face: e.target.value as PlacementReview['requested']['face'],
                                ...(e.target.value !== 'floor'
                                  ? {
                                      baseHeightMm: requestedPlacement.baseHeightMm ?? 0,
                                      v:
                                        1 - (requestedPlacement.baseHeightMm ?? 0) / comparison.room.heightMm,
                                    }
                                  : {}),
                              },
                            }))
                          }
                        >
                          <option value="floor">바닥</option>
                          <option value="left">왼쪽 벽</option>
                          <option value="back">뒤쪽 벽</option>
                          <option value="right">오른쪽 벽</option>
                        </select>
                      </label>
                      {(
                        [
                          ['u', '가로 위치 (%)'],
                          ['v', '세로·깊이 위치 (%)'],
                          ['widthMm', '폭 (mm)'],
                          ['heightMm', '높이 (mm)'],
                          ['depthMm', '깊이 (mm)'],
                          ['baseHeightMm', '설치 높이 (mm)'],
                          ['yawDegrees', '바닥 제품 방향 (°)'],
                        ] as const
                      ).map(([key, label]) => {
                        const request = {
                          ...requestedPlacement,
                          ...placementEdits[candidate.id],
                        };
                        const factor = key === 'u' || key === 'v' ? 100 : 1;
                        const currentValue =
                          request[key] ??
                          (key === 'yawDegrees'
                            ? request.orientation === 'left'
                              ? 90
                              : request.orientation === 'right'
                                ? -90
                                : 0
                            : 0);
                        return (
                          <label key={key} className={styles.control}>
                            {label}
                            <input
                              type="number"
                              step="any"
                              aria-label={'보류 후보 ' + label}
                              value={Number.isFinite(currentValue) ? currentValue * factor : ''}
                              onChange={(e) => {
                                const value = e.target.valueAsNumber / factor;
                                setPlacementEdits((all) => ({
                                  ...all,
                                  [candidate.id]: {
                                    ...all[candidate.id],
                                    [key]: value,
                                    ...(request.face !== 'floor' && key === 'baseHeightMm'
                                      ? { v: 1 - value / comparison.room.heightMm }
                                      : {}),
                                    ...(request.face !== 'floor' && key === 'v'
                                      ? { baseHeightMm: (1 - value) * comparison.room.heightMm }
                                      : {}),
                                  },
                                }));
                              }}
                            />
                          </label>
                        );
                      })}
                    </details>
                  )}
                  {!fixture && (
                    <>
                      <label className={styles.control}>
                        설비 종류
                        <select
                          aria-label="후보 설비 종류"
                          value={choice}
                          onChange={(e) => {
                            const kind = e.target.value as ReconstructionKind;
                            setCandidateKinds((v) => ({ ...v, [candidate.id]: kind }));
                            resetPlacement(candidate, kind, kind === 'basin' ? variant : undefined);
                          }}
                        >
                          {!choice && <option value="">종류를 선택해 주세요</option>}
                          {Object.entries(reconstructionLabels).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {choice === 'basin' && (
                        <label className={styles.control}>
                          설치 방식
                          <select
                            aria-label="후보 세면대 설치 방식"
                            value={variant}
                            onChange={(e) => {
                              const variant = e.target.value as 'wall' | 'pedestal' | 'vanity';
                              setCandidateVariants((v) => ({ ...v, [candidate.id]: variant }));
                              resetPlacement(candidate, 'basin', variant);
                            }}
                          >
                            <option value="wall">벽걸이형</option>
                            <option value="pedestal">기둥형</option>
                            <option value="vanity">하부장형</option>
                          </select>
                        </label>
                      )}
                    </>
                  )}
                  <div className="row">
                    <button
                      className="btn small"
                      disabled={!fixture && !choice}
                      onClick={() => {
                        if (fixture) {
                          st.select(fixture.id);
                          onShowProperties();
                        } else if (choice)
                          void add(choice, candidate, choice === 'basin' ? variant : undefined);
                      }}
                    >
                      {fixture ? '선택해서 수정' : '모형 추가'}
                    </button>
                    {!fixture && (
                      <button
                        className="text-button"
                        onClick={() =>
                          st.changeProject((p) => {
                            const candidateRecord = p.shared.comparison?.review?.candidates.find(
                              (c) => c.id === candidate.id,
                            );
                            if (candidateRecord) {
                              candidateRecord.status = 'ignored';
                              delete candidateRecord.fixtureId;
                            }
                          })
                        }
                      >
                        제외
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </fieldset>
    </aside>
  );
}
