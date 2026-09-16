'use client';

import { openCounterDefaults, showerVariantDefaults } from '@/lib/reconstruction/fixture-variants';

import {
  PRODUCT_NEUTRAL_OPTICS,
  resolveProductColor,
  type ProductColorOverride,
} from '@/lib/reconstruction/product-color';
import {
  fixturePropertyFormPatch,
  inspectFixturePropertyChanges,
  updateCandidateFromPropertyEdit,
} from '@/lib/reconstruction/fixture-property-changes';
import BathRimControls from './bath-rim-controls';
import PartitionTopControls from './partition-top-controls';
import { resolveBathRimPlacement } from '@/lib/reconstruction/bath-rim';
import { useEffect, useRef, useState } from 'react';
import type { FixtureInstance, MaterialVersion, Scene, Surface } from '@/lib/types';
import { useEditor } from '@/lib/editor-store';
import { createReconstructionTile, updateReconstructionFixture } from '@/lib/reconstruction';
import {
  reconstructionLabels,
  reconstructionDefaults,
  type ReconstructionKind,
} from '@/lib/reconstruction/types';
import styles from './reconstruction.module.css';
import ReconstructionFixtureControls, {
  fixtureForm,
  type FixtureForm,
} from './reconstruction-fixture-controls';

export default function ReconstructionProperties({
  scene,
  fixture,
  surface,
  materials,
  onMaterialsChanged,
}: {
  scene: Scene;
  fixture?: FixtureInstance;
  surface?: Surface;
  materials: Record<string, MaterialVersion>;
  onMaterialsChanged: () => Promise<void>;
}) {
  const original = fixture?.reconstruction;
  const material = materials[surface?.materialVersionId || fixture?.materialVersionId || ''];
  const [kind, setKind] = useState<ReconstructionKind>((original?.kind as ReconstructionKind) || 'toilet');
  const [color, setColor] = useState(
    original?.color || (/^#[0-9a-f]{6}$/i.test(material?.color || '') ? material.color : '#ddddcf'),
  );
  const [colorOverride, setColorOverride] = useState<ProductColorOverride>();
  const [bathLiningColor, setBathLiningColor] = useState(original?.bathLiningColor);
  const [bathLiningEdited, setBathLiningEdited] = useState(false);
  const [variantHeightDefault, setVariantHeightDefault] = useState(false);
  const [showerDefaultsApplied, setShowerDefaultsApplied] = useState(false);
  const [width, setWidth] = useState(original?.widthMm || material?.widthMm || 300);
  const [height, setHeight] = useState(
    original?.heightMm || material?.heightMm || (surface?.kind === 'wall' ? 600 : 300),
  );
  const [depth, setDepth] = useState(original?.depthMm || 100);
  const [orientation, setOrientation] = useState<'back' | 'left' | 'right'>(original?.orientation || 'back');
  const [form, setForm] = useState(() => fixtureForm(scene, fixture));
  const [lidEdited, setLidEdited] = useState(false);
  const [dimensionEdits, setDimensionEdits] = useState({ width: false, height: false, depth: false });
  const standard = original?.version === 2;
  const [grout, setGrout] = useState(surface?.tile.groutWidth || 0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!scene.room || (!original && !surface)) return null;
  const bathResult =
    fixture && (form.support?.bathRim || form.support?.partitionTop)
      ? resolveBathRimPlacement(scene.room, scene.fixtures, {
          ...original!,
          ...form,
          version: 2,
          kind,
          widthMm: width,
          heightMm: height,
          depthMm: depth,
          scale: 1,
        })
      : { status: 'independent' as const };
  const activeForm =
    bathResult.status === 'attached'
      ? {
          ...form,
          u: bathResult.placement.u,
          v: bathResult.placement.v,
          baseHeightMm: bathResult.placement.baseHeightMm!,
          yawDegrees: bathResult.placement.yawDegrees!,
          support: bathResult.placement.support,
        }
      : form;
  function chooseKind(nextKind: ReconstructionKind, variant?: FixtureForm['basinVariant']) {
    const defaults = reconstructionDefaults(nextKind, variant);
    if (nextKind !== kind) {
      setColor(resolveProductColor(nextKind).color);
      setColorOverride(undefined);
    }
    setKind(nextKind);
    if (nextKind !== kind) {
      setBathLiningColor(undefined);
      setBathLiningEdited(false);
    }
    setLidEdited(false);
    setShowerDefaultsApplied(false);
    setDimensionEdits({ width: false, height: false, depth: false });
    setWidth(defaults.widthMm);
    setHeight(defaults.heightMm);
    setDepth(defaults.depthMm);
    setForm((previous) => ({
      ...previous,
      ...defaults,
      face: defaults.face,
      baseHeightMm:
        defaults.baseHeightMm ??
        (defaults.face === 'floor' || nextKind === 'door'
          ? 0
          : ((scene.room?.heightMm ?? 2400) - defaults.heightMm) / 2),
      basinVariant: defaults.basinVariant ?? previous.basinVariant,
      basinShape: defaults.basinShape ?? 'rectangular',
      pedestalShape:
        nextKind === 'basin' && defaults.basinVariant === 'pedestal' ? previous.pedestalShape : undefined,
      hasFrame: defaults.hasFrame ?? false,
      opacity: defaults.opacity ?? 0.18,
      doorCount: defaults.doorCount ?? 2,
      shelfStyle: defaults.shelfStyle ?? 'solid',
      toiletLidState: defaults.toiletLidState,
      support: undefined,
      mirrorShape: undefined,
      showerVariant: undefined,
      curtainHardware: nextKind === 'showerCurtain' ? defaults.curtainHardware : undefined,
      vanityStyle: undefined,
      counterSupport: undefined,
    }));
  }
  async function apply(convertToStandard = false) {
    const state = useEditor.getState(),
      project = state.project;
    if (!project || state.draft || state.editing !== 'before' || busy) return;
    if (
      ![width, height, depth, grout].every(Number.isFinite) ||
      width < 1 ||
      height < 1 ||
      depth < 0 ||
      width > 20000 ||
      height > 6000 ||
      depth > 20000 ||
      grout < 0 ||
      grout > 15
    ) {
      setError('규격과 줄눈 범위를 확인해 주세요.');
      return;
    }
    if (
      (standard || convertToStandard) &&
      (![
        activeForm.u,
        activeForm.v,
        activeForm.baseHeightMm,
        activeForm.yawDegrees,
        activeForm.opacity,
        activeForm.doorCount,
      ].every(Number.isFinite) ||
        activeForm.u < 0 ||
        activeForm.u > 1 ||
        activeForm.v < 0 ||
        activeForm.v > 1 ||
        activeForm.baseHeightMm < 0 ||
        activeForm.baseHeightMm + height * (convertToStandard ? (fixture?.roomPlacement?.scale ?? 1) : 1) >
          scene.room!.heightMm ||
        activeForm.opacity < 0 ||
        activeForm.opacity > 1 ||
        !Number.isInteger(activeForm.doorCount) ||
        activeForm.doorCount < 1 ||
        activeForm.doorCount > 6)
    ) {
      setError('설치 위치·높이·불투명도·문 개수를 확인해 주세요. 모형은 공간 높이 안에 들어와야 해요.');
      return;
    }
    if (bathResult.status === 'held') {
      setError(bathResult.reason);
      return;
    }
    setBusy(true);
    setError('');
    const current = () =>
      alive.current &&
      useEditor.getState().project?.id === project.id &&
      useEditor.getState().project?.editRevision === project.editRevision &&
      useEditor.getState().editing === 'before' &&
      !useEditor.getState().draft;
    try {
      if (fixture?.reconstruction) {
        const colorEvidence = colorOverride
          ? resolveProductColor(
              kind,
              { color: original!.color, colorEvidence: original?.colorEvidence },
              colorOverride,
            )
          : kind !== original?.kind
            ? resolveProductColor(kind)
            : original?.colorEvidence;
        const initialForm = fixtureForm(scene, fixture);
        const propertyChanges = inspectFixturePropertyChanges({
          before: initialForm,
          after: activeForm,
          oldKind: original!.kind as ReconstructionKind,
          kind,
          oldOrientation: original!.orientation ?? 'back',
          orientation,
        });
        const formPatch = fixturePropertyFormPatch(initialForm, activeForm, kind, {
          convert: convertToStandard,
          kindChanged: propertyChanges.kind,
        });
        const changedDimensions = {
          width: dimensionEdits.width && width !== original!.widthMm,
          height: dimensionEdits.height && height !== original!.heightMm,
          depth: dimensionEdits.depth && depth !== original!.depthMm,
        };
        const shapeProvenance = Object.fromEntries(
          (
            [
              'pedestalShape',
              'mirrorShape',
              'vanityStyle',
              'counterSupport',
              'showerVariant',
              'curtainHardware',
            ] as const
          )
            .filter(
              (key) =>
                Object.hasOwn(formPatch, key) &&
                (propertyChanges.kind || formPatch[key] !== initialForm[key]),
            )
            .map((key) => [
              key,
              formPatch[key] === undefined ? undefined : propertyChanges.kind ? 'default' : 'user',
            ]),
        );
        const next = await updateReconstructionFixture(
          fixture,
          scene.room!,
          {
            kind,
            color: colorEvidence?.color ?? color,
            colorEvidence,
            bathLiningColor: kind === 'bath' ? bathLiningColor : undefined,
            widthMm: width * (convertToStandard ? (fixture.roomPlacement?.scale ?? 1) : 1),
            heightMm: height * (convertToStandard ? (fixture.roomPlacement?.scale ?? 1) : 1),
            depthMm: depth * (convertToStandard ? (fixture.roomPlacement?.scale ?? 1) : 1),
            orientation,
            ...(standard || convertToStandard
              ? {
                  ...formPatch,
                  ...(activeForm.face !== 'floor' &&
                  (convertToStandard || propertyChanges.position || propertyChanges.mounting)
                    ? {
                        v: 1 - activeForm.baseHeightMm / scene.room!.heightMm,
                        baseHeightMm: activeForm.baseHeightMm,
                      }
                    : {}),
                  provenance: {
                    ...original?.provenance,
                    ...(propertyChanges.kind ? { kind: 'user' as const } : {}),
                    ...(propertyChanges.mounting ? { mounting: 'user' as const } : {}),
                    ...(propertyChanges.wall ? { wall: 'user' as const } : {}),
                    ...(propertyChanges.position ? { position: 'user' as const } : {}),
                    ...(propertyChanges.shape ? { shape: 'user' as const } : {}),
                    ...shapeProvenance,
                    ...(Object.values(changedDimensions).some(Boolean)
                      ? { dimensions: 'user' as const }
                      : showerDefaultsApplied || propertyChanges.kind
                        ? { dimensions: 'default' as const }
                        : {}),
                    ...Object.fromEntries(
                      (['width', 'height', 'depth'] as const)
                        .filter(
                          (axis) =>
                            changedDimensions[axis] ||
                            showerDefaultsApplied ||
                            propertyChanges.kind ||
                            (axis === 'height' && variantHeightDefault),
                        )
                        .map((axis) => [axis, changedDimensions[axis] ? 'user' : 'default']),
                    ),
                    ...(colorOverride || propertyChanges.kind
                      ? {
                          appearance: colorEvidence?.source ?? 'default',
                          color: colorEvidence?.source ?? 'default',
                        }
                      : {}),
                    ...(kind === 'bath' && bathLiningEdited && bathLiningColor !== original?.bathLiningColor
                      ? { bathLiningColor: 'user' as const }
                      : {}),
                    ...(kind === 'toilet' && propertyChanges.toiletLidState
                      ? { toiletLidState: propertyChanges.kind ? ('default' as const) : ('user' as const) }
                      : {}),
                  },
                }
              : {}),
          },
          {
            aspect: scene.imageWidth / scene.imageHeight,
            convertToStandard,
            placementPolicy: 'preserve',
            relatedFixtures: scene.fixtures,
          },
        );
        if (!current()) return;
        await onMaterialsChanged();
        if (!current()) return;
        useEditor.getState().changeProject((p) => {
          const comparison = p.shared.comparison;
          if (!comparison) return;
          const index = comparison.before.fixtures.findIndex((f) => f.id === fixture.id);
          if (index >= 0) comparison.before.fixtures[index] = next;
          const candidate = comparison.review?.candidates.find((c) => c.fixtureId === fixture.id);
          if (candidate) {
            Object.assign(
              candidate,
              updateCandidateFromPropertyEdit(candidate, next, propertyChanges, {
                colorChanged: !!colorOverride || propertyChanges.kind,
              }),
            );
          }
        });
      } else if (surface) {
        const version = await createReconstructionTile({
          color,
          kind: surface.kind,
          widthMm: width,
          heightMm: height,
          groutWidth: grout,
        });
        if (!current()) return;
        await onMaterialsChanged();
        if (!current()) return;
        useEditor.getState().change((s) => {
          const target = s.surfaces.find((v) => v.id === surface.id);
          if (target) {
            target.materialVersionId = version.id;
            target.tile.groutWidth = grout;
          }
        });
      }
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : '모형을 갱신하지 못했어요.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="property-section">
      <h4>{surface ? '기존 타일 색과 규격' : '재구성 모형 수정'}</h4>
      <p className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
        사진을 참고해 조정하세요. 실제 상품 규격을 확인한 값은 아니에요.
      </p>
      {original?.kind === 'toilet' && kind === 'toilet' && (
        <p className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
          뚜껑 상태:{' '}
          {form.toiletLidState === undefined
            ? '이전 모형 모습 유지'
            : lidEdited
              ? '사용자 선택 · 적용 전'
              : original.provenance?.toiletLidState === 'inferred'
                ? '검출된 뚜껑·볼 관계로 추정'
                : original.provenance?.toiletLidState === 'user'
                  ? '사용자 선택'
                  : '기본값 · 사진에서 확인되지 않음'}
        </p>
      )}
      {original?.appearanceAssetId && kind === original.kind && (
        <p className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
          이전 버전의 사진 표현을 사용 중이에요. 표준 모형으로 변환하면 원본 반사·풍경 없이 표현돼요.
        </p>
      )}
      {original && !standard && (
        <div className={styles.warning}>
          기존 모습은 그대로 보존돼요. 변환은 이 설비에만 적용되며 실행 취소할 수 있어요.
          <button
            className="btn small"
            style={{ marginTop: 8 }}
            disabled={busy || fixture?.locked}
            onClick={() => void apply(true)}
          >
            표준 모형으로 변환
          </button>
        </div>
      )}
      {original && standard && (
        <label className={styles.control}>
          모형 종류
          <select
            aria-label="재구성 모형 종류"
            value={kind}
            onChange={(e) => chooseKind(e.target.value as ReconstructionKind)}
            disabled={busy || fixture?.locked}
          >
            {Object.entries(reconstructionLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {original && !standard && fixture?.roomPlacement?.face === 'floor' && (
        <label className={styles.control}>
          기구가 놓인 벽 방향
          <select
            aria-label="재구성 설치 방향"
            value={orientation}
            disabled={busy || fixture?.locked}
            onChange={(e) => setOrientation(e.target.value as 'back' | 'left' | 'right')}
          >
            <option value="back">정면 벽</option>
            <option value="left">왼쪽 벽</option>
            <option value="right">오른쪽 벽</option>
          </select>
        </label>
      )}
      {original && standard && (
        <>
          <div className={styles.provenance}>
            {Object.entries(original.provenance ?? {})
              .filter(([, source]) => source !== undefined)
              .map(([field, source]) => (
                <span key={field}>
                  {(
                    {
                      kind: '종류',
                      mounting: '설치',
                      wall: '벽',
                      shape: '형태',
                      showerVariant: '샤워 형태',
                      curtainHardware: '커튼 지지 방식',
                      appearance: '표현',
                      color: '제품 색',
                      pedestalShape: '기둥 단면',
                      dimensions: '규격',
                      width: '가로',
                      height: '높이',
                      depth: '깊이',
                      bowlCount: '세면볼 개수',
                      toiletLidState: '변기 뚜껑',
                      position: '위치',
                    } as Record<string, string>
                  )[field] ?? field}
                  :{' '}
                  {
                    (
                      {
                        model: '모델 관측',
                        inferred: '추정',
                        default: '기본값',
                        user: '사용자 설정',
                      } as const
                    )[source]
                  }
                </span>
              ))}
          </div>
          {fixture && kind === 'glassPartition' && activeForm.support?.kind === 'bath-rim' && (
            <BathRimControls
              scene={scene}
              fixture={fixture}
              support={activeForm.support}
              result={bathResult}
              disabled={busy || !!fixture.locked}
              onChange={(support) => setForm({ ...activeForm, support })}
            />
          )}
          {fixture && kind === 'glassPartition' && activeForm.support?.kind === 'partition-top' && (
            <PartitionTopControls
              scene={scene}
              fixture={fixture}
              support={activeForm.support}
              result={bathResult}
              disabled={busy || !!fixture.locked}
              onChange={(support) =>
                setForm({ ...activeForm, support, ...(support ? {} : { baseHeightMm: 0 }) })
              }
            />
          )}
          <ReconstructionFixtureControls
            dimensions={{ widthMm: width, heightMm: height, depthMm: depth }}
            kind={kind}
            value={activeForm}
            onChange={(next) => {
              if (next.toiletLidState !== form.toiletLidState) setLidEdited(true);
              if (
                (kind === 'vanity' || (kind === 'basin' && next.basinVariant === 'vanity')) &&
                (next.vanityStyle !== form.vanityStyle || next.counterSupport !== form.counterSupport)
              ) {
                const defaults =
                  next.vanityStyle === 'open-counter'
                    ? openCounterDefaults(next.counterSupport ?? 'wall')
                    : reconstructionDefaults(kind, next.basinVariant);
                const face = defaults.face === 'floor' ? 'floor' : form.face === 'floor' ? 'back' : form.face;
                const base = defaults.baseHeightMm ?? 0;
                setHeight(defaults.heightMm);
                setVariantHeightDefault(true);
                setDimensionEdits((previous) => ({ ...previous, height: false }));
                setForm({
                  ...next,
                  face,
                  baseHeightMm: base,
                  v: face === 'floor' ? 0.35 : 1 - base / scene.room!.heightMm,
                });
              } else setForm(next);
            }}
            disabled={busy || !!fixture?.locked}
            onBasinVariant={(variant) => chooseKind('basin', variant)}
            onShowerDefaults={(variant) => {
              const defaults = showerVariantDefaults(variant);
              setWidth(defaults.widthMm);
              setHeight(defaults.heightMm);
              setDepth(defaults.depthMm);
              setDimensionEdits({ width: false, height: false, depth: false });
              setShowerDefaultsApplied(true);
            }}
          />
        </>
      )}
      <fieldset disabled={busy || fixture?.locked} style={{ border: 0, padding: 0, margin: '10px 0' }}>
        <div className={styles.editGrid}>
          <label>
            제품 표면 색
            <input
              aria-label="재구성 대표 색상"
              disabled={
                (!!original?.appearanceAssetId && kind === original.kind) ||
                (!!fixture && PRODUCT_NEUTRAL_OPTICS.includes(kind))
              }
              type="color"
              value={color}
              onChange={(e) => {
                setColor(e.target.value);
                setColorOverride({ mode: 'custom', color: e.target.value });
              }}
            />
          </label>
          {fixture && (
            <div>
              <small>
                {colorOverride
                  ? '사용자 확인색 · 적용 시 저장'
                  : original?.colorEvidence?.requiresReview
                    ? '사진 조명과 고유색을 구분하기 어려워 색 확인이 필요해요.'
                    : '색을 바꾸지 않으면 원래 색상 근거를 유지해요.'}
              </small>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const choice = { mode: 'neutral' } as const;
                  setColor(
                    resolveProductColor(
                      kind,
                      original ? { color: original.color, colorEvidence: original.colorEvidence } : undefined,
                      choice,
                    ).color,
                  );
                  setColorOverride(choice);
                }}
              >
                중립 기본색으로 확인
              </button>
              {colorOverride && kind === original?.kind && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setColor(original.color);
                    setColorOverride(undefined);
                  }}
                >
                  원래 색 유지
                </button>
              )}
            </div>
          )}
          {fixture && kind === 'bath' && (
            <div>
              <label>
                <input
                  type="checkbox"
                  aria-label="욕조 안쪽 색상 별도 설정"
                  checked={bathLiningColor !== undefined}
                  onChange={(e) => {
                    setBathLiningColor(e.target.checked ? '#eeefeb' : undefined);
                    setBathLiningEdited(true);
                  }}
                />
                안쪽·테두리 색상 따로 설정
              </label>
              {bathLiningColor !== undefined && (
                <label>
                  욕조 안쪽·테두리 색상
                  <input
                    type="color"
                    aria-label="욕조 안쪽·테두리 색상"
                    value={bathLiningColor}
                    onChange={(e) => {
                      setBathLiningColor(e.target.value);
                      setBathLiningEdited(true);
                    }}
                  />
                  <small>
                    {bathLiningEdited || original?.provenance?.bathLiningColor === 'user'
                      ? '사용자가 지정한 내부색'
                      : '흰색 계열 기본값 · 사진에서 확인한 색이 아니에요.'}
                  </small>
                </label>
              )}
            </div>
          )}
          <label>
            가로 (mm)
            <input
              aria-label="재구성 가로 (mm)"
              type="number"
              min="1"
              max="20000"
              value={width}
              onChange={(e) => {
                setWidth(+e.target.value);
                setDimensionEdits((previous) => ({ ...previous, width: true }));
              }}
            />
          </label>
          <label>
            {original && kind === 'basin' ? '전체 높이 · 수전 포함 (mm)' : '높이 (mm)'}
            <input
              aria-label="재구성 높이 (mm)"
              type="number"
              min="1"
              max="6000"
              value={height}
              onChange={(e) => {
                setHeight(+e.target.value);
                setDimensionEdits((previous) => ({ ...previous, height: true }));
              }}
            />
          </label>
          {original ? (
            <label>
              깊이 (mm)
              <input
                aria-label="재구성 깊이 (mm)"
                type="number"
                min="0"
                max="20000"
                value={depth}
                onChange={(e) => {
                  setDepth(+e.target.value);
                  setDimensionEdits((previous) => ({ ...previous, depth: true }));
                }}
              />
            </label>
          ) : (
            <label>
              줄눈 (mm)
              <input
                aria-label="재구성 줄눈 (mm)"
                type="number"
                min="0"
                max="15"
                step=".5"
                value={grout}
                onChange={(e) => setGrout(+e.target.value)}
              />
            </label>
          )}
        </div>
        <button
          className="btn small"
          style={{ marginTop: 10, width: '100%' }}
          disabled={busy}
          onClick={() => void apply()}
        >
          {busy ? '모형 준비 중…' : '재구성 설정 적용'}
        </button>
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {original && (
        <p className="muted" style={{ fontSize: 11 }}>
          등록한 제품으로 바꾸려면 이 모형을 선택한 상태에서 왼쪽 자재 목록의 제품을 누르세요.
        </p>
      )}
    </section>
  );
}
