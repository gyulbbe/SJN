'use client';
import { useEffect, useRef, type RefObject } from 'react';
import { RotateCcw } from 'lucide-react';
import { useVisible, type MaterialPages } from './use-material-pages';

/**
 * The end of a paged list: loads the next page when it scrolls into view, and always offers "더 보기"
 * so the whole list is reachable without scrolling (keyboard, no IntersectionObserver). While "더 보기"
 * has the focus nothing loads by itself: the keyboard decides. After "더 보기" the focus moves to the
 * first new item (`focusItem`), and the button keeps the focus while it waits (it is never disabled).
 * A failure waits for "다시 시도".
 */
export function LoadMore({
  pages,
  root,
  focusItem,
  className = '',
}: {
  pages: Pick<MaterialPages<unknown>, 'items' | 'status' | 'error' | 'loadMore' | 'retry'>;
  /** The scrolling element the list is in (null: the page). */
  root?: RefObject<Element | null>;
  focusItem?: (index: number) => HTMLElement | null | undefined;
  className?: string;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const count = pages.items.length;
  const loading = pages.status === 'loading';
  useVisible(
    sentinel,
    () => {
      if (document.activeElement !== button.current) pages.loadMore();
    },
    { root, enabled: pages.status === 'idle' },
  );
  useEffect(() => {
    if (pendingFocus.current === null || count <= pendingFocus.current) return;
    focusItem?.(pendingFocus.current)?.focus({ preventScroll: false });
    pendingFocus.current = null;
  }, [count, focusItem]);
  if (!count && pages.status !== 'error') return <div ref={sentinel} aria-hidden="true" />;
  return (
    <div
      className={'col-span-full flex flex-col items-center gap-2 py-4 ' + className}
      data-testid="load-more"
    >
      <div ref={sentinel} aria-hidden="true" className="h-px w-full" />
      {pages.status === 'error' ? (
        <>
          <p role="alert" className="m-0 text-center text-[13px] text-[color:var(--danger,#b42318)]">
            {pages.error || '자재 목록을 불러오지 못했어요.'}
          </p>
          <button type="button" className="btn" onClick={pages.retry}>
            <RotateCcw size={14} aria-hidden="true" /> 다시 시도
          </button>
        </>
      ) : pages.status === 'done' ? (
        <p className="m-0 text-[12px] text-[color:var(--muted)]">목록의 끝이에요.</p>
      ) : (
        <button
          ref={button}
          type="button"
          className="btn"
          aria-disabled={loading}
          aria-busy={loading}
          onClick={() => {
            if (loading) return;
            pendingFocus.current = count;
            pages.loadMore();
          }}
        >
          {loading ? '불러오는 중…' : '더 보기'}
        </button>
      )}
    </div>
  );
}
