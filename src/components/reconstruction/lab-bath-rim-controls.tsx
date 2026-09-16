import type { LabManualDraft } from '@/lib/reconstruction/lab-correction';
import type { CandidateFixturePlan } from '@/lib/reconstruction/candidate-pipeline';
import { bathRimSideLabels } from '@/lib/reconstruction/bath-rim';
import styles from './reconstruction-lab.module.css';
export type LabBathParent = {
  id: string;
  label: string;
  kind?: 'bath' | 'lowPartition';
  plan?: CandidateFixturePlan;
};
export function LabBathRimControls({
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
    link = support.bathRim;
  return (
    <div className={styles.manualFields}>
      <label>
        {link ? '연결할 욕조 후보' : '앞쪽 테두리 중앙에 연결할 욕조 후보'}
        <select
          aria-label={prefix + ' 연결 욕조 후보'}
          disabled={disabled}
          value={link?.parentCandidateId ?? ''}
          onChange={(e) => {
            if (!e.target.value) {
              const next = { ...support };
              delete next.bathRim;
              onChange({ ...value, support: next });
              return;
            }
            onChange({
              ...value,
              face: 'floor',
              wallPosition: undefined,
              support: {
                ...support,
                bathRim: {
                  parentCandidateId: e.target.value,
                  side: link?.side ?? 'front',
                  offsetMm: link?.offsetMm ?? '0',
                  provenance: { parent: 'user', side: 'user', offset: 'user' },
                },
              },
            });
          }}
        >
          <option value="">연결 없이 확인한 높이만 사용</option>
          {link && !parents.some((p) => p.id === link.parentCandidateId) && (
            <option value={link.parentCandidateId}>기존 욕조 후보 없음 · 다시 선택</option>
          )}
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.plan ? '' : ' · 부모 설치 확인 필요'}
            </option>
          ))}
        </select>
      </label>
      {link && (
        <>
          <label>
            욕조 자체 방향의 테두리
            <select
              aria-label={prefix + ' 욕조 테두리'}
              value={link.side}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...value,
                  support: {
                    ...support,
                    bathRim: {
                      ...link,
                      side: e.target.value as typeof link.side,
                      provenance: {
                        ...(link.provenance ?? { parent: 'user', offset: 'user' }),
                        side: 'user',
                      },
                    },
                  },
                })
              }
            >
              {Object.entries(bathRimSideLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            테두리 중앙 기준 거리 mm
            <input
              aria-label={prefix + ' 욕조 중앙 기준 거리 mm'}
              type="number"
              min="-20000"
              max="20000"
              step="1"
              disabled={disabled}
              value={link.offsetMm}
              onChange={(e) =>
                onChange({
                  ...value,
                  support: {
                    ...support,
                    bathRim: {
                      ...link,
                      offsetMm: e.target.value,
                      provenance: {
                        ...(link.provenance ?? { parent: 'user', side: 'user' }),
                        offset: 'user',
                      },
                    },
                  },
                })
              }
            />
          </label>
          <p>
            부모 욕조의 모형·배치가 확인되면 실제 테두리 높이와 방향을 계산해요. 앞·뒤 테두리는 양수가 욕조
            오른쪽, 왼쪽·오른쪽 테두리는 양수가 욕조 앞쪽이에요. 추정 출처는 명시한 관측 근거와 함께 보존하며
            직접 바꾼 필드는 사용자 입력으로 기록해요. 실측값이 아니에요.
          </p>
        </>
      )}
    </div>
  );
}
