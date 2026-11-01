'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createManagedLayout, loadManagedLayouts, overwriteManagedLayout } from '@/lib/catalog/client';
import { getMaterialImageAssetId } from '@/lib/material-images';
import { placementToMaterialVersion, type PublicPlacement } from '@/lib/catalog/placement-contract';
import {
  MAX_LAYOUT_ITEMS,
  type LayoutRoom,
  type ManagedLayout,
  type PublicLayout,
  type PublicLayouts,
} from '@/lib/fixture-layout-contract';
import { layoutPlanShapes, type RegisteredLayout } from '@/lib/fixture-layouts';

/** A card shows this many product photos, then "+N": each photo is one image request. */
const CARD_PHOTOS = 3;

type LoadState = { status: 'idle' | 'loading' | 'done' | 'error'; data?: PublicLayouts; error?: string };
/**
 * The layouts, read the first time the tab opens and kept while the editor is open: opening the editor
 * and coming back to the tab read nothing. A failure waits for the person to try again.
 */
export function useFixtureLayouts(
  read: (() => Promise<PublicLayouts>) | undefined,
  open: boolean,
  scopeKey: string,
) {
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const request = useRef(0);
  const load = useCallback(async () => {
    if (!read) return;
    const current = ++request.current;
    setState((previous) => ({ ...previous, status: 'loading' }));
    try {
      const data = await read();
      if (request.current === current) setState({ status: 'done', data });
    } catch (e) {
      if (request.current === current)
        setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }, [read]);
  const scope = useRef(scopeKey);
  useEffect(() => {
    if (scope.current !== scopeKey) {
      scope.current = scopeKey;
      request.current++;
      setState({ status: 'idle' });
      return;
    }
    if (open && state.status === 'idle') void load();
  }, [open, scopeKey, state.status, load]);
  return { state, reload: load };
}

function Plan({
  layout,
  placements,
}: {
  layout: PublicLayout;
  placements: ReadonlyMap<string, PublicPlacement>;
}) {
  const shapes = useMemo(() => layoutPlanShapes(layout.room, layout.items, placements), [layout, placements]);
  const { widthMm: width, depthMm: depth } = layout.room;
  return (
    <svg
      data-testid="layout-plan"
      viewBox={`0 0 ${width} ${depth}`}
      aria-hidden="true"
      className="h-14 w-14 shrink-0 rounded-sm border border-slate-300 bg-slate-50"
      preserveAspectRatio="xMidYMid meet"
    >
      {shapes.map((shape, index) => (
        <rect
          key={index}
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          fill={shape.wall ? '#7c8a8e' : '#b7c2c5'}
        />
      ))}
    </svg>
  );
}

function LayoutCard({
  layout,
  number,
  placements,
  disabled,
  busy,
  onPick,
}: {
  layout: PublicLayout;
  number: number;
  placements: ReadonlyMap<string, PublicPlacement>;
  disabled: boolean;
  busy: boolean;
  onPick: () => void;
}) {
  const products = [...new Set(layout.items.map((item) => item.materialId))].flatMap(
    (id) => placements.get(id) ?? [],
  );
  const names = layout.items.flatMap((item) => placements.get(item.materialId)?.name ?? []);
  return (
    <button
      type="button"
      data-testid="fixture-layout-card"
      className="flex w-full flex-col gap-2 rounded-md border border-slate-200 bg-white p-2.5 text-left hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={disabled}
      aria-busy={busy}
      title={`${number}번 ${layout.name} 놓기`}
      onClick={onPick}
    >
      <strong className="truncate text-xs font-semibold">
        {number}번 · {layout.name}
      </strong>
      <span className="flex items-center gap-1.5">
        {products.slice(0, CARD_PHOTOS).map((product) => {
          const image = getMaterialImageAssetId(placementToMaterialVersion(product));
          return (
            <img
              key={product.materialId}
              src={image ? `/api/catalog/images?id=${encodeURIComponent(image)}&size=list` : undefined}
              alt={product.name}
              loading="lazy"
              className="h-14 w-14 min-w-0 rounded-sm bg-slate-100 object-contain"
            />
          );
        })}
        {products.length > CARD_PHOTOS && (
          <span className="text-[11px] text-slate-500">+{products.length - CARD_PHOTOS}</span>
        )}
        <span className="ml-auto">
          <Plan layout={layout} placements={placements} />
        </span>
      </span>
      <small className="line-clamp-2 text-[11px] text-slate-500">{names.join(' · ')}</small>
      {layout.missing > 0 && (
        <small className="text-[11px] text-amber-700">
          지금은 쓸 수 없는 제품 {layout.missing}개가 빠져요.
        </small>
      )}
    </button>
  );
}

export function FixtureLayoutsPanel({
  state,
  disabledReason,
  busyId,
  onPick,
  onRetry,
  onRegister,
  registerReason,
}: {
  state: LoadState;
  /** Why a press does nothing here (no room, read only, Before); empty when it works. */
  disabledReason: string;
  busyId: string;
  onPick: (layout: PublicLayout, placements: PublicPlacement[]) => void;
  onRetry: () => void;
  /** An administrator's registering; absent for everyone else. */
  onRegister?: () => void;
  registerReason?: string;
}) {
  const placements = useMemo(
    () => new Map((state.data?.placements ?? []).map((placement) => [placement.materialId, placement])),
    [state.data],
  );
  const layouts = state.data?.layouts ?? [];
  return (
    <div className="catalog-grid !block space-y-2" data-testid="fixture-layouts-panel">
      {onRegister && (
        <div className="space-y-1">
          <button
            type="button"
            className="btn w-full"
            data-testid="register-layout"
            disabled={!!registerReason}
            onClick={onRegister}
          >
            지금 놓인 제품을 기본 배치로 등록
          </button>
          {registerReason && <p className="text-[11px] text-slate-500">{registerReason}</p>}
        </div>
      )}
      {disabledReason && layouts.length > 0 && (
        <p className="text-[11px] text-slate-500" role="status">
          {disabledReason}
        </p>
      )}
      {state.status === 'loading' && !layouts.length && (
        <div className="empty-catalog" role="status">
          기본 배치를 불러오는 중…
        </div>
      )}
      {state.status === 'error' && (
        <div className="empty-catalog">
          {state.error || '기본 배치를 불러오지 못했어요.'}
          <br />
          <button type="button" className="text-button" onClick={onRetry}>
            다시 시도
          </button>
        </div>
      )}
      {state.status === 'done' && !layouts.length && (
        <div className="empty-catalog">아직 준비된 기본 배치가 없어요.</div>
      )}
      {layouts.map((layout, index) => (
        <LayoutCard
          key={layout.id}
          layout={layout}
          number={index + 1}
          placements={placements}
          disabled={!!disabledReason || !!busyId}
          busy={busyId === layout.id}
          onPick={() => onPick(layout, state.data!.placements)}
        />
      ))}
    </div>
  );
}

/** An administrator's window: what is placed now goes in as a new layout or over an existing one. */
export function RegisterLayoutDialog({
  registered,
  room,
  userId,
  onClose,
  onSaved,
}: {
  registered: RegisteredLayout;
  room: LayoutRoom;
  userId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(''),
    [target, setTarget] = useState(''),
    [existing, setExisting] = useState<ManagedLayout[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let dead = false;
    loadManagedLayouts(userId)
      .then((layouts) => {
        if (!dead) setExisting(layouts);
      })
      .catch((e) => {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      dead = true;
    };
  }, [userId]);
  const { items, refused, asPhoto } = registered;
  const tooMany = items.length > MAX_LAYOUT_ITEMS;
  const blocked = refused.length > 0 || !items.length || tooMany;
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (blocked) return;
    const over = existing.find((layout) => layout.id === target);
    if (over && !window.confirm(`'${over.name}' 배치를 지금 놓인 제품으로 덮어쓸까요?`)) return;
    setBusy(true);
    setError('');
    try {
      if (over) await overwriteManagedLayout({ id: over.id, revision: over.revision, items, room }, userId);
      else await createManagedLayout({ name, sortOrder: null, active: true, items, room }, userId);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="기본 배치로 등록">
      <form className="modal-card space-y-3" style={{ maxWidth: 440 }} onSubmit={save}>
        <h2 className="text-base font-semibold">기본 배치로 등록</h2>
        <p className="text-xs text-slate-600">
          제품 {items.length}개의 자리를 그대로 저장해요. 타일·벽 구조·천장은 담지 않아요.
        </p>
        {refused.length > 0 && (
          <p className="text-xs text-red-700" role="alert">
            공용이 아닌 제품은 등록할 수 없어요: {refused.join(', ')}
          </p>
        )}
        {tooMany && (
          <p className="text-xs text-red-700" role="alert">
            제품은 {MAX_LAYOUT_ITEMS}개까지 담을 수 있어요.
          </p>
        )}
        {asPhoto.length > 0 && (
          <p className="text-xs text-slate-600">
            표준 모형으로 보는 제품은 사진 제품으로 등록돼요: {asPhoto.join(', ')}
          </p>
        )}
        <label className="field">
          등록할 곳
          <select
            className="input"
            aria-label="등록할 곳"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">새 배치로 만들기</option>
            {existing.map((layout) => (
              <option key={layout.id} value={layout.id}>
                덮어쓰기: {layout.name}
              </option>
            ))}
          </select>
        </label>
        {!target && (
          <label className="field">
            이름
            <input
              className="input"
              aria-label="기본 배치 이름"
              maxLength={100}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="text-xs text-red-700" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button type="submit" className="btn primary" disabled={busy || blocked}>
            저장
          </button>
        </div>
      </form>
    </div>
  );
}
