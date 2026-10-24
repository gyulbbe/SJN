'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { categoryLabels, fixtureCategories, type MaterialCategory } from '@/lib/types';

const chip =
  'min-h-8 shrink-0 whitespace-nowrap rounded-full border border-transparent px-2.5 text-xs text-[color:var(--muted)] hover:border-[color:var(--line)] aria-pressed:border-[color:var(--accent)] aria-pressed:bg-[color:var(--accent-light)] aria-pressed:font-semibold aria-pressed:text-[color:var(--accent)] max-[620px]:min-h-11 [@media(pointer:coarse)]:min-h-11';
/** The row fades out on a side that has more chips past it. */
const fades = {
  none: '',
  end: '[mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)]',
  start: '[mask-image:linear-gradient(to_left,#000_calc(100%-28px),transparent)]',
  both: '[mask-image:linear-gradient(to_right,transparent,#000_28px,#000_calc(100%-28px),transparent)]',
};

/**
 * The 위생도기 tab's kinds, as the material library's chips (no tiles, no 샤워 커튼): one row that
 * scrolls sideways in a narrow panel. It has no scrollbar (the panel keeps its height for the cards);
 * a faded side, the wheel, touch and focus move it. Picking one asks for that kind's first page.
 */
export function FixtureKindChips({
  value,
  onChange,
}: {
  value: 'all' | MaterialCategory;
  onChange: (kind: 'all' | MaterialCategory) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<keyof typeof fades>('none');
  // The picked chip stays in view, also when the row comes back with the tab (scrolled to its start).
  useLayoutEffect(() => {
    const list = row.current;
    const picked = list?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!list || !picked) return;
    const left = picked.offsetLeft,
      right = left + picked.offsetWidth;
    if (left < list.scrollLeft || right > list.scrollLeft + list.clientWidth)
      list.scrollLeft = left - (list.clientWidth - picked.offsetWidth) / 2;
  }, [value]);
  useEffect(() => {
    const list = row.current;
    if (!list) return;
    const sides = () => {
      const start = list.scrollLeft > 1,
        end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      setFade(start && end ? 'both' : start ? 'start' : end ? 'end' : 'none');
    };
    // A mouse wheel scrolls the row sideways while it can move; past either end the panel scrolls.
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const step = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      const next = Math.min(list.scrollWidth - list.clientWidth, Math.max(0, list.scrollLeft + step));
      if (next === list.scrollLeft) return;
      event.preventDefault();
      list.scrollLeft = next;
    };
    const resized = new ResizeObserver(sides);
    resized.observe(list);
    list.addEventListener('scroll', sides, { passive: true });
    list.addEventListener('wheel', onWheel, { passive: false });
    sides();
    return () => {
      resized.disconnect();
      list.removeEventListener('scroll', sides);
      list.removeEventListener('wheel', onWheel);
    };
  }, []);
  const pick = (kind: 'all' | MaterialCategory) => {
    if (kind !== value) onChange(kind);
  };
  return (
    <div
      ref={row}
      role="group"
      aria-label="위생도기 종류"
      data-testid="fixture-kind-chips"
      className={`relative mx-[var(--catalog-pad,14px)] mt-1.5 flex shrink-0 gap-1 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${fades[fade]}`}
    >
      <button type="button" className={chip} aria-pressed={value === 'all'} onClick={() => pick('all')}>
        전체
      </button>
      {fixtureCategories.map((kind) => (
        <button
          key={kind}
          type="button"
          className={chip}
          aria-pressed={value === kind}
          onClick={() => pick(kind)}
        >
          {categoryLabels[kind]}
        </button>
      ))}
    </div>
  );
}
