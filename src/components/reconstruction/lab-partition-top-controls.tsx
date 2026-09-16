import type { LabManualDraft } from '@/lib/reconstruction/lab-correction';
import type { LabBathParent } from './lab-bath-rim-controls';
import styles from './reconstruction-lab.module.css';

export function LabPartitionTopControls({
  value,
  prefix,
  parents,
  disabled,
  onChange,
}: {
  value: LabManualDraft;
  prefix: string;
  parents: LabBathParent[];
  disabled: boolean;
  onChange: (value: LabManualDraft) => void;
}) {
  const support = value.support!,
    link = support.partitionTop;
  return (
    <div className={styles.manualFields}>
      <label>
        연결할 낮은 칸막이 후보
        <select
          aria-label={prefix + ' 연결 낮은 칸막이 후보'}
          disabled={disabled}
          value={link?.parentCandidateId ?? ''}
          onChange={(event) => {
            if (!event.target.value) {
              onChange({ ...value, support: undefined, baseHeightMm: '0' });
              return;
            }
            onChange({
              ...value,
              face: 'floor',
              wallPosition: undefined,
              support: {
                kind: 'partition-top',
                heightMm: support.heightMm,
                partitionTop: {
                  parentCandidateId: event.target.value,
                  offsetMm: link?.offsetMm ?? '0',
                  provenance: { parent: 'user', offset: 'user' },
                },
              },
            });
          }}
        >
          <option value="">연결 해제 · 바닥에 직접 설치</option>
          {link && !parents.some((parent) => parent.id === link.parentCandidateId) && (
            <option value={link.parentCandidateId}>기존 부모 후보 없음 · 다시 선택</option>
          )}
          {parents.map((parent) => (
            <option value={parent.id} key={parent.id}>
              {parent.label}
              {parent.plan ? '' : ' · 부모 설치 확인 필요'}
            </option>
          ))}
        </select>
      </label>
      {link && (
        <label>
          상단 중앙 기준 거리 mm
          <input
            aria-label={prefix + ' 칸막이 중앙 기준 거리 mm'}
            type="number"
            min="-20000"
            max="20000"
            step="1"
            disabled={disabled}
            value={link.offsetMm}
            onChange={(event) =>
              onChange({
                ...value,
                support: {
                  ...support,
                  partitionTop: {
                    ...link,
                    offsetMm: event.target.value,
                    provenance: { parent: link.provenance?.parent ?? 'user', offset: 'user' },
                  },
                },
              })
            }
          />
        </label>
      )}
      <p>
        부모의 상단 중심선을 따라 위치와 높이를 계산해요. 기존 추정 관계와 근거는 유지하며 직접 바꾼 필드만
        사용자 입력으로 기록해요. 실측값이 아니에요.
      </p>
    </div>
  );
}
