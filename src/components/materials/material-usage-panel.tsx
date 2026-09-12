'use client';
import { getMaterialImageAssetId } from '@/lib/material-images';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, RotateCcw, X } from 'lucide-react';
import type { AssetRecord, DesignDocument, Material, MaterialVersion } from '@/lib/types';
import type {
  MaterialUsageRow,
  MaterialUsageState,
  UsagePriceSnapshot,
  UsageUnit,
} from '@/lib/material-usage-types';
import {
  applyLatestUsagePricing,
  calculateMaterialUsage,
  describeLatestUsagePricing,
  MAX_USAGE_QUANTITY,
  MAX_USAGE_UNIT_PRICE,
  packagingCoverage,
  setUsageArea,
  setUsagePricing,
  setUsageQuantity,
} from '@/lib/material-usage';
import './material-usage-panel.css';

const pendingInputs = new Set<() => boolean>();
/** Flush before switching/copying a design; invalid inputs retain focus and block the action. */
export function flushMaterialUsageInputs(): boolean {
  let valid = true;
  pendingInputs.forEach((flush) => {
    if (!flush()) valid = false;
  });
  return valid;
}
const number = (value: number | null, digits = 4) =>
  value === null ? '미확인' : value.toLocaleString('ko-KR', { maximumFractionDigits: digits });
const money = (value: number | null) => (value === null ? '계산 전' : `${number(value, 0)}원`);
const unitLabel = (unit: UsageUnit, category: MaterialUsageRow['category']) =>
  unit === 'm2' ? '㎡' : unit === 'box' ? '박스' : category === 'tile' ? '장' : '개';

function NumericInput({
  label,
  displayLabel,
  commitUnchanged = false,
  value,
  onCommit,
  writable,
  max = MAX_USAGE_QUANTITY,
  integer = false,
  positive = false,
  placeholder = '미입력',
}: {
  label: string;
  displayLabel?: string;
  commitUnchanged?: boolean;
  value: number | null;
  onCommit: (value: number | null) => void;
  writable: boolean;
  max?: number;
  integer?: boolean;
  positive?: boolean;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState(value === null ? '' : String(value));
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const committed = useRef(value);
  const edited = useRef(false);
  useEffect(() => {
    committed.current = value;
    edited.current = false;
    setRaw(value === null ? '' : String(value));
    setError('');
  }, [value]);
  const current = useRef<() => boolean>(() => true);
  current.current = () => {
    if (!writable) return true;
    const next = raw.trim() === '' ? null : Number(raw);
    if (
      next !== null &&
      (!Number.isFinite(next) ||
        next < 0 ||
        (positive && next === 0) ||
        next > max ||
        (integer && !Number.isInteger(next)))
    ) {
      setError(
        `${positive ? '0보다 큰' : '0 이상의'} ${number(max, 0)} 이하 ${integer ? '정수' : '숫자'}를 입력하세요.`,
      );
      input.current?.focus();
      return false;
    }
    setError('');
    if (next !== committed.current || (edited.current && commitUnchanged)) {
      committed.current = next;
      edited.current = false;
      onCommit(next);
    }
    return true;
  };
  useEffect(() => {
    const flush = () => current.current();
    pendingInputs.add(flush);
    return () => {
      pendingInputs.delete(flush);
    };
  }, []);
  return (
    <label className="mu-field">
      <span>{displayLabel ?? label}</span>
      <input
        ref={input}
        data-usage-input
        aria-label={label}
        aria-invalid={!!error}
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        value={raw}
        placeholder={placeholder}
        readOnly={!writable}
        onInput={() => {
          edited.current = true;
        }}
        onChange={(event) => {
          edited.current = true;
          setRaw(event.target.value);
          setError('');
        }}
        onBlur={() => current.current()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (current.current()) event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            setRaw(value === null ? '' : String(value));
            committed.current = value;
            edited.current = false;
            setError('');
            event.stopPropagation();
          }
        }}
      />
      {error && (
        <small role="alert" className="mu-error">
          {error}
        </small>
      )}
    </label>
  );
}

