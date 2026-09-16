import type { FixtureInstance, Scene } from '@/lib/types';
import type { RaisedGlassSupport } from '@/lib/reconstruction/types';
import {
  bathRimSideLabels,
  canSupportBathGlass,
  type BathRimResolution,
} from '@/lib/reconstruction/bath-rim';
import styles from './reconstruction.module.css';

export default function BathRimControls({
  scene,
  fixture,
  support,
  result,
  disabled,
  onChange,
}: {
  scene: Scene;
  fixture: FixtureInstance;
  support: RaisedGlassSupport;
  result: BathRimResolution;
  disabled: boolean;
  onChange: (support: RaisedGlassSupport) => void;
}) {
  const parents = scene.fixtures.filter((f) => f.id !== fixture.id && canSupportBathGlass(f));
  const link = support.bathRim;
  return (
    <fieldset disabled={disabled} className={styles.fixtureControls}>
      <legend>실제 배치한 욕조와 연결</legend>
      <label className={styles.control}>
        {link ? '연결할 표준 욕조' : '앞쪽 테두리 중앙에 연결할 표준 욕조'}
        <select
          aria-label="유리 연결 욕조"
          value={link?.parentFixtureId ?? ''}
          onChange={(e) => {
            if (!e.target.value) {
              const next = { ...support, provenance: { kind: 'user' as const, height: 'user' as const } };
              delete next.bathRim;
              onChange(next);
            } else
              onChange({
                ...support,
                provenance: { kind: 'user', height: 'parent' },
                bathRim: {
                  parentFixtureId: e.target.value,
                  side: link?.side ?? 'front',
                  offsetMm: link?.offsetMm ?? 0,
                  provenance: { parent: 'user', side: 'user', offset: 'user' },
                },
              });
          }}
        >
          <option value="">연결하지 않고 직접 확인한 높이 사용</option>
          {link && !parents.some((p) => p.id === link.parentFixtureId) && (
            <option value={link.parentFixtureId}>기존 연결 욕조 없음 · 다시 선택</option>
          )}
          {parents.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {link && (
        <>
          <label className={styles.control}>
            테두리 위치 · 욕조 자체 방향 기준
            <select
              aria-label="욕조 연결 테두리"
              value={link.side}
              onChange={(e) =>
                onChange({
                  ...support,
                  bathRim: {
                    ...link,
                    side: e.target.value as typeof link.side,
                    provenance: { ...link.provenance, side: 'user' },
                  },
                })
              }
            >
              {Object.entries(bathRimSideLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.control}>
            테두리 중앙 기준 거리 (mm)
            <input
              aria-label="욕조 테두리 중앙 기준 거리 (mm)"
              type="number"
              min="-20000"
              max="20000"
              step="1"
              value={Number.isFinite(link.offsetMm) ? link.offsetMm : ''}
              onChange={(e) =>
                onChange({
                  ...support,
                  bathRim: {
                    ...link,
                    offsetMm: e.currentTarget.valueAsNumber,
                    provenance: { ...link.provenance, offset: 'user' },
                  },
                })
              }
            />
          </label>
          <p className={styles.help}>
            앞·뒤 테두리는 양수가 욕조 오른쪽, 왼쪽·오른쪽 테두리는 양수가 욕조 앞쪽이에요. 욕조
            이동·회전·규격 변경을 따라가며 유리 크기는 유지해요.
          </p>
          {result.status === 'attached' ? (
            <p role="status" className={styles.help}>
              연결 높이 {result.placement.baseHeightMm!.toFixed(1)}mm · 욕조 모형에서 계산. 테두리 평평한 길이{' '}
              {Math.floor(result.availableLengthMm)}mm, 폭 {Math.floor(result.availableThicknessMm)}mm.
              실측값이 아니에요.
            </p>
          ) : result.status === 'held' ? (
            <p role="alert" className={styles.warning}>
              배치 보류: {result.reason} 원래 유리 데이터는 보존돼요.
            </p>
          ) : null}
        </>
      )}
      {!parents.length && (
        <p className={styles.help}>연결할 표준 욕조가 없어요. 먼저 욕조를 배치한 뒤 선택해 주세요.</p>
      )}
      <p className={styles.help}>
        이 연결은 사용자가 확인한 관계예요. 사진에서 욕조와 유리 연결을 자동 인식한 결과가 아니며, 실제 시공
        가능 여부는 별도로 확인해야 해요.
      </p>
    </fieldset>
  );
}
