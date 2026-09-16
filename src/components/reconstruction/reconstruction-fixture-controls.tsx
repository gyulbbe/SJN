import { curtainHangingOffset } from '@/lib/reconstruction/curtain-model';
import {
  SHOWER_VARIANTS,
  SHOWER_VARIANT_LABELS,
  showerVariantDefaults,
} from '@/lib/reconstruction/fixture-variants';
import { defaultShowerCurb } from '@/lib/reconstruction/raised-glass-support';
import type { FixtureInstance, Scene } from '@/lib/types';
import type { RoomFace } from '@/lib/room-types';
import type { ReconstructionKind, ReconstructionStandardOptions } from '@/lib/reconstruction/types';
import styles from './reconstruction.module.css';

export type FixtureForm = Required<
  Pick<
    ReconstructionStandardOptions,
    | 'baseHeightMm'
    | 'yawDegrees'
    | 'basinVariant'
    | 'basinShape'
    | 'hasFrame'
    | 'opacity'
    | 'doorCount'
    | 'shelfStyle'
  >
> & {
  toiletLidState?: ReconstructionStandardOptions['toiletLidState'];
  pedestalShape?: ReconstructionStandardOptions['pedestalShape'];
  mirrorShape?: ReconstructionStandardOptions['mirrorShape'];
  vanityStyle?: ReconstructionStandardOptions['vanityStyle'];
  counterSupport?: ReconstructionStandardOptions['counterSupport'];
  showerVariant?: ReconstructionStandardOptions['showerVariant'];
  curtainHardware?: ReconstructionStandardOptions['curtainHardware'];
  support?: ReconstructionStandardOptions['support'];
  face: RoomFace;
  u: number;
  v: number;
};
export function fixtureForm(scene: Scene, fixture?: FixtureInstance): FixtureForm {
  const m = fixture?.reconstruction;
  const p = fixture?.roomPlacement;
  return {
    face: p?.face ?? 'back',
    u: p?.u ?? 0.5,
    v: p?.v ?? 0.5,
    baseHeightMm:
      m?.baseHeightMm ??
      (p && p.face !== 'floor'
        ? Math.max(
            0,
            (1 - p.v) * (scene.room?.heightMm ?? 2400) -
              (1 - (fixture?.anchor.y ?? 0.5)) * (m?.heightMm ?? 0) * (p.scale ?? 1),
          )
        : 0),
    yawDegrees: m?.yawDegrees ?? (m?.orientation === 'left' ? 90 : m?.orientation === 'right' ? -90 : 0),
    basinVariant: m?.basinVariant ?? 'pedestal',
    basinShape: m?.basinShape ?? 'rectangular',
    hasFrame: m?.hasFrame ?? false,
    opacity: m?.opacity ?? 0.18,
    doorCount: m?.doorCount ?? 2,
    shelfStyle: m?.shelfStyle ?? 'solid',
    toiletLidState: fixture ? m?.toiletLidState : 'closed',
    pedestalShape: m?.pedestalShape,
    mirrorShape: m?.mirrorShape,
    vanityStyle: m?.vanityStyle,
    counterSupport: m?.counterSupport,
    showerVariant: m?.showerVariant,
    curtainHardware: m?.curtainHardware,
    ...(m?.support ? { support: structuredClone(m.support) } : {}),
  };
}
export default function ReconstructionFixtureControls({
  kind,
  dimensions,
  value,
  disabled,
  onChange,
  onBasinVariant,
  onShowerDefaults,
}: {
  kind: ReconstructionKind;
  dimensions: { widthMm: number; depthMm: number; heightMm?: number };
  value: FixtureForm;
  disabled: boolean;
  onChange: (next: FixtureForm) => void;
  onBasinVariant: (variant: FixtureForm['basinVariant']) => void;
  onShowerDefaults?: (variant: NonNullable<FixtureForm['showerVariant']>) => void;
}) {
  const hangingOffset =
    kind === 'showerCurtain' &&
    typeof dimensions.heightMm === 'number' &&
    Number.isFinite(dimensions.heightMm) &&
    dimensions.heightMm > 0
      ? curtainHangingOffset(dimensions.heightMm, value.curtainHardware)
      : undefined;
  const set = <K extends keyof FixtureForm>(key: K, next: FixtureForm[K]) =>
    onChange({ ...value, [key]: next });
  const numeric = (
    label: string,
    key: 'u' | 'v' | 'baseHeightMm' | 'yawDegrees' | 'opacity' | 'doorCount',
    min: number,
    max: number,
    step = 1,
    factor = 1,
  ) => (
    <label>
      {label}
      <input
        aria-label={label}
        disabled={
          !!(value.support?.bathRim || value.support?.partitionTop) &&
          ['u', 'v', 'baseHeightMm', 'yawDegrees'].includes(key)
        }
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value[key]) ? Number((value[key] * factor).toFixed(4)) : ''}
        onChange={(e) => {
          const next = e.currentTarget.valueAsNumber / factor;
          if (key === 'baseHeightMm' && value.support)
            onChange({
              ...value,
              baseHeightMm: next,
              support: {
                ...value.support,
                heightMm: next,
                provenance: { ...value.support.provenance, height: 'user' },
              },
            });
          else set(key, next);
        }}
      />
    </label>
  );
  const floorOnly =
    kind === 'toilet' ||
    kind === 'bath' ||
    kind === 'lowPartition' ||
    kind === 'glassPartition' ||
    kind === 'showerCurtain' ||
    (kind === 'vanity' && !(value.vanityStyle === 'open-counter' && value.counterSupport === 'wall')) ||
    (kind === 'basin' &&
      value.basinVariant !== 'wall' &&
      !(value.vanityStyle === 'open-counter' && value.counterSupport === 'wall'));
  const showerDefaults =
    kind === 'shower' && value.showerVariant ? showerVariantDefaults(value.showerVariant) : undefined;
  return (
    <fieldset disabled={disabled} className={styles.fixtureControls}>
      {kind === 'showerCurtain' && (
        <div className={styles.control}>
          <label>
            커튼 지지 방식
            <select
              aria-label="커튼 지지 방식"
              value={value.curtainHardware ?? 'rod'}
              onChange={(e) => set('curtainHardware', e.target.value as FixtureForm['curtainHardware'])}
            >
              <option value="rod">봉과 고리</option>
              <option value="track">레일</option>
              <option value="none">지지대 표시 안 함</option>
            </select>
          </label>
          {hangingOffset !== undefined && (
            <label>
              커튼 걸이 높이 mm
              <input
                aria-label="커튼 걸이 높이 mm"
                type="number"
                min={hangingOffset}
                max={6000}
                step={1}
                value={
                  Number.isFinite(value.baseHeightMm) ? Math.round(value.baseHeightMm + hangingOffset) : ''
                }
                onChange={(e) => set('baseHeightMm', e.currentTarget.valueAsNumber - hangingOffset)}
              />
            </label>
          )}
          <p className={styles.help}>
            규격은 봉·고리를 포함한 전체 모형 기준이에요. 걸이 높이는 모형에서 계산하며 실측값이 아니에요.
            좌우·앞뒤 위치와 천 하단 높이를 따로 조절할 수 있어요.
          </p>
        </div>
      )}
      {kind === 'mirror' && (
        <label className={styles.control}>
          거울 외곽 형태
          <select
            aria-label="거울 외곽 형태"
            value={value.mirrorShape ?? ''}
            onChange={(e) => set('mirrorShape', (e.target.value || undefined) as FixtureForm['mirrorShape'])}
          >
            <option value="">기존 모양 유지</option>
            <option value="rectangular">사각형</option>
            <option value="oval">원형·타원형</option>
            <option value="arched">아치형</option>
          </select>
        </label>
      )}
      {(kind === 'vanity' || (kind === 'basin' && value.basinVariant === 'vanity')) && (
        <div className={styles.editGrid}>
          <label>
            상판·하부 구조
            <select
              aria-label="상판·하부 구조"
              value={value.vanityStyle ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  vanityStyle: (e.target.value || undefined) as FixtureForm['vanityStyle'],
                  counterSupport:
                    e.target.value === 'open-counter' ? (value.counterSupport ?? 'wall') : undefined,
                })
              }
            >
              <option value="">기존 모양 유지</option>
              <option value="enclosed">닫힌 하부장</option>
              <option value="open-counter">개방형 상판·상부 세면볼</option>
            </select>
          </label>
          {value.vanityStyle === 'open-counter' && (
            <>
              <label>
                상판 지지 구조
                <select
                  aria-label="상판 지지 구조"
                  value={value.counterSupport ?? 'wall'}
                  onChange={(e) => set('counterSupport', e.target.value as FixtureForm['counterSupport'])}
                >
                  <option value="wall">벽 지지 · 바닥 패널 없음</option>
                  <option value="left-panel">왼쪽 패널</option>
                  <option value="right-panel">오른쪽 패널</option>
                  <option value="both-panels">양쪽 패널</option>
                </select>
              </label>
              <label>
                상판 위 세면볼 형태
                <select
                  aria-label="상판 위 세면볼 형태"
                  value={value.basinShape}
                  onChange={(e) => set('basinShape', e.target.value as FixtureForm['basinShape'])}
                >
                  <option value="round">원형·타원형</option>
                  <option value="rectangular">사각형</option>
                </select>
              </label>
              <p className={styles.help}>
                지지 구조를 바꾸면 모형 높이와 하단 높이를 기본값으로 맞춰요. 벽 지지는 상판·볼·수전 전체 높이
                330mm, 하단 650mm이며 패널형은 전체 높이 950mm, 하단 0mm예요. 모두 수정 가능한 기본값입니다.
              </p>
            </>
          )}
        </div>
      )}
      {kind === 'shower' && (
        <div className={styles.control}>
          <label>
            샤워 형태
            <select
              aria-label="샤워 형태"
              value={value.showerVariant ?? ''}
              onChange={(event) =>
                set('showerVariant', (event.target.value || undefined) as FixtureForm['showerVariant'])
              }
            >
              <option value="">미확인 · 기존 모양 유지</option>
              {SHOWER_VARIANTS.map((variant) => (
                <option key={variant} value={variant}>
                  {SHOWER_VARIANT_LABELS[variant]}
                </option>
              ))}
            </select>
          </label>
          <p className={styles.help}>
            형태를 바꿔도 입력한 규격과 설치 위치는 유지해요. 호스를 포함한 전체 모형과 작은 헤드 부분의
            크기는 달라요.
          </p>
          {showerDefaults && (
            <>
              <p className={styles.help}>
                이 형태의 앱 기본값: 폭 {showerDefaults.widthMm} × 높이 {showerDefaults.heightMm} × 깊이{' '}
                {showerDefaults.depthMm}mm, 하단 {showerDefaults.baseHeightMm}mm. 실측값이 아니며 직접 수정할
                수 있어요.
              </p>
              {onShowerDefaults && (
                <button type="button" onClick={() => onShowerDefaults(value.showerVariant!)}>
                  이 형태의 기본 규격 적용
                </button>
              )}
            </>
          )}
        </div>
      )}
      {kind === 'toilet' && (
        <label className={styles.control}>
          변기 뚜껑 상태
          <select
            aria-label="변기 뚜껑 상태"
            value={value.toiletLidState ?? 'legacy'}
            onChange={(e) => set('toiletLidState', e.target.value as 'open' | 'closed')}
          >
            {value.toiletLidState === undefined && (
              <option value="legacy" disabled>
                기존 모양 유지
              </option>
            )}
            <option value="open">열림</option>
            <option value="closed">닫힘</option>
          </select>
        </label>
      )}
      {kind === 'basin' && (
        <div className={styles.editGrid}>
          <label className={styles.control}>
            세면대 설치 방식
            <select
              aria-label="세면대 설치 방식"
              value={value.basinVariant}
              onChange={(e) => onBasinVariant(e.target.value as FixtureForm['basinVariant'])}
            >
              <option value="wall">벽걸이형</option>
              <option value="pedestal">기둥형</option>
              <option value="vanity">하부장형</option>
            </select>
          </label>
          <label className={styles.control}>
            세면볼 형태
            <select
              aria-label="세면볼 형태"
              value={value.basinShape}
              onChange={(e) => set('basinShape', e.target.value as FixtureForm['basinShape'])}
            >
              <option value="rectangular">사각형</option>
              <option value="round">둥근 형태</option>
            </select>
          </label>
          {value.basinVariant === 'pedestal' && (
            <label className={styles.control}>
              기둥 단면
              <select
                aria-label="기둥 단면"
                value={value.pedestalShape ?? ''}
                onChange={(event) =>
                  set('pedestalShape', (event.target.value || undefined) as FixtureForm['pedestalShape'])
                }
              >
                <option value="">미확인 · 기존 원형 유지</option>
                <option value="round">원형 · 직접 확인</option>
                <option value="rectangular">사각형 · 직접 확인</option>
              </select>
              <small>세면볼 모양과 별개예요. 보이지 않는 받침 형태는 기본값이며 직접 확인해 주세요.</small>
            </label>
          )}
        </div>
      )}
      <label className={styles.control}>
        설치 위치
        <select
          aria-label="재구성 설치 면"
          value={value.face}
          onChange={(e) => set('face', e.target.value as RoomFace)}
        >
          {floorOnly ? (
            <option value="floor">
              {kind === 'showerCurtain' ? '공간 평면 위치 · 상부 매달림' : '바닥 기준'}
            </option>
          ) : (
            <>
              <option value="back">정면 벽</option>
              <option value="left">왼쪽 벽</option>
              <option value="right">오른쪽 벽</option>
            </>
          )}
        </select>
      </label>
      {kind === 'glassPartition' && value.face === 'floor' && (
        <label className={styles.control}>
          유리 지지면
          <select
            aria-label="유리 지지면"
            value={value.support?.kind ?? ''}
            onChange={(event) => {
              const supportKind = event.target.value as 'bath-rim' | 'shower-curb' | 'partition-top' | '';
              if (!supportKind) {
                onChange({ ...value, support: undefined, baseHeightMm: 0 });
                return;
              }
              const defaultHeight =
                supportKind === 'bath-rim' ? 600 : supportKind === 'partition-top' ? 1000 : 100;
              const heightMm =
                value.support?.heightMm ?? (value.baseHeightMm > 0 ? value.baseHeightMm : defaultHeight);
              onChange({
                ...value,
                baseHeightMm: heightMm,
                support: {
                  kind: supportKind,
                  heightMm,
                  provenance: {
                    kind: 'user',
                    height:
                      value.support?.provenance.height === 'parent'
                        ? 'user'
                        : (value.support?.provenance.height ?? 'default'),
                  },
                  ...(supportKind === 'shower-curb'
                    ? {
                        curb:
                          value.support?.curb ?? defaultShowerCurb(dimensions.widthMm, dimensions.depthMm),
                      }
                    : {}),
                },
              });
            }}
          >
            <option value="">바닥에 직접 설치</option>
            <option value="bath-rim">욕조 테두리 위 · 직접 확인</option>
            <option value="shower-curb">샤워 턱 위 · 직접 확인</option>
            <option value="partition-top">낮은 칸막이 상단 · 부모 선택</option>
          </select>
        </label>
      )}
      {value.support?.kind === 'shower-curb' &&
        (value.support.curb ? (
          <div className={styles.editGrid}>
            {(
              [
                ['widthMm', '턱 폭 (mm)', 'width'],
                ['depthMm', '턱 깊이 (mm)', 'depth'],
              ] as const
            ).map(([key, label, source]) => (
              <label key={key}>
                {label} · {value.support!.curb!.provenance[source] === 'default' ? '기본값' : '사용자 입력'}
                <input
                  type="number"
                  min="1"
                  max="20000"
                  step="1"
                  aria-label={label}
                  value={value.support!.curb![key]}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      support: {
                        ...value.support!,
                        curb: {
                          ...value.support!.curb!,
                          [key]: e.currentTarget.valueAsNumber,
                          provenance: { ...value.support!.curb!.provenance, [source]: 'user' },
                        },
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
            onClick={() =>
              onChange({
                ...value,
                support: {
                  ...value.support!,
                  curb: defaultShowerCurb(dimensions.widthMm, dimensions.depthMm),
                },
              })
            }
          >
            확인한 샤워 턱 모형 추가
          </button>
        ))}
      <div className={styles.editGrid}>
        {numeric('설치면 가로 위치 (%)', 'u', 0, 100, 1, 100)}
        {value.face === 'floor' && numeric('바닥 깊이 위치 (%)', 'v', 0, 100, 1, 100)}
        {numeric(
          value.support ? '유리 지지면 높이 (mm)' : '모형 하단 설치 높이 (mm)',
          'baseHeightMm',
          0,
          20000,
        )}
        {value.face === 'floor' && numeric('모형 방향 (°)', 'yawDegrees', -360, 360)}
        {kind === 'glassPartition' && numeric('유리 불투명도 (%)', 'opacity', 0, 100, 1, 100)}
        {kind === 'mirrorCabinet' && numeric('거울 문 개수', 'doorCount', 1, 6)}
      </div>
      {(kind === 'glassPartition' || kind === 'mirror' || kind === 'mirrorCabinet') && (
        <label className={styles.checkControl}>
          <input
            type="checkbox"
            checked={value.hasFrame}
            onChange={(e) => set('hasFrame', e.target.checked)}
          />{' '}
          프레임 표시
        </label>
      )}
      {kind === 'wallShelf' && (
        <label className={styles.control}>
          선반 형태
          <select
            aria-label="선반 형태"
            value={value.shelfStyle}
            onChange={(e) => set('shelfStyle', e.target.value as FixtureForm['shelfStyle'])}
          >
            <option value="solid">판형 선반</option>
            <option value="rack">수건 선반</option>
          </select>
        </label>
      )}
      {value.support && (
        <p className={styles.help}>
          지지면 높이:{' '}
          {value.support.provenance.height === 'parent'
            ? '연결된 부모 모형에서 계산'
            : value.support.provenance.height === 'user'
              ? '사용자 입력'
              : '기본값 · 확인 필요'}
          .{value.support.provenance.kind === 'inferred' && ' 관측 관계를 바탕으로 추정한 연결 · 확인 필요.'}
          {value.support.partitionTop
            ? ' 연결된 낮은 칸막이의 상단을 따라가요. 부모 이동·회전·규격 변경을 함께 반영해요.'
            : value.support.bathRim
              ? ' 연결된 욕조의 테두리를 따라가요. 위 연결 설정에서 욕조·테두리·중앙 기준 거리를 바꿀 수 있어요.'
              : value.support.kind === 'shower-curb' && value.support.curb
                ? ' 턱은 유리 중앙 아래부터 바닥까지 함께 이동하는 모형이에요. 회색 마감과 치수는 실측이 아니며 턱 규격을 확인해 주세요.'
                : ' 실제 욕조·턱 모형과 연결하지 않은 높이예요. 해당 지지 물체를 옮겨도 자동으로 이동하지 않아요.'}
        </p>
      )}
      <p className={styles.help}>
        설치 높이는 바닥에서 모형 하단까지의 거리예요. 사진에서 확인되지 않은 치수·위치는 기본값 또는
        추정값입니다.
      </p>
    </fieldset>
  );
}
