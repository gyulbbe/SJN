'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getMaterialImageAssetId } from '@/lib/material-images';
import { placementToMaterialVersion, type PublicPlacement } from '@/lib/catalog/placement-contract';
import type { LayoutItem, LayoutRoom, PublicLayout, PublicLayouts } from '@/lib/fixture-layout-contract';
import { layoutPlanShapes } from '@/lib/fixture-layouts';

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

export function LayoutPlan({
  room,
  items,
  sizes,
}: {
  room: LayoutRoom;
  items: readonly LayoutItem[];
  sizes: ReadonlyMap<string, { widthMm: number; depthMm: number }>;
}) {
  const shapes = useMemo(() => layoutPlanShapes(room, items, sizes), [room, items, sizes]);
  return (
    <svg
      data-testid="layout-plan"
      viewBox={`0 0 ${room.widthMm} ${room.depthMm}`}
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
          <LayoutPlan room={layout.room} items={layout.items} sizes={placements} />
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
}: {
  state: LoadState;
  /** Why a press does nothing here (no room, read only, Before); empty when it works. */
  disabledReason: string;
  busyId: string;
  onPick: (layout: PublicLayout, placements: PublicPlacement[]) => void;
  onRetry: () => void;
}) {
  const placements = useMemo(
    () => new Map((state.data?.placements ?? []).map((placement) => [placement.materialId, placement])),
    [state.data],
  );
  const layouts = state.data?.layouts ?? [];
  return (
    <div className="catalog-grid !block space-y-2" data-testid="fixture-layouts-panel">
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
