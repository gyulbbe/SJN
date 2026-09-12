'use client';

import { useState, useRef, useEffect, type ChangeEvent, type FormEvent } from 'react';
import { getRepositories } from '@/lib/repositories';
import { importImage, makeAsset } from '@/lib/images';
import type { BackgroundRemovalResult } from '@/lib/background-removal/types';
import type { Product3dApplication } from '@/lib/product3d/types';
import {
  prepareProductReplacement,
  replaceProductPhoto,
  addProductPhoto,
  renameProductPhoto,
  removeProductPhoto,
  productViewName,
  MAX_PRODUCT_VIEWS,
} from '@/lib/product3d/apply';
import { defaultMaterialPricing, QUOTE_UNIT_LABELS } from '@/lib/quote';
import { packagingCoverage } from '@/lib/material-usage';
import type { MaterialPricing, QuoteUnit } from '@/lib/quote-types';
import {
  categoryLabels,
  type MaterialCategory,
  type MaterialInput,
  type MaterialVersion,
  type Point,
} from '@/lib/types';
import { AssetImage, useAsset } from './asset-image';
import { ImagePreparer } from './image-preparer';
import { BackgroundRemovalTest } from './background-removal-test';
import { Product3dEditor } from './product3d-editor';
import { AngleNameInput } from './angle-name-input';
import { useAccess } from '@/components/app-provider';
import { useSharedCatalogAdmin } from './shared-access';
import styles from './materials.module.css';

const defaults: MaterialInput = {
  name: '',
  brand: '',
  code: '',
  category: 'tile',
  scope: 'personal',
  description: '',
  color: '',
  finish: '',
  widthMm: 600,
  heightMm: 600,
  depthMm: 9,
  usage: 'both',
  installation: 'floor',
  textureAssetIds: [],
  views: [],
  defaultGroutWidth: 2,
  defaultGroutColor: '#d5d1c9',
  defaultPattern: 'grid',
};

