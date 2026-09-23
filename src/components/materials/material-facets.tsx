'use client';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { facetKeys, facetLabels, type FacetKey, type FacetSelection } from '@/lib/catalog/facets';

/**
 * Two-step material filter: a row of category buttons, each opening one panel below it.
 * Size is a table of cells; colour and surface are checkbox lists.
 */
export function MaterialFacets({
  options,
  value,
  onChange,
  className = '',
  compact = false,
}: {
  options: FacetSelection;
  value: FacetSelection;
  onChange: (value: FacetSelection) => void;
  className?: string;
  /** The editor's 250px catalog panel: two columns and a scrolling panel. */
  compact?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState<FacetKey | null>(null);
  const toggles = useRef<Partial<Record<FacetKey, HTMLButtonElement | null>>>({});
  // A tab or category change can empty the open group; close it rather than show an empty panel.
  if (open && !options[open].length) setOpen(null);
  const groups = facetKeys.filter((key) => options[key].length > 0);
  if (!groups.length) return null;

  const selected = (key: FacetKey) => value[key].filter((option) => options[key].includes(option));
  const toggle = (key: FacetKey, option: string) =>
    onChange({
      ...value,
      [key]: value[key].includes(option)
        ? value[key].filter((item) => item !== option)
        : [...value[key], option],
    });
  function closeOnEscape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape' || !open) return;
    // Keep the editor's window-level Escape (close drawer, cancel edit) out of this.
    event.stopPropagation();
    setOpen(null);
    toggles.current[open]?.focus();
  }

  return (
    <div className={className} onKeyDown={closeOnEscape}>
      <div className="flex flex-wrap gap-2">
        {groups.map((key) => {
          const count = selected(key).length;
          const expanded = open === key;
          const Chevron = expanded ? ChevronUp : ChevronDown;
          return (
            <button
              key={key}
              ref={(node) => {
                toggles.current[key] = node;
              }}
              type="button"
              aria-expanded={expanded}
              aria-controls={`${id}-${key}`}
              aria-label={count ? `${facetLabels[key]} ${count}개 선택` : undefined}
              onClick={() => setOpen(expanded ? null : key)}
              className={
                'inline-flex items-center gap-1.5 rounded-full border border-[color:var(--line)] bg-[color:var(--paper)] text-[color:var(--ink)] hover:border-[color:var(--muted)] aria-expanded:border-[color:var(--ink)] max-[620px]:min-h-11 ' +
                (compact ? 'min-h-8 px-3 text-xs' : 'min-h-10 px-4 text-sm')
              }
            >
              {facetLabels[key]}
              {count > 0 && (
                <span className="inline-grid h-5 min-w-5 place-items-center rounded-full bg-[color:var(--accent)] px-1.5 text-[11px] font-semibold text-white">
                  {count}
                </span>
              )}
              <Chevron size={compact ? 13 : 15} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {groups.map((key) => (
        <div
          key={key}
          id={`${id}-${key}`}
          role="group"
          aria-label={facetLabels[key]}
          hidden={open !== key}
          className={
            'mt-2.5 rounded-[var(--radius-sm)] bg-[color:var(--surface-soft)] ' +
            (compact ? 'max-h-44 overflow-y-auto p-2' : 'p-3')
          }
        >
          {key === 'size' ? (
            <div
              className={
                // Each cell owns its border (overlapped by 1px) so a short last row leaves no stray lines.
                'grid pl-px pt-px ' +
                (compact ? 'grid-cols-2' : 'grid-cols-2 min-[621px]:grid-cols-4 min-[901px]:grid-cols-6')
              }
            >
              {options[key].map((option) => (
                <label
                  key={option}
                  className={
                    'relative -ml-px -mt-px grid place-items-center border border-[color:var(--line)] bg-[color:var(--paper)] text-[color:var(--ink)] tabular-nums ' +
                    (compact ? 'min-h-9 text-xs max-[620px]:min-h-11' : 'min-h-11 text-[13px]')
                  }
                >
                  {/* The real checkbox covers the cell so mouse, keyboard and screen readers share it. */}
                  <input
                    type="checkbox"
                    checked={value[key].includes(option)}
                    onChange={() => toggle(key, option)}
                    className="absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-none checked:bg-[color:var(--accent-light)] checked:shadow-[inset_0_0_0_2px_var(--accent)] focus-visible:shadow-[inset_0_0_0_3px_var(--accent)]"
                  />
                  <span className="pointer-events-none relative">{option}</span>
                </label>
              ))}
            </div>
          ) : (
            <div
              className={
                'grid gap-x-4 ' +
                (compact ? 'grid-cols-2' : 'grid-cols-[repeat(auto-fill,minmax(160px,1fr))]')
              }
            >
              {options[key].map((option) => (
                <label
                  key={option}
                  className={
                    'flex min-w-0 cursor-pointer items-center gap-2 text-[color:var(--ink)] max-[620px]:min-h-11 ' +
                    (compact ? 'min-h-8 text-xs' : 'min-h-9 text-[13px]')
                  }
                >
                  <input
                    type="checkbox"
                    checked={value[key].includes(option)}
                    onChange={() => toggle(key, option)}
                    className="size-4 shrink-0 cursor-pointer accent-[var(--accent)]"
                  />
                  <span className="min-w-0 break-keep">{option}</span>
                </label>
              ))}
            </div>
          )}
          {selected(key).length > 0 && (
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => onChange({ ...value, [key]: [] })}
                className="text-xs font-semibold text-[color:var(--accent)] underline-offset-2 hover:underline"
              >
                선택 해제
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
