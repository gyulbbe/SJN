'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FacetSelection } from '@/lib/catalog/facets';
import type { LibraryCounts, MaterialPage, MaterialPageQuery } from '@/lib/catalog/paging';

export type PageStatus = 'loading' | 'idle' | 'done' | 'error';
export type MaterialPages<T> = {
  items: T[];
  status: PageStatus;
  error: string;
  /** Every match of the query (first page). */
  total?: number;
  facets?: FacetSelection;
  counts?: LibraryCounts;
  /** Next page; does nothing while a page is on its way, after the last page or after an error. */
  loadMore: () => void;
  /** Ask again for the page that failed (never automatic). */
  retry: () => void;
  /** Change loaded items in place (an edited or deactivated card) without asking again. */
  update: (change: (items: T[]) => T[]) => void;
};

/**
 * A server-paged list (docs/material-paging-results-20261022.md). A new `key` (the query and anything
 * else that changes the list) cancels the page on its way and starts from the first page. At most one
 * page is requested at a time, and a failed one waits for `retry`. An item changed between pages (a new
 * priority or name) can come again on a later page; `identify` keeps the one already shown.
 */
export function useMaterialPages<T>(
  fetchPage: (query: MaterialPageQuery, signal: AbortSignal) => Promise<MaterialPage<T>>,
  query: MaterialPageQuery,
  key: string,
  enabled = true,
  identify?: (item: T) => string,
): MaterialPages<T> {
  const [state, setState] = useState<{
    key: string;
    items: T[];
    cursor: string | null;
    status: PageStatus;
    error: string;
    total?: number;
    facets?: FacetSelection;
    counts?: LibraryCounts;
    /** The items are the previous query's, shown until its first page arrives. */
    stale?: boolean;
  }>({ key: '', items: [], cursor: null, status: 'loading', error: '' });
  const inflight = useRef<{ key: string; controller: AbortController } | null>(null);
  const latest = useRef({ fetchPage, query, key, identify });
  latest.current = { fetchPage, query, key, identify };

  const request = useCallback((cursor: string | null) => {
    const { fetchPage, query, key, identify } = latest.current;
    if (inflight.current?.key === key) return;
    inflight.current?.controller.abort();
    const controller = new AbortController();
    inflight.current = { key, controller };
    setState((previous) =>
      previous.key === key
        ? { ...previous, status: 'loading', error: '' }
        : // The previous items, counts and facet options stay until the new first page replaces them:
          // a card that stays in the list keeps its element (and the focus), an open panel stays open.
          { ...previous, key, cursor: null, status: 'loading', error: '', stale: true },
    );
    fetchPage(cursor ? { ...query, cursor } : query, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setState((previous) => {
          const shown = new Set(identify ? previous.items.map(identify) : []);
          return {
            key,
            items:
              cursor && previous.key === key
                ? [...previous.items, ...page.items.filter((item) => !identify || !shown.has(identify(item)))]
                : page.items,
            cursor: page.nextCursor,
            status: page.nextCursor ? 'idle' : 'done',
            error: '',
            total: cursor ? previous.total : page.total,
            facets: cursor ? previous.facets : (page.facets ?? previous.facets),
            counts: cursor ? previous.counts : page.counts,
            stale: false,
          };
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((previous) => ({
          ...previous,
          key,
          // A first page that failed leaves no results of another query on screen.
          items: previous.stale ? [] : previous.items,
          stale: false,
          status: 'error',
          error: error instanceof Error ? error.message : '자재 목록을 불러오지 못했어요.',
        }));
      })
      .finally(() => {
        if (inflight.current?.controller === controller) inflight.current = null;
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    request(null);
    return () => {
      inflight.current?.controller.abort();
      inflight.current = null;
    };
  }, [enabled, key, request]);

  const current = state.key === key;
  const loadMore = useCallback(() => {
    if (current && state.status === 'idle' && state.cursor) request(state.cursor);
  }, [current, state.status, state.cursor, request]);
  const retry = useCallback(() => {
    if (current && state.status === 'error') request(state.items.length ? state.cursor : null);
    else if (!current) request(null);
  }, [current, state.status, state.items.length, state.cursor, request]);
  const update = useCallback(
    (change: (items: T[]) => T[]) => setState((previous) => ({ ...previous, items: change(previous.items) })),
    [],
  );
  return {
    items: state.items,
    status: current ? state.status : 'loading',
    error: current ? state.error : '',
    ...(state.total !== undefined ? { total: state.total } : {}),
    ...(state.facets ? { facets: state.facets } : {}),
    ...(state.counts ? { counts: state.counts } : {}),
    loadMore,
    retry,
    update,
  };
}

/** A value that follows `value` after it stops changing for `delay` ms (search fields). */
export function useSettled<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** Calls `onVisible` while `target` is on screen inside `root` (null: the viewport). */
export function useVisible(
  target: React.RefObject<Element | null>,
  onVisible: () => void,
  options: { root?: React.RefObject<Element | null>; margin?: string; enabled?: boolean } = {},
) {
  const callback = useRef(onVisible);
  callback.current = onVisible;
  const { root, margin = '0px', enabled = true } = options;
  useEffect(() => {
    const node = target.current;
    if (!enabled || !node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current();
      },
      { root: root?.current ?? null, rootMargin: margin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [target, root, margin, enabled]);
}
