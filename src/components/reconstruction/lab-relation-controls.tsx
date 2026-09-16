'use client';

import type { SceneUnderstanding } from '@/lib/reconstruction/pipeline-contract';
import {
  collectLabRelations,
  labRelationKey,
  previewLabRelationEdits,
  type LabRelationEdits,
} from '@/lib/reconstruction/lab-relations';
import { reconstructionLabels } from '@/lib/reconstruction/types';
import styles from './reconstruction-lab.module.css';

export function LabRelationControls({
  observed,
  effective,
  edits,
  disabled,
  onChange,
}: {
  observed: SceneUnderstanding;
  effective: SceneUnderstanding;
  edits: LabRelationEdits;
  disabled: boolean;
  onChange: (edits: LabRelationEdits) => void;
}) {
  const relations = collectLabRelations(observed);
  const preview = previewLabRelationEdits(effective, edits);
  const parents = effective.candidates.filter((candidate) => candidate.kind === 'vanity');
  const label = (id: string) => {
    const item =
      effective.candidates.find((candidate) => candidate.id === id) ??
      observed.candidates.find((candidate) => candidate.id === id);
    return (item && item.kind !== 'unknown' ? reconstructionLabels[item.kind] : '미확인 설비') + ' · ' + id;
  };
  return (
    <details className={styles.relations} data-testid="lab-relation-controls">
      <summary>부품·가림·반사 관계 확인 · 원래 관계 {relations.length}개</summary>
      <p>연결 변경은 사용자 확인으로 기록해요. 원래 AI 판단은 보존하며 교정 결과를 만들 때만 반영해요.</p>
      {relations.length ? (
        relations.map((relation) => {
          const key = labRelationKey(relation);
          const removed =
            edits.disconnectedRelations?.includes(key) ||
            (relation.relation === 'partOf' &&
              Object.prototype.hasOwnProperty.call(edits.supportParents ?? {}, relation.frontId));
          const toggleable = relation.relation === 'partOf' || relation.relation === 'reflectionOf';
          return (
            <div key={key} data-testid="lab-observed-relation">
              <p>
                {label(relation.frontId)} → {label(relation.behindId)} · {relation.relation} ·{' '}
                {relation.evidence.join(' / ')}
              </p>
              {toggleable && (
                <button
                  className={styles.button}
                  disabled={disabled}
                  aria-label={key + ' 관계 해제 전환'}
                  onClick={() =>
                    onChange({
                      ...edits,
                      disconnectedRelations: edits.disconnectedRelations?.includes(key)
                        ? edits.disconnectedRelations.filter((value) => value !== key)
                        : [...(edits.disconnectedRelations ?? []), key],
                    })
                  }
                >
                  {edits.disconnectedRelations?.includes(key)
                    ? '연결 해제 취소'
                    : relation.relation === 'reflectionOf'
                      ? '반사 관계 해제'
                      : '부품 연결 해제'}
                </button>
              )}
              {removed && <small>사용자 확인으로 이 원래 연결을 해제해요.</small>}
              {relation.relation === 'reflectionOf' && (
                <p>
                  실제 물체로 복원하려면 이 반사 관계를 해제하고 해당 설비의 실체 여부도 실제 물체로 확인해
                  주세요. 연결만 해제하면 원래 반사 판단은 유지돼요.
                </p>
              )}
            </div>
          );
        })
      ) : (
        <p>원래 모델이 별도 관계를 반환하지 않았어요. 상판 세면볼은 아래에서 하부장을 선택할 수 있어요.</p>
      )}
      <h4>상판 세면볼의 하부장</h4>
      <p>
        세면볼은 상판 위, 하부장 전체는 바닥 또는 벽 기준으로 배치해요. 연결하면 세면볼의 잘못된 바닥·벽
        접점은 사용하지 않으며 하부장의 위치를 확인해야 해요.
      </p>
      {effective.candidates
        .filter((candidate) => candidate.kind === 'basin' && candidate.mounting === 'countertop')
        .map((child) => {
          const originalParent =
            relations.find(
              (relation) =>
                relation.relation === 'partOf' &&
                relation.frontId === child.id &&
                !edits.disconnectedRelations?.includes(labRelationKey(relation)),
            )?.behindId ?? '';
          const selected = Object.prototype.hasOwnProperty.call(edits.supportParents ?? {}, child.id)
            ? (edits.supportParents![child.id] ?? '')
            : originalParent;
          return (
            <div key={child.id} data-testid="lab-support-parent">
              <label>
                {label(child.id)}의 하부장
                <select
                  aria-label={child.id + ' 하부장 선택'}
                  value={selected}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({
                      ...edits,
                      supportParents: { ...edits.supportParents, [child.id]: event.target.value || null },
                    })
                  }
                >
                  <option value="">연결 없음 · 확인 필요</option>
                  {parents.map((parent) => (
                    <option key={parent.id} value={parent.id}>
                      {label(parent.id)}
                      {parent.reflection !== 'physical' || !['floor', 'wall'].includes(parent.mounting)
                        ? ' (실체·설치 확인 필요)'
                        : ''}
                    </option>
                  ))}
                </select>
              </label>
              {Object.prototype.hasOwnProperty.call(edits.supportParents ?? {}, child.id) && (
                <>
                  <small>사용자 선택 · {selected ? label(selected) : '연결 해제'}</small>
                  <button
                    className={styles.button}
                    disabled={disabled}
                    onClick={() => {
                      const supportParents = { ...edits.supportParents };
                      delete supportParents[child.id];
                      onChange({ ...edits, supportParents });
                    }}
                  >
                    부모 선택 취소
                  </button>
                </>
              )}
              {!parents.length && (
                <p>
                  하부장 후보가 없어요. 누락된 설비 추가에서 하부장 종류와 실제 설치 방식을 먼저 확인해
                  주세요.
                </p>
              )}
            </div>
          );
        })}
      {!effective.candidates.some(
        (candidate) => candidate.kind === 'basin' && candidate.mounting === 'countertop',
      ) && <p>설비 목록에서 세면대의 설치 방식을 상판 위로 선택하면 부모를 연결할 수 있어요.</p>}
      {preview.issues.map((issue, i) => (
        <p key={issue.code + issue.candidateId + i} role="alert" className={styles.error}>
          {issue.message}
        </p>
      ))}
    </details>
  );
}
