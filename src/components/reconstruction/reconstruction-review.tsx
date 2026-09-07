'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { AssetImage } from '@/components/materials/asset-image';
import { useEditor } from '@/lib/editor-store';
import { getEditingScene } from '@/lib/comparison';
import { createReconstructionFixture, remapReconstructionCandidates } from '@/lib/reconstruction';
import {
  reconstructionLabels,
  type ReconstructionCandidate,
  type ReconstructionKind,
} from '@/lib/reconstruction/types';
import { useAccess } from '@/components/app-provider';
import styles from './reconstruction.module.css';
import ReconstructionRebuild from './reconstruction-rebuild';

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
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!project || !comparison) return null;
  const scene = st.draft || getEditingScene(project, st.editing);
  async function add(kind: ReconstructionKind, candidate?: ReconstructionCandidate) {
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
      const fixture = await createReconstructionFixture({
        kind,
        color: candidate?.color,
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
            p.shared.comparison.before = remapReconstructionCandidates(p.shared.comparison.before, {
              ...p.shared.comparison.review,
              candidates: [found],
            });
          }
        }
      });
      st.select(fixture.id);
      st.setTool('select');
      onShowProperties();
    } catch (error) {
      if (current()) onError(error instanceof Error ? error.message : '기구를 추가하지 못했어요.');
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
              </button>
            ))}
          </>
        )}
        {!!review?.candidates.length && (
          <>
            <h4>사진에서 찾은 기구</h4>
            {review.candidates.map((candidate) => {
              const fixture = scene.fixtures.find((f) => f.id === candidate.fixtureId);
              return (
                <div key={candidate.id} className={styles.candidate}>
                  <strong>
                    {reconstructionLabels[candidate.kind]} ·{' '}
                    {fixture ? '배치 확인' : candidate.status === 'ignored' ? '제외함' : '미배치'}
                  </strong>
                  <p>{candidate.warning || '종류와 위치를 직접 확인해 주세요.'}</p>
                  <div className="row">
                    <button
                      className="btn small"
                      onClick={() => {
                        if (fixture) {
                          st.select(fixture.id);
                          onShowProperties();
                        } else void add(candidate.kind, candidate);
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
