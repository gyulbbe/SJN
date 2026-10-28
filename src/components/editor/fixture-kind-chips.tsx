'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { categoryLabels, fixtureCategories, type MaterialCategory } from '@/lib/types';

const chip =
  'min-h-8 shrink-0 whitespace-nowrap rounded-full border border-transparent px-2.5 text-xs text-[color:var(--muted)] hover:border-[color:var(--line)] aria-pressed:border-[color:var(--accent)] aria-pressed:bg-[color:var(--accent-light)] aria-pressed:font-semibold aria-pressed:text-[color:var(--accent)] max-[620px]:min-h-11 [@media(pointer:coarse)]:min-h-11';
/** A mouse resting this close to an end that has more chips moves the row that way. */
const EDGE = 48;
/** Pixels a frame: 1 at the zone's inner side up to 10 at the very end. */
const pace = (distance: number) => 1 + (9 * (EDGE - Math.max(0, distance))) / EDGE;
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
 * a faded side, a mouse resting near an end, the wheel, touch and focus move it. Picking one asks for
 * that kind's first page.
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
    // A mouse (a device that hovers) near an end keeps moving the row that way, faster nearer the end,
    // until it leaves the zone, the end is reached or a button goes down (so a chip under it can be
    // picked). Touch and pen push the row as before.
    const hovers = matchMedia('(hover: hover) and (pointer: fine)');
    let frame = 0,
      speed = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      speed = 0;
    };
    const glide = () => {
      const next = Math.min(list.scrollWidth - list.clientWidth, Math.max(0, list.scrollLeft + speed));
      if (next === list.scrollLeft) return stop();
      list.scrollLeft = next;
      frame = requestAnimationFrame(glide);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || !hovers.matches || event.buttons) return stop();
      const box = list.getBoundingClientRect();
      const fromLeft = event.clientX - box.left,
        fromRight = box.right - event.clientX;
      speed =
        fromRight < EDGE && list.scrollLeft + list.clientWidth < list.scrollWidth - 1
          ? pace(fromRight)
          : fromLeft < EDGE && list.scrollLeft > 1
            ? -pace(fromLeft)
            : 0;
      if (!speed) stop();
      else if (!frame) frame = requestAnimationFrame(glide);
    };
    const resized = new ResizeObserver(sides);
    resized.observe(list);
    list.addEventListener('scroll', sides, { passive: true });
    list.addEventListener('wheel', onWheel, { passive: false });
    list.addEventListener('pointermove', onMove);
    list.addEventListener('pointerdown', stop);
    list.addEventListener('pointerleave', stop);
    sides();
    return () => {
      stop();
      resized.disconnect();
      list.removeEventListener('scroll', sides);
      list.removeEventListener('wheel', onWheel);
      list.removeEventListener('pointermove', onMove);
      list.removeEventListener('pointerdown', stop);
      list.removeEventListener('pointerleave', stop);
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
