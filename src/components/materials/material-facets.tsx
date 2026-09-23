'use client';
import { facetKeys, facetLabels, type FacetSelection } from '@/lib/catalog/facets';

export function MaterialFacets({
  options,
  value,
  onChange,
  className = '',
}: {
  options: FacetSelection;
  value: FacetSelection;
  onChange: (value: FacetSelection) => void;
  className?: string;
}) {
  const groups = facetKeys.filter((key) => options[key].length > 0);
  if (!groups.length) return null;
  return (
    <div className={'grid gap-2.5 ' + className}>
      {groups.map((key) => (
        <div key={key} role="group" aria-label={facetLabels[key]} className="grid gap-1.5">
          <span className="text-[11px] font-semibold text-[color:var(--muted)]">{facetLabels[key]}</span>
          <div className="flex flex-wrap gap-1.5">
            {options[key].map((option) => {
              const pressed = value[key].includes(option);
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() =>
                    onChange({
                      ...value,
                      [key]: pressed ? value[key].filter((item) => item !== option) : [...value[key], option],
                    })
                  }
                  className="inline-flex min-h-8 items-center rounded-full border border-[color:var(--line)] bg-[color:var(--paper)] px-3 text-xs text-[color:var(--muted)] hover:border-[color:var(--accent)] hover:text-[color:var(--ink)] aria-pressed:border-[color:var(--accent)] aria-pressed:bg-[color:var(--accent-light)] aria-pressed:font-semibold aria-pressed:text-[color:var(--accent)] max-[620px]:min-h-11"
                >
                  {option}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
