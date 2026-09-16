import type { FixtureInstance, Scene } from '@/lib/types';
import type { RaisedGlassSupport } from '@/lib/reconstruction/types';
import { canSupportPartitionGlass, type BathRimResolution } from '@/lib/reconstruction/bath-rim';
import styles from './reconstruction.module.css';

export default function PartitionTopControls({
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
  onChange: (support?: RaisedGlassSupport) => void;
}) {
  const parents = scene.fixtures.filter(
    (parent) => parent.id !== fixture.id && canSupportPartitionGlass(parent),
  );
  const link = support.partitionTop;
  return (
    <fieldset disabled={disabled} className={styles.fixtureControls}>
      <legend>낮은 칸막이 상단과 연결</legend>
      <label className={styles.control}>
        연결할 낮은 칸막이
        <select
          aria-label="유리 연결 낮은 칸막이"
          value={link?.parentFixtureId ?? ''}
          onChange={(event) => {
            if (!event.target.value) {
              onChange(undefined);
              return;
            }
            onChange({
              kind: 'partition-top',
              heightMm: support.heightMm,
              provenance: { kind: 'user', height: 'parent' },
              partitionTop: {
                parentFixtureId: event.target.value,
                offsetMm: link?.offsetMm ?? 0,
                provenance: { parent: 'user', offset: 'user' },
              },
            });
          }}
        >
          <option value="">연결 해제 · 바닥에 직접 설치</option>
          {link && !parents.some((parent) => parent.id === link.parentFixtureId) && (
            <option value={link.parentFixtureId}>기존 연결 칸막이 없음 · 다시 선택</option>
          )}
          {parents.map((parent) => (
            <option key={parent.id} value={parent.id}>
              {parent.name}
            </option>
          ))}
        </select>
      </label>
      {link && (
        <label className={styles.control}>
          상단 중앙 기준 거리 (mm)
          <input
            aria-label="칸막이 상단 중앙 기준 거리 (mm)"
            type="number"
            min="-20000"
            max="20000"
            step="1"
            value={Number.isFinite(link.offsetMm) ? link.offsetMm : ''}
            onChange={(event) =>
              onChange({
                ...support,
                provenance: {
                  ...support.provenance,
                  kind: link.provenance.parent === 'inferred' ? 'inferred' : 'user',
                },
                partitionTop: {
                  ...link,
                  offsetMm: event.currentTarget.valueAsNumber,
                  provenance: { ...link.provenance, offset: 'user' },
                },
              })
            }
          />
        </label>
      )}
      <p className={styles.help}>
        {support.provenance.kind === 'inferred'
          ? '사진의 관계를 바탕으로 추정한 연결이에요. '
          : '사용자가 선택한 연결이에요. '}
        칸막이의 상단 중심선을 따라가며 이동·회전·규격 변경을 함께 반영해요. 치수와 높이는 실측값이 아니에요.
      </p>
      {result.status === 'attached' ? (
        <p role="status" className={styles.help}>
          연결 높이 {result.placement.baseHeightMm!.toFixed(1)}mm · 부모 모형에서 계산. 사용 가능한 길이{' '}
          {Math.floor(result.availableLengthMm)}mm, 폭 {Math.floor(result.availableThicknessMm)}mm.
        </p>
      ) : result.status === 'held' ? (
        <p role="alert" className={styles.warning}>
          배치 보류: {result.reason} 원래 유리와 연결 정보는 보존돼요.
        </p>
      ) : (
        <p className={styles.help}>위에서 지지할 낮은 칸막이를 선택해 주세요.</p>
      )}
    </fieldset>
  );
}
