'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { normalizeCatalogName } from '@/lib/catalog/contract';
import styles from './catalog.module.css';
export default function CatalogSelect({
  label,
  options,
  value,
  multiple = false,
  onChange,
  onQueryChange,
}: {
  label: string;
  options: { id: string; name: string; active: boolean }[];
  value: string[];
  multiple?: boolean;
  onChange: (ids: string[]) => void;
  onQueryChange?: (pending: boolean) => void;
}) {
  const id = useId(),
    root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(''),
    [open, setOpen] = useState(false),
    [index, setIndex] = useState(-1);
  const choices = options.filter(
    (item) => item.active && normalizeCatalogName(item.name).includes(normalizeCatalogName(query)),
  );
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  useEffect(() => {
    if (open && index >= 0) document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, index, id]);
  function choose(option: string) {
    onChange(
      multiple ? (value.includes(option) ? value.filter((v) => v !== option) : [...value, option]) : [option],
    );
    setQuery('');
    onQueryChange?.(false);
    if (!multiple) setOpen(false);
    setIndex(-1);
  }
  return (
    <div
      className={styles.select}
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setIndex(-1);
        }
      }}
    >
      <label htmlFor={id}>{label}</label>
      <div className={styles.tags}>
        {value.map((v) => (
          <button
            type="button"
            key={v}
            onClick={() => onChange(value.filter((item) => item !== v))}
            aria-label={`${label} ${options.find((o) => o.id === v)?.name ?? '이전 선택'} 제거`}
          >
            {options.find((o) => o.id === v)?.name ?? '이전 선택'}
            {options.find((o) => o.id === v)?.active ? '' : ' (비활성)'} ×
          </button>
        ))}
      </div>
      <input
        id={id}
        className="input"
        role="combobox"
        aria-autocomplete="list"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        aria-activedescendant={open && choices[index] ? `${id}-${index}` : undefined}
        value={query}
        placeholder={`${label} 검색 또는 목록 선택`}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          onQueryChange?.(!!e.target.value.trim());
          setOpen(true);
          setIndex(-1);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) {
            if (e.key === 'Enter') e.preventDefault();
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setOpen(false);
            setIndex(-1);
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            setIndex((current) => {
              if (!choices.length) return -1;
              if (!open || current < 0) return e.key === 'ArrowDown' ? 0 : choices.length - 1;
              return Math.max(0, Math.min(choices.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
            });
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            if (open && choices[Math.max(0, index)]) choose(choices[Math.max(0, index)].id);
          }
        }}
      />
      {open && (
        <ul
          id={`${id}-options`}
          className={styles.options}
          role="listbox"
          tabIndex={-1}
          aria-label={`${label} 선택 목록`}
          aria-multiselectable={multiple || undefined}
        >
          {!choices.length && <li role="presentation">등록된 항목이 없어요.</li>}
          {choices.map((option, i) => (
            <li
              key={option.id}
              id={`${id}-${i}`}
              role="option"
              aria-selected={value.includes(option.id)}
              className={index === i ? styles.focused : ''}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(option.id)}
            >
              {value.includes(option.id) ? '✓ ' : ''}
              {option.name}
            </li>
          ))}
        </ul>
      )}
      {query && <small>목록에서 선택해야 저장돼요.</small>}
    </div>
  );
}
