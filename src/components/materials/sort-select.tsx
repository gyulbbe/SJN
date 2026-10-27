'use client';
import { ArrowUpDown } from 'lucide-react';
import { materialSorts, shortSortLabels, sortLabels, type MaterialSort } from '@/lib/catalog/paging';

/**
 * The order of a material list (docs/material-order-results-20261027.md). `compact` is the editor's
 * narrow catalog panel: a small pill beside the search with short names (the full one as its title).
 */
export function SortSelect({
  value,
  onChange,
  compact = false,
  className = '',
}: {
  value: MaterialSort;
  onChange: (value: MaterialSort) => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <label
      className={
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[color:var(--muted)] ' +
        (compact ? 'text-xs ' : 'text-[13px] font-semibold ') +
        className
      }
    >
      {!compact && (
        <>
          <ArrowUpDown size={14} aria-hidden="true" />
          <span aria-hidden="true">정렬</span>
        </>
      )}
      {/* Named here: a label around a select would add the chosen option to its name. */}
      <select
        aria-label="정렬"
        title={compact ? sortLabels[value] : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value as MaterialSort)}
        className={
          'cursor-pointer rounded-full border border-[color:var(--line)] bg-[color:var(--paper)] font-normal text-[color:var(--ink)] hover:border-[color:var(--muted)] max-[620px]:min-h-11 [@media(pointer:coarse)]:min-h-11 ' +
          (compact ? 'min-h-8 px-2 text-xs' : 'min-h-10 px-3 text-[13px]')
        }
      >
        {materialSorts.map((sort) => (
          <option key={sort} value={sort}>
            {(compact ? shortSortLabels : sortLabels)[sort]}
          </option>
        ))}
      </select>
    </label>
  );
}