function AnchorPicker({
  assetId,
  anchor,
  onChange,
}: {
  assetId: string;
  anchor: Point;
  onChange: (point: Point) => void;
}) {
  const { asset } = useAsset(assetId);
  return (
    <div>
      <button
        type="button"
        className={`${styles.anchorPicker} ${styles.checkerboard}`}
        style={{ aspectRatio: asset ? `${asset.width}/${asset.height}` : '1' }}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onChange({
            x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
          });
        }}
        aria-label="제품 사진을 눌러 바닥 접점 또는 벽 부착점을 지정"
      >
        <AssetImage assetId={assetId} alt="배치 기준점을 지정할 제품 이미지" />
        <span
          className={styles.anchorDot}
          style={{ left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%` }}
          aria-hidden="true"
        >
          +
        </span>
      </button>
      <div className={styles.anchorValues}>
        <label>
          기준점 X{' '}
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={Math.round(anchor.x * 100)}
            onChange={(event) =>
              onChange({ ...anchor, x: Math.max(0, Math.min(1, Number(event.target.value) / 100)) })
            }
          />
          %
        </label>
        <label>
          Y{' '}
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={Math.round(anchor.y * 100)}
            onChange={(event) =>
              onChange({ ...anchor, y: Math.max(0, Math.min(1, Number(event.target.value) / 100)) })
            }
          />
          %
        </label>
      </div>
    </div>
  );
}

export function MaterialForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: MaterialVersion;
  onSaved: (version: MaterialVersion) => void;
  onCancel: () => void;
}) {
  const { writable, mode } = useAccess();
  const isAdmin = useSharedCatalogAdmin();
  const [form, setForm] = useState<MaterialInput>(() =>
    initial
      ? {
          ...initial,
          pricing: { ...(initial.pricing ?? defaultMaterialPricing(initial.category)) },
          textureAssetIds: [...initial.textureAssetIds],
          views: structuredClone(initial.views),
        }
      : {
          ...defaults,
          pricing: defaultMaterialPricing('tile'),
          textureAssetIds: [],
          views: [],
        },
  );
  const [packagingAcknowledged, setPackagingAcknowledged] = useState('');
  const pricing = form.pricing ?? defaultMaterialPricing(form.category);
  const packaging = packagingCoverage(form.widthMm, form.heightMm, pricing);
  const packagingSignature = JSON.stringify([
    form.widthMm,
    form.heightMm,
    pricing.boxCoverageM2,
    pricing.piecesPerBox,
  ]);
  const supportedUnit =
    form.category === 'tile' ? ['m2', 'box', 'piece'].includes(pricing.unit) : pricing.unit === 'piece';
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState<{ assetId: string; index: number }>();
  const [backgroundTest, setBackgroundTest] = useState<{
    assetId: string;
    direction: string;
    index: number;
    targetAssetId?: string;
  }>();
  const [productEditor, setProductEditor] = useState<{
    assetId: string;
    direction: string;
    index: number;
    blob?: Blob;
    inputSourceAssetId?: string;
  }>();
  const set = <K extends keyof MaterialInput>(key: K, value: MaterialInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const setPricing = <K extends keyof MaterialPricing>(key: K, value: MaterialPricing[K]) =>
    setForm((current) => ({
      ...current,
      pricing: { ...(current.pricing ?? defaultMaterialPricing(current.category)), [key]: value },
    }));
  const setCategory = (category: MaterialCategory) =>
    setForm((current) => {
      const currentPricing = current.pricing ?? defaultMaterialPricing(current.category);
      const supported =
        category === 'tile'
          ? ['m2', 'box', 'piece'].includes(currentPricing.unit)
          : currentPricing.unit === 'piece';
      return {
        ...current,
        category,
        pricing:
          !supported && currentPricing.unitPrice === null
            ? { ...currentPricing, unit: defaultMaterialPricing(category).unit }
            : currentPricing,
      };
    });
  const choosePricingUnit = (unit: QuoteUnit) => {
    if (unit === pricing.unit) return;
    if (
      pricing.unitPrice !== null &&
      !window.confirm('판매 단위가 바뀌면 기존 단가를 비우고 새 단위의 가격을 입력해야 해요. 변경할까요?')
    )
      return;
    setForm((current) => ({
      ...current,
      pricing: { ...(current.pricing ?? defaultMaterialPricing(current.category)), unit, unitPrice: null },
    }));
  };
  const setView = (index: number, value: Partial<MaterialInput['views'][number]>) =>
    setForm((current) => ({
      ...current,
      views: current.views.map((view, i) => (i === index ? { ...view, ...value } : view)),
    }));

  const upload = async (event: ChangeEvent<HTMLInputElement>, target: 'texture' | 'view') => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length || !writable) return;
    setUploading(true);
    setError('');
    try {
      for (const file of files) {
        const { preview } = await importImage(
          file,
          target === 'texture' ? 'texture' : 'product',
          getRepositories().assets,
        );
        setForm((current) => {
          if (target === 'texture')
            return { ...current, textureAssetIds: [...current.textureAssetIds, preview.id] };
          return {
            ...current,
            views: [
              ...current.views,
              {
                assetId: preview.id,
                direction: current.views.length === 0 ? '정면' : '사선',
                anchor: { x: 0.5, y: current.installation === 'wall' ? 0.5 : 0.97 },
              },
            ],
          };
        });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '이미지를 등록하지 못했어요.');
    } finally {
      setUploading(false);
    }
  };

  const applyBackgroundResult = async (result: BackgroundRemovalResult) => {
    if (!writable || (form.scope === 'shared' && !isAdmin))
      throw new Error('이 자재의 편집 권한이 없어요. 편집 가능한 탭에서 다시 시도해 주세요.');
    if (
      !backgroundTest ||
      form.views[backgroundTest.index]?.assetId !== (backgroundTest.targetAssetId ?? backgroundTest.assetId)
    )
      throw new Error('선택한 제품 사진이 바뀌었어요. 결과 창을 닫고 다시 선택해 주세요.');
    const { assetId, index } = backgroundTest;
    const assets = getRepositories().assets;
    const selected = await assets.get(assetId);
    const asset = await makeAsset(result.blob, `${selected.name} · AI 배경 제거.png`, 'product', assetId);
    asset.derivation = 'ai-alpha';
    // Save new PNG bytes before changing the draft; existing assets and material versions stay intact.
    await assets.put(asset);
    setView(index, { assetId: asset.id, product3d: undefined });
  };

  const currentEdit = useRef({ form, productEditor, writable, isAdmin });
  currentEdit.current = { form, productEditor, writable, isAdmin };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const applyProductResult = async (result: Product3dApplication, mode: 'add' | 'replace', name: string) => {
    const direction = productViewName(name);
    const target = productEditor;
    const assertCurrent = () => {
      const current = currentEdit.current;
      if (!alive.current || !current.writable || (current.form.scope === 'shared' && !current.isAdmin))
        throw new Error('현재 이 자재를 저장할 수 없어요. 편집 권한을 확인해 주세요.');
      if (
        !target ||
        current.productEditor?.assetId !== target.assetId ||
        current.productEditor.index !== target.index ||
        current.form.views[target.index]?.assetId !== target.assetId
      )
        throw new Error('선택한 제품 사진이 바뀌었어요. 결과 창을 다시 열어 주세요.');
    };
    assertCurrent();
    if (mode === 'add' && currentEdit.current.form.views.length >= MAX_PRODUCT_VIEWS)
      throw new Error(`자재 하나에 각도 사진은 최대 ${MAX_PRODUCT_VIEWS}장까지 저장할 수 있어요.`);
    const replacement = await prepareProductReplacement(
      result,
      getRepositories().assets,
      form.installation,
      assertCurrent,
    );
    assertCurrent();
    const current = currentEdit.current.form;
    const next =
      mode === 'add'
        ? addProductPhoto(current, target!.index, target!.assetId, replacement, direction)
        : renameProductPhoto(
            replaceProductPhoto(current, target!.index, target!.assetId, replacement),
            target!.index,
            direction,
          );
    const index = mode === 'add' ? next.views.length - 1 : target!.index;
    const view = next.views[index];
    const editor = { index, assetId: view.assetId, direction: view.direction };
    // Update both refs immediately so a following interaction sees the committed form draft.
    currentEdit.current = { ...currentEdit.current, form: next, productEditor: editor };
    setForm(next);
    setProductEditor(editor);
  };

  const editAngle = (action: 'select' | 'rename' | 'delete', index: number, name = '') => {
    const current = currentEdit.current;
    if (
      !alive.current ||
      (action !== 'select' && (!current.writable || (current.form.scope === 'shared' && !current.isAdmin)))
    )
      throw new Error('이 자재의 편집 권한이 없어요.');
    if (!current.form.views[index]) throw new Error('선택한 각도 사진을 찾을 수 없어요.');
    let next = current.form;
    let selectedIndex = current.productEditor?.index;
    if (action === 'rename') next = renameProductPhoto(next, index, name);
    if (action === 'delete') {
      next = removeProductPhoto(next, index);
      if (selectedIndex !== undefined) {
        if (selectedIndex === index) selectedIndex = Math.min(index, next.views.length - 1);
        else if (selectedIndex > index) selectedIndex--;
      }
    }
    if (action === 'select') selectedIndex = index;
    const selected = selectedIndex !== undefined ? next.views[selectedIndex] : undefined;
    const editor =
      selected && selectedIndex !== undefined
        ? { index: selectedIndex, assetId: selected.assetId, direction: selected.direction }
        : undefined;
    currentEdit.current = { ...current, form: next, productEditor: editor };
    setForm(next);
    setProductEditor(editor);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    if (!writable) {
      setError('이 탭은 읽기 전용이에요. 편집권을 가진 탭에서 저장해 주세요.');
      return;
    }
    if (form.scope === 'shared' && !isAdmin) {
      setError('공용 자재 편집에는 서버에서 확인한 관리자 권한이 필요해요.');
      return;
    }
    if (!form.name.trim()) {
      setError('상품명을 입력해 주세요.');
      return;
    }
    if (
      ![form.widthMm, form.heightMm, form.depthMm].every(
        (value) => Number.isFinite(value) && value > 0 && value <= 50000,
      )
    ) {
      setError('가로·세로·깊이를 0보다 크고 50,000mm 이하인 값으로 입력해 주세요.');
      return;
    }
    if (form.category === 'tile' && !form.textureAssetIds.length) {
      setError('타일 한 장의 정면 텍스처를 한 장 이상 등록해 주세요.');
      return;
    }
    if (form.category !== 'tile' && !form.views.length) {
      setError('제품 이미지를 한 장 이상 등록해 주세요.');
      return;
    }
    if (
      pricing.unitPrice !== null &&
      (!Number.isInteger(pricing.unitPrice) || pricing.unitPrice < 0 || pricing.unitPrice > 100_000_000)
    ) {
      setError('기준 단가는 0원 이상 100,000,000원 이하의 정수로 입력하거나 비워 주세요.');
      return;
    }
    if (
      pricing.boxCoverageM2 !== null &&
      (!Number.isFinite(pricing.boxCoverageM2) ||
        pricing.boxCoverageM2 <= 0 ||
        pricing.boxCoverageM2 > 100_000)
    ) {
      setError('박스당 면적은 0보다 크고 100,000㎡ 이하인 값으로 입력하거나 비워 주세요.');
      return;
    }
    if (
      pricing.piecesPerBox !== null &&
      (!Number.isInteger(pricing.piecesPerBox) || pricing.piecesPerBox < 1 || pricing.piecesPerBox > 100_000)
    ) {
      setError('박스당 수량은 1개 이상 100,000개 이하의 정수로 입력하거나 비워 주세요.');
      return;
    }
    if (!supportedUnit) {
      setError(
        '이전 판매 단위를 확인해 주세요. 타일은 박스·장·㎡, 제품은 개 단위로 등록할 수 있어요. 단위를 선택한 뒤 가격을 다시 입력해 주세요.',
      );
      return;
    }
    if (
      form.category === 'tile' &&
      pricing.unit === 'box' &&
      packaging.mismatch &&
      packagingAcknowledged !== packagingSignature
    ) {
      setError('박스당 면적과 규격으로 계산한 면적이 달라요. 사용할 등록 면적을 확인해 주세요.');
      return;
    }
    setBusy(true);
    try {
      const input: MaterialInput = {
        ...form,
        pricing: { ...pricing },
        name: form.name.trim(),
        brand: form.brand.trim(),
        code: form.code.trim(),
        textureAssetIds: form.category === 'tile' ? form.textureAssetIds : [],
        views:
          form.category === 'tile'
            ? []
            : form.views.map((view) => ({ ...view, direction: productViewName(view.direction) })),
      };
      const repository = getRepositories().materials;
      const result = initial
        ? await repository.update(initial.materialId, input, initial.id)
        : await repository.create(input);
      onSaved(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '자재를 저장하지 못했어요.');
    } finally {
      setBusy(false);
    }
  };

  const uploadInput = (target: 'texture' | 'view', label: string) => (
    <label className={styles.uploadButton}>
      {label}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        onChange={(event) => upload(event, target)}
        disabled={uploading || busy}
        aria-label={label}
      />
    </label>
  );

  return (
    <>
      <form className={styles.materialForm} onSubmit={submit}>
        <div className={styles.formHeader}>
          <div>
            <span className={styles.eyebrow}>MATERIAL LIBRARY</span>
            <h2>{initial ? '자재 수정' : '내 자재 등록'}</h2>
            <p className="muted">
              {initial
                ? `현재 v${initial.version} · 변경 내용은 새 버전으로 저장돼요. 기존 프로젝트는 그대로 유지돼요.`
                : '제품 정보와 렌더링 이미지를 준비하면 편집기에서 바로 사용할 수 있어요.'}
            </p>
          </div>
          <button type="button" className="btn" onClick={onCancel} disabled={busy || uploading}>
            닫기
          </button>
        </div>
        <fieldset disabled={busy || uploading || !writable} className={styles.fieldset}>
          <section className={styles.formSection}>
            <div className={styles.sectionHeading}>
              <span>01</span>
              <div>
                <h3>기본 정보</h3>
                <p>상품의 이름과 실제 규격을 기록해요.</p>
              </div>
            </div>
            <div className={styles.fields}>
              <label className="field">
                상품명 *
                <input
                  className="input"
                  placeholder="예: 라이트 샌드 포세린 600"
                  required
                  maxLength={100}
                  value={form.name}
                  onChange={(event) => set('name', event.target.value)}
                />
              </label>
              <label className="field">
                카테고리
                <select
                  aria-label="카테고리"
                  className="input"
                  value={form.category}
                  onChange={(event) => setCategory(event.target.value as MaterialCategory)}
                >
                  {Object.entries(categoryLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                브랜드
                <input
                  className="input"
                  placeholder="브랜드명"
                  maxLength={100}
                  value={form.brand}
                  onChange={(event) => set('brand', event.target.value)}
                />
              </label>
              <label className="field">
                모델명 · 상품 코드
                <input
                  className="input"
                  placeholder="상품 코드"
                  maxLength={100}
                  value={form.code}
                  onChange={(event) => set('code', event.target.value)}
                />
              </label>
              <label className="field">
                색상
                <input
                  className="input"
                  placeholder="예: 웜 그레이"
                  maxLength={100}
                  value={form.color}
                  onChange={(event) => set('color', event.target.value)}
                />
              </label>
              <label className="field">
                재질 · 마감
                <input
                  className="input"
                  placeholder="예: 포세린 · 무광"
                  maxLength={100}
                  value={form.finish}
                  onChange={(event) => set('finish', event.target.value)}
                />
              </label>
            </div>
            {mode === 'supabase' && isAdmin && (
              <label className="field" style={{ marginBottom: 17 }}>
                목록 범위
                <select
                  aria-label="목록 범위"
                  className="input"
                  disabled={!!initial}
                  value={form.scope}
                  onChange={(event) => set('scope', event.target.value as MaterialInput['scope'])}
                >
                  <option value="personal">내 자재</option>
                  <option value="shared">관리자 공용 자재</option>
                </select>
                <small>
                  공용 자재는 모든 로그인 사용자가 볼 수 있어요. 저장 시 서버에서 권한을 다시 확인해요.
                </small>
              </label>
            )}
            <div className={styles.dimensions}>
              <label className="field">
                가로 (mm)
                <input
                  className="input"
                  type="number"
                  min=".1"
                  max="50000"
                  step=".1"
                  required
                  value={form.widthMm}
                  onChange={(event) => set('widthMm', Number(event.target.value))}
                />
              </label>
              <label className="field">
                {form.category === 'tile' ? '세로' : '높이'} (mm)
                <input
                  className="input"
                  type="number"
                  min=".1"
                  max="50000"
                  step=".1"
                  required
                  value={form.heightMm}
                  onChange={(event) => set('heightMm', Number(event.target.value))}
                />
              </label>
              <label className="field">
                {form.category === 'tile' ? '두께' : '깊이'} (mm)
                <input
                  className="input"
                  type="number"
                  min=".1"
                  max="50000"
                  step=".1"
                  required
                  value={form.depthMm}
                  onChange={(event) => set('depthMm', Number(event.target.value))}
                />
              </label>
            </div>
            <label className="field">
              설명
              <textarea
                className="input"
                rows={3}
                placeholder="제품 특징이나 시공 시 참고할 내용을 적어 주세요."
                maxLength={2000}
                value={form.description}
                onChange={(event) => set('description', event.target.value)}
              />
            </label>
          </section>

          <section className={styles.formSection}>
            <div className={styles.sectionHeading}>
              <span>02</span>
              <div>
                <h3>{form.category === 'tile' ? '타일 텍스처 준비' : '제품 이미지'}</h3>
                <p>
                  {form.category === 'tile'
                    ? '타일 한 장의 정면 사진을 등록하세요. 여러 장이 찍혔다면 모서리 네 점으로 한 장만 선택할 수 있어요.'
                    : '정면 사진이 있으면 먼저 보여주고, 없으면 첫 사진을 보여줘요. 배경은 AI 배경 제거로 지울 수 있어요.'}
                </p>
              </div>
            </div>
            {form.category === 'tile' ? (
              <>
                <div className={styles.fields}>
                  <label className="field">
                    사용 면
                    <select
                      aria-label="사용 면"
                      className="input"
                      value={form.usage}
                      onChange={(event) => set('usage', event.target.value as MaterialInput['usage'])}
                    >
                      <option value="both">벽·바닥 공용</option>
                      <option value="wall">벽용</option>
                      <option value="floor">바닥용</option>
                    </select>
                  </label>
                  <label className="field">
                    기본 시공 패턴
                    <select
                      aria-label="기본 시공 패턴"
                      className="input"
                      value={form.defaultPattern}
                      onChange={(event) =>
                        set('defaultPattern', event.target.value as MaterialInput['defaultPattern'])
                      }
                    >
                      <option value="grid">기본 격자</option>
                      <option value="brick">1/2 엇갈림</option>
                    </select>
                  </label>
                  <label className="field">
                    기본 줄눈 폭 (mm)
                    <input
                      className="input"
                      type="number"
                      min="0"
                      max="30"
                      step=".5"
                      value={form.defaultGroutWidth}
                      onChange={(event) => set('defaultGroutWidth', Number(event.target.value))}
                    />
                  </label>
                  <label className="field">
                    기본 줄눈 색상
                    <div className={styles.colorField}>
                      <input
                        type="color"
                        value={form.defaultGroutColor}
                        onChange={(event) => set('defaultGroutColor', event.target.value)}
                        aria-label="기본 줄눈 색상"
                      />
                      <span>{form.defaultGroutColor}</span>
                    </div>
                  </label>
                </div>
                <div className={styles.toolbar}>
                  {uploadInput('texture', '+ 타일 텍스처 올리기')}
                  <span className="muted">무늬가 다른 여러 장을 등록하면 반복할 때 섞어서 사용해요.</span>
                </div>
                <div className={styles.textureGrid}>
                  {form.textureAssetIds.map((id, index) => (
                    <div key={`${id}-${index}`} className={styles.textureCard}>
                      <AssetImage assetId={id} alt={`타일 텍스처 ${index + 1}`} />
                      <div className={styles.textureBody}>
                        <strong>텍스처 {index + 1}</strong>
                        <span className="muted">
                          {form.widthMm} × {form.heightMm} mm
                        </span>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setPreparing({ assetId: id, index })}
                        >
                          한 장 선택·정면 보정
                        </button>
                        <div className={styles.toolbar}>
                          <button
                            type="button"
                            className={styles.textButton}
                            onClick={() =>
                              set(
                                'textureAssetIds',
                                form.textureAssetIds.filter((_, i) => i !== index),
                              )
                            }
                          >
                            제외
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {!form.textureAssetIds.length && (
                  <div className={styles.emptyAsset}>
                    아직 타일 텍스처가 없어요.
                    <br />
                    <span>타일 무늬가 잘 보이는 사진을 올려 주세요.</span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className={styles.fields}>
                  <label className="field">
                    설치 방식
                    <select
                      aria-label="설치 방식"
                      className="input"
                      value={form.installation}
                      onChange={(event) =>
                        set('installation', event.target.value as MaterialInput['installation'])
                      }
                    >
                      <option value="floor">바닥형</option>
                      <option value="wall">벽걸이형</option>
                      <option value="embedded">매립형</option>
                    </select>
                  </label>
                  <div className={styles.note}>
                    2D 이미지 배치 · 이미지 평면 회전을 지원해요.
                    <br />
                    360° 편집기에서 여러 각도 사진을 저장해 공간에서 골라 쓸 수 있어요.
                  </div>
                </div>
                <div className={styles.toolbar}>
                  {uploadInput('view', '+ 제품 이미지 올리기')}
                  <span className="muted">정면·측면·사선 사진을 각각 등록할 수 있어요.</span>
                </div>
                <div className={styles.viewGrid}>
                  {form.views.map((view, index) => (
                    <div key={`${view.assetId}-${index}`} className={styles.viewCard}>
                      <AnchorPicker
                        assetId={view.assetId}
                        anchor={view.anchor}
                        onChange={(anchor) => setView(index, { anchor })}
                      />
                      <AngleNameInput
                        label={`촬영 방향 ${index + 1}`}
                        value={view.direction}
                        onChange={(direction) => setView(index, { direction })}
                        disabled={busy || uploading}
                      />
                      <p className={styles.note}>
                        사진에서 {form.installation === 'wall' ? '벽 부착점' : '바닥 접점'}을 눌러 + 기준점을
                        맞추세요.
                      </p>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy || uploading || !!backgroundTest || !!productEditor}
                        aria-label={`${view.direction} 사진 AI 배경 제거 테스트`}
                        onClick={() =>
                          setBackgroundTest({ assetId: view.assetId, direction: view.direction, index })
                        }
                      >
                        AI 배경 제거 테스트
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy || uploading || !!backgroundTest || !!productEditor}
                        aria-label={`${view.direction} 사진 ${view.product3d ? '360° 각도 편집' : 'AI 360° 입체화'}`}
                        onClick={() =>
                          setProductEditor({ assetId: view.assetId, direction: view.direction, index })
                        }
                      >
                        {view.product3d ? '360° 각도 편집' : 'AI 360° 입체화'}
                      </button>
                      <div className={styles.toolbar}>
                        <button
                          type="button"
                          className={styles.textButton}
                          onClick={() => {
                            if (
                              window.confirm(
                                `‘${view.direction || '이 각도'}’ 사진을 삭제할까요? 다른 각도는 유지돼요.`,
                              )
                            )
                              editAngle('delete', index);
                          }}
                        >
                          제외
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                {!form.views.length && (
                  <div className={styles.emptyAsset}>
                    아직 배치용 제품 이미지가 없어요.
                    <br />
                    <span>제품 사진을 올린 뒤 AI 배경 제거 테스트로 배경을 지울 수 있어요.</span>
                  </div>
                )}
              </>
            )}
          </section>
          <section className={styles.formSection}>
            <div className={styles.sectionHeading}>
              <span>03</span>
              <div>
                <h3>단가와 포장 정보</h3>
                <p>
                  시안에 자재를 적용할 때 가져오는 기준값이에요. 시안의 사용 내역에서 따로 수정할 수 있어요.
                </p>
              </div>
            </div>
            <div className={styles.fields}>
              <label className="field">
                판매 단위
                <select
                  className="input"
                  aria-label="판매 단위"
                  value={pricing.unit}
                  onChange={(event) => choosePricingUnit(event.target.value as QuoteUnit)}
                >
                  {!supportedUnit && (
                    <option value={pricing.unit}>
                      {QUOTE_UNIT_LABELS[pricing.unit]} · 이전 단위 확인 필요
                    </option>
                  )}
                  {(form.category === 'tile' ? (['box', 'piece', 'm2'] as const) : (['piece'] as const)).map(
                    (unit) => (
                      <option key={unit} value={unit}>
                        {unit === 'piece'
                          ? form.category === 'tile'
                            ? '장'
                            : '개'
                          : QUOTE_UNIT_LABELS[unit]}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="field">
                기준 단가 (원 /{' '}
                {pricing.unit === 'piece' && form.category === 'tile'
                  ? '장'
                  : QUOTE_UNIT_LABELS[pricing.unit]}
                )
                <input
                  className="input"
                  aria-label="기준 단가"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="100000000"
                  step="1"
                  placeholder="미등록"
                  value={pricing.unitPrice ?? ''}
                  onChange={(event) =>
                    setPricing('unitPrice', event.target.value === '' ? null : Number(event.target.value))
                  }
                />
              </label>
              {pricing.unit === 'box' && form.category === 'tile' && (
                <>
                  <label className="field">
                    박스당 면적 (㎡)
                    <input
                      className="input"
                      type="number"
                      inputMode="decimal"
                      min="0.000001"
                      max="100000"
                      step="any"
                      placeholder="예: 1.44"
                      value={pricing.boxCoverageM2 ?? ''}
                      onChange={(event) =>
                        setPricing(
                          'boxCoverageM2',
                          event.target.value === '' ? null : Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label className="field">
                    박스당 수량 (장)
                    <input
                      className="input"
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max="100000"
                      step="1"
                      placeholder="예: 4"
                      value={pricing.piecesPerBox ?? ''}
                      onChange={(event) =>
                        setPricing(
                          'piecesPerBox',
                          event.target.value === '' ? null : Number(event.target.value),
                        )
                      }
                    />
                  </label>
                </>
              )}
            </div>
            {!supportedUnit && (
              <p role="alert" className={styles.error}>
                이전 자재의 판매 단위예요. 단위를 확인하고 해당 단가를 다시 입력해 주세요. 기존 가격을 자동
                환산하지 않아요.
              </p>
            )}
            <p className={styles.pricingNote}>
              단가를 비우면 미입력으로 표시하고, 0원을 입력하면 0원으로 계산해요.
              {pricing.unit === 'box' && form.category === 'tile' && (
                <>
                  <br />
                  박스당 면적이 비어 있으면 타일 규격과 박스당 수량으로 계산해요.
                </>
              )}
            </p>
            {pricing.unit === 'box' &&
              form.category === 'tile' &&
              packaging.calculatedCoverageM2 !== null && (
                <p className={styles.pricingNote}>
                  규격 × 박스당 수량:{' '}
                  {packaging.calculatedCoverageM2.toLocaleString('ko-KR', { maximumFractionDigits: 6 })}㎡
                </p>
              )}
            {pricing.unit === 'box' && form.category === 'tile' && packaging.mismatch && (
              <div className={styles.note}>
                <p>
                  등록한 박스 면적 {pricing.boxCoverageM2}㎡와 규격으로 계산한{' '}
                  {packaging.calculatedCoverageM2}㎡가 달라요.
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={packagingAcknowledged === packagingSignature}
                    onChange={(event) =>
                      setPackagingAcknowledged(event.target.checked ? packagingSignature : '')
                    }
                  />{' '}
                  등록한 박스당 면적을 기준으로 사용할 것을 확인했어요.
                </label>
              </div>
            )}
          </section>
        </fieldset>
        {uploading && (
          <p role="status" className={styles.note}>
            이미지를 검사하고 원본과 편집용 이미지를 저장하고 있어요…
          </p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <footer className={styles.formFooter}>
          <span className="muted">
            {initial
              ? '새 버전은 이후에 적용하는 자재부터 사용돼요.'
              : form.scope === 'shared'
                ? '등록한 자재는 로그인 사용자에게 공개돼요.'
                : '등록한 자재는 내 자재 목록에 저장돼요.'}
          </span>
          <div className={styles.toolbar}>
            <button type="button" className="btn" disabled={busy || uploading} onClick={onCancel}>
              취소
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={busy || uploading || !writable || (form.scope === 'shared' && !isAdmin)}
            >
              {busy ? '저장 중…' : initial ? '새 버전 저장' : '자재 등록'}
            </button>
          </div>
        </footer>
      </form>
      {backgroundTest && (
        <BackgroundRemovalTest
          {...backgroundTest}
          onApply={applyBackgroundResult}
          onCreateProduct3d={(result) => {
            setProductEditor({
              ...backgroundTest,
              assetId: backgroundTest.targetAssetId ?? backgroundTest.assetId,
              inputSourceAssetId: backgroundTest.assetId,
              blob: result.blob,
            });
            setBackgroundTest(undefined);
          }}
          canApply={writable && (form.scope !== 'shared' || isAdmin)}
          onClose={() => setBackgroundTest(undefined)}
        />
      )}
      {productEditor && (
        <Product3dEditor
          {...productEditor}
          product3d={productEditor.blob ? undefined : form.views[productEditor.index]?.product3d}
          views={form.views}
          selectedViewIndex={productEditor.index}
          onSelectView={(index) => editAngle('select', index)}
          onRenameView={(index, name) => editAngle('rename', index, name)}
          onDeleteView={(index) => editAngle('delete', index)}
          onApply={applyProductResult}
          onRemoveBackground={(sourceId) => {
            setBackgroundTest({
              index: productEditor.index,
              assetId: sourceId,
              targetAssetId: productEditor.assetId,
              direction: productEditor.direction,
            });
            setProductEditor(undefined);
          }}
          canApply={writable && (form.scope !== 'shared' || isAdmin)}
          onClose={() => setProductEditor(undefined)}
        />
      )}
      {preparing && (
        <ImagePreparer
          {...preparing}
          widthMm={form.widthMm}
          heightMm={form.heightMm}
          onSaved={(id) => {
            set(
              'textureAssetIds',
              form.textureAssetIds.map((value, index) => (index === preparing.index ? id : value)),
            );
            setPreparing(undefined);
          }}
          onCancel={() => setPreparing(undefined)}
        />
      )}
    </>
  );
}