function UsageImage({
  assetId,
  reader,
  name,
}: {
  assetId?: string;
  reader: MaterialUsagePanelProps['assetReader'];
  name: string;
}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let alive = true,
      objectUrl = '';
    setUrl('');
    if (assetId)
      void reader(assetId)
        .then((asset) => {
          if (!alive) return;
          objectUrl = URL.createObjectURL(asset.blob);
          setUrl(objectUrl);
        })
        .catch(() => {});
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, reader]);
  // Asset URLs are local Blobs; they cannot use remote image optimization.
  return url ? (
    <img className="mu-image" src={url} alt={name} draggable={false} />
  ) : (
    <span className="mu-image mu-image-empty" role="img" aria-label={name}>
      이미지
    </span>
  );
}

export type MaterialUsagePanelProps = {
  design: DesignDocument;
  materials: Record<string, MaterialVersion>;
  currentCatalog?: { material: Material; version: MaterialVersion }[];
  assetReader: (id: string) => Promise<AssetRecord>;
  writable: boolean;
  onChange?: (update: (state: MaterialUsageState) => void) => void;
  children?: ReactNode;
  onClose?: () => void;
  beforeViewing?: boolean;
  onEdit?: () => void;
};

export default function MaterialUsagePanel({
  design,
  materials,
  currentCatalog = [],
  assetReader,
  writable,
  onChange,
  children,
  onClose,
  beforeViewing,
  onEdit,
}: MaterialUsagePanelProps) {
  const result = calculateMaterialUsage(design.scene, materials, design.materialUsage, design.quote);
  const canEdit = writable && !!onChange;
  const [latestKey, setLatestKey] = useState<string | null>(null);
  const latestRow = result.rows.find((row) => row.key === latestKey);
  const latestMaterial =
    latestRow?.material &&
    currentCatalog.find((item) => item.material.id === latestRow.material!.materialId)?.version;
  const latestDiff =
    latestRow && latestMaterial ? describeLatestUsagePricing(latestRow, latestMaterial) : undefined;
  const change = (fn: (state: MaterialUsageState) => MaterialUsageState) => {
    if (canEdit) onChange?.((state) => Object.assign(state, fn(state)));
  };
  const pricing = (row: MaterialUsageRow, patch: Partial<UsagePriceSnapshot>) =>
    change((state) => setUsagePricing(state, row, patch));
  const selectUnit = (row: MaterialUsageRow, unit: UsageUnit) => {
    if (!canEdit || row.pricing.unit === unit || !flushMaterialUsageInputs()) return;
    if (!window.confirm('판매 단위를 바꾸면 단가를 비우고 구매 수량을 자동 계산으로 되돌려요. 변경할까요?'))
      return;
    change((state) =>
      setUsageQuantity(
        setUsagePricing(state, row, { unit, unitPrice: null, requiresUnitReview: false }),
        row,
        'auto',
      ),
    );
  };
  const rowView = (row: MaterialUsageRow) => {
    const material = row.material;
    const name = material?.name ?? '자재 정보 확인 필요';
    const latest =
      material && currentCatalog.find((item) => item.material.id === material.materialId)?.version;
    const diff = latest ? describeLatestUsagePricing(row, latest) : undefined;
    const label = unitLabel(row.pricing.unit, row.category);
    const tileArea = material ? (material.widthMm * material.heightMm) / 1_000_000 : null;
    const coverage = packagingCoverage(material?.widthMm ?? 0, material?.heightMm ?? 0, row.pricing);
    const purchaseArea =
      row.quantity === null
        ? null
        : row.pricing.unit === 'm2'
          ? row.quantity
          : row.pricing.unit === 'box'
            ? coverage.coverageM2 === null
              ? null
              : row.quantity * coverage.coverageM2
            : tileArea
              ? row.quantity * tileArea
              : null;
    const referencePieces =
      row.quantity === null
        ? null
        : row.pricing.unit === 'piece'
          ? row.quantity
          : row.pricing.unit === 'box' && row.pricing.piecesPerBox !== null
            ? row.quantity * row.pricing.piecesPerBox
            : purchaseArea !== null && tileArea
              ? Math.ceil(purchaseArea / tileArea - 1e-9)
              : null;
    return (
      <article className="mu-row" data-testid="usage-row" aria-label={`${name} 사용 내역`} key={row.key}>
        <div className="mu-row-heading">
          <UsageImage assetId={getMaterialImageAssetId(material)} reader={assetReader} name={name} />
          <div>
            <strong>{name}</strong>
            <span>
              {material?.brand || '브랜드 미입력'}
              {material?.code ? ` · ${material.code}` : ''}
            </span>
            <span>
              {material
                ? `${number(material.widthMm)} × ${number(material.heightMm)}${row.category === 'fixture' ? ` × ${number(material.depthMm)}` : ''} mm`
                : '규격 미확인'}
            </span>
          </div>
        </div>
        <p className="mu-locations">{row.locations.join(' · ') || '적용 위치 확인 필요'}</p>
        {row.category === 'tile' && (
          <div className="mu-areas">
            {row.areas.map((area) => (
              <div className="mu-area" key={area.surfaceId}>
                <NumericInput
                  label={`${area.name} 면적 (㎡)`}
                  commitUnchanged={area.source !== 'manual'}
                  value={area.areaM2}
                  writable={canEdit}
                  onCommit={(value) => change((state) => setUsageArea(state, area.surfaceId, value))}
                />
                <div className="mu-hint-row">
                  <small>
                    {area.source === 'room'
                      ? '공간 치수로 계산'
                      : area.source === 'legacy-total'
                        ? '이전 기록의 합계 면적'
                        : area.source === 'manual'
                          ? '직접 입력한 면적'
                          : '면적 확인 필요'}
                    {area.roomAreaM2 !== null && ` · 공간 기준 ${number(area.roomAreaM2)}㎡`}
                  </small>
                  {canEdit && area.source !== 'room' && area.roomAreaM2 !== null && (
                    <button
                      type="button"
                      className="mu-link"
                      aria-label={`${area.name} 면적 초기화`}
                      onClick={() => change((state) => setUsageArea(state, area.surfaceId, 'room'))}
                    >
                      <RotateCcw size={12} />
                      공간 기준
                    </button>
                  )}
                </div>
                {area.issue && <p className="mu-warning">{area.issue}</p>}
              </div>
            ))}
            <p className="mu-summary">
              적용 면적 <strong>{number(row.areaM2)}㎡</strong>
            </p>
          </div>
        )}
        <div className="mu-purchase">
          {row.category === 'tile' ? (
            <>
              <NumericInput
                label={`${name} 구매 수량`}
                displayLabel="구매 수량"
                commitUnchanged={row.quantityMode !== 'manual'}
                value={row.quantity}
                writable={canEdit}
                integer={row.pricing.unit !== 'm2'}
                onCommit={(value) => change((state) => setUsageQuantity(state, row, value))}
              />
              <div className="mu-hint-row">
                <small>
                  {row.quantityMode === 'manual' ? '수동 구매 수량' : '자동 구매 수량'} · 자동 계산{' '}
                  {number(row.automaticQuantity)} {label}
                </small>
                {canEdit && row.quantityMode === 'auto' && (
                  <button
                    type="button"
                    className="mu-link"
                    aria-label={`${name} 구매 수량 수동 입력`}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (!flushMaterialUsageInputs()) return;
                      change((state) => {
                        const latest = calculateMaterialUsage(
                          design.scene,
                          materials,
                          state,
                          design.quote,
                        ).rows.find((item) => item.key === row.key);
                        return setUsageQuantity(state, latest ?? row, latest?.quantity ?? row.quantity);
                      });
                    }}
                  >
                    수동으로
                  </button>
                )}
                {canEdit && row.quantityMode === 'manual' && (
                  <button
                    type="button"
                    className="mu-link"
                    aria-label={`${name} 구매 수량 자동 계산`}
                    onClick={() => change((state) => setUsageQuantity(state, row, 'auto'))}
                  >
                    <RotateCcw size={12} />
                    자동으로
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="mu-summary">
              배치한 제품 <strong>{number(row.count, 0)}개</strong>
            </p>
          )}
          {row.category === 'tile' && (
            <p className="mu-quantity-note">
              구매 면적 {number(purchaseArea)}㎡ · 참고 장수 {number(referencePieces, 0)}장<br />
              <small>
                면적과 포장 규격으로 계산한 참고 수량이에요. 실제 구매 수량은 현장에서 확인해 주세요.
              </small>
            </p>
          )}
          <div className="mu-price-grid">
            <label className="mu-field">
              <span>판매 단위</span>
              <select
                aria-label={`${name} 판매 단위`}
                disabled={!canEdit}
                value={row.pricing.unit}
                onChange={(event) => selectUnit(row, event.target.value as UsageUnit)}
              >
                {(row.category === 'tile' ? (['box', 'piece', 'm2'] as const) : (['piece'] as const)).map(
                  (unit) => (
                    <option value={unit} key={unit}>
                      {unitLabel(unit, row.category)}
                    </option>
                  ),
                )}
              </select>
            </label>
            <NumericInput
              label={`${name} 단가 (원)`}
              displayLabel="단가 (원)"
              value={row.pricing.unitPrice}
              writable={canEdit}
              max={MAX_USAGE_UNIT_PRICE}
              integer
              onCommit={(value) =>
                pricing(row, {
                  unitPrice: value,
                  ...(row.pricing.requiresUnitReview ? { requiresUnitReview: false } : {}),
                })
              }
            />
          </div>
          {row.category === 'tile' && row.pricing.unit === 'box' && (
            <details className="mu-pack">
              <summary>
                박스 포장 정보 <ChevronDown size={12} />
              </summary>
              <NumericInput
                label={`${name} 박스당 면적 (㎡)`}
                displayLabel="박스당 면적 (㎡)"
                value={row.pricing.boxCoverageM2}
                writable={canEdit}
                positive
                onCommit={(value) => pricing(row, { boxCoverageM2: value })}
              />
              <NumericInput
                label={`${name} 박스당 수량 (장)`}
                displayLabel="박스당 수량 (장)"
                value={row.pricing.piecesPerBox}
                writable={canEdit}
                integer
                positive
                onCommit={(value) => pricing(row, { piecesPerBox: value })}
              />
            </details>
          )}
          <p className="mu-price-source">
            이 시안의 단가 ·{' '}
            {row.pricing.unitPrice === null ? '단가 미입력' : `${money(row.pricing.unitPrice)} / ${label}`}
          </p>
          {canEdit && diff?.changed && (
            <button
              className="mu-latest"
              type="button"
              disabled={!diff.compatible}
              onClick={() => {
                if (flushMaterialUsageInputs()) setLatestKey(row.key);
              }}
            >
              최신 단가 적용
            </button>
          )}
          {diff && !diff.compatible && (
            <p className="mu-warning">
              {diff.reason || '최신 자재의 규격이 달라요. 시안에서 자재를 다시 적용해 주세요.'}
            </p>
          )}
          {row.issues.length > 0 && (
            <ul className="mu-issues">
              {row.issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          )}
          <p className="mu-amount">
            <span>자재 금액</span>
            <strong data-testid="usage-row-amount">{money(row.amount)}</strong>
          </p>
        </div>
      </article>
    );
  };
  return (
    <aside className="material-usage-panel" aria-label={`${design.name} 자재 사용 내역`}>
      <header className="mu-header">
        <div>
          <h3>자재 수량·금액</h3>
          <p>{design.name}의 사용 자재</p>
        </div>
        {onClose && (
          <button type="button" className="mu-close" onClick={onClose} aria-label="사용 내역 닫기">
            <X size={18} />
          </button>
        )}
      </header>
      <div className="mu-scroll">
        {beforeViewing && (
          <p className="mu-notice">Before를 보고 있어요. 아래 사용량과 금액은 이 시안의 After 기준이에요.</p>
        )}
        {!canEdit && (
          <p className="mu-notice">
            시안에 저장된 사용량과 단가예요.
            {onEdit && (
              <button className="mu-link" onClick={onEdit}>
                이 시안 편집
              </button>
            )}
          </p>
        )}
        {result.rows.length === 0 && (
          <div className="mu-empty">
            <strong>아직 적용한 자재가 없어요.</strong>
            <p>타일이나 제품을 배치하면 사용량과 금액이 여기에 모여요.</p>
          </div>
        )}
        {(['tile', 'fixture'] as const).map((category) => {
          const rows = result.rows.filter((row) => row.category === category);
          return rows.length ? (
            <section key={category} className="mu-group">
              <h4>
                {category === 'tile' ? '타일' : '위생도기·기타 제품'} <span>{rows.length}</span>
              </h4>
              {rows.map(rowView)}
            </section>
          ) : null;
        })}
        {children && <div className="mu-properties">{children}</div>}
      </div>
      <footer className="mu-footer">
        <div>
          <span>{result.complete ? '예상 자재비 합계' : '확인된 자재비'}</span>
          <strong data-testid="usage-total">{money(result.total)}</strong>
        </div>
        {!result.complete && (
          <p>
            {result.unresolvedCount > 0 && <>미계산 자재 {result.unresolvedCount}종</>}
            {result.attentionCount > 0 && (
              <>
                {result.unresolvedCount > 0 ? ' · ' : ''}면적·포장 확인 필요 {result.attentionCount}종
              </>
            )}
          </p>
        )}
        <small>적용한 자재 기준이며 입력값에 따라 달라져요.</small>
      </footer>
      {latestRow && latestMaterial && latestDiff && (
        <div className="mu-confirm-backdrop">
          <section className="mu-confirm" role="dialog" aria-modal="true" aria-label="최신 단가 확인">
            <h3>최신 단가를 가져올까요?</h3>
            <p>{latestMaterial.name}의 시안 단가만 갱신해요. 배치와 이미지는 유지돼요.</p>
            <table>
              <thead>
                <tr>
                  <th>항목</th>
                  <th>현재 시안</th>
                  <th>최신 등록값</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>판매 단위</th>
                  <td>{unitLabel(latestDiff.previous.unit, latestRow.category)}</td>
                  <td>{unitLabel(latestDiff.next.unit, latestRow.category)}</td>
                </tr>
                <tr>
                  <th>단가</th>
                  <td>{money(latestDiff.previous.unitPrice)}</td>
                  <td>{money(latestDiff.next.unitPrice)}</td>
                </tr>
                <tr>
                  <th>박스 면적</th>
                  <td>{number(latestDiff.previous.boxCoverageM2)}㎡</td>
                  <td>{number(latestDiff.next.boxCoverageM2)}㎡</td>
                </tr>
                <tr>
                  <th>박스당 수량</th>
                  <td>{number(latestDiff.previous.piecesPerBox, 0)}</td>
                  <td>{number(latestDiff.next.piecesPerBox, 0)}</td>
                </tr>
              </tbody>
            </table>
            {latestDiff.unitChanged && (
              <p className="mu-warning">
                판매 단위가 달라 수동 구매 수량을 초기화하고 자동 계산으로 되돌려요.
              </p>
            )}
            <div className="mu-confirm-actions">
              <button type="button" className="btn" onClick={() => setLatestKey(null)}>
                취소
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!canEdit || !latestDiff.compatible}
                onClick={() => {
                  change((state) => applyLatestUsagePricing(state, latestRow, latestMaterial));
                  setLatestKey(null);
                }}
              >
                단가 적용
              </button>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
