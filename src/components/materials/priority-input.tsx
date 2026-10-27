'use client';
import { useEffect, useRef, useState } from 'react';
import { MAX_PRIORITY } from '@/lib/catalog/paging';

const shown = (value: number | null) => (value === null ? '' : String(value));
/** The typed priority: a whole number 1–9999, null when empty, undefined when it is neither. */
function parse(text: string): number | null | undefined {
  const value = text.trim();
  if (!value) return null;
  if (!/^\d{1,4}$/.test(value)) return undefined;
  const number = Number(value);
  return number >= 1 && number <= MAX_PRIORITY ? number : undefined;
}

/**
 * An administrator's priority on a shared material card (docs/material-order-results-20261027.md):
 * 1 comes first in every list ordered by priority. Enter or leaving the field saves a changed value,
 * an empty field clears it, Escape goes back. One save at a time; a failed save shows the saved value.
 */
export function PriorityInput({
  name,
  value,
  disabled = false,
  onSave,
}: {
  name: string;
  value: number | null;
  disabled?: boolean;
  /** Resolves true when the server saved it. */
  onSave: (value: number | null) => Promise<boolean>;
}) {
  const [text, setText] = useState(shown(value));
  const [wrong, setWrong] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  useEffect(() => setText(shown(value)), [value]);
  async function commit() {
    if (pending.current) return;
    const next = parse(text);
    if (next === undefined) return setWrong(true);
    setWrong(false);
    setText(shown(next));
    if (next === value) return;
    pending.current = true;
    setSaving(true);
    const saved = await onSave(next);
    pending.current = false;
    setSaving(false);
    if (!saved) setText(shown(value));
  }
  return (
    <label className="mt-2.5 flex items-center gap-2 text-[11px] text-[color:var(--muted)]">
      우선순위
      <input
        type="text"
        inputMode="numeric"
        maxLength={4}
        placeholder="없음"
        aria-label={`${name} 우선순위`}
        aria-invalid={wrong || undefined}
        title={
          wrong ? `1~${MAX_PRIORITY} 사이의 숫자를 넣거나 비워 주세요.` : '숫자가 작을수록 목록 앞에 보여요.'
        }
        value={text}
        disabled={disabled || saving}
        onChange={(event) => {
          setText(event.target.value);
          setWrong(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void commit();
          } else if (event.key === 'Escape') {
            setText(shown(value));
            setWrong(false);
          }
        }}
        onBlur={() => void commit()}
        className="h-8 w-16 rounded-[var(--radius-sm)] border border-[color:var(--line)] bg-[color:var(--paper)] px-2 text-[13px] text-[color:var(--ink)] tabular-nums aria-invalid:border-[color:var(--danger)] max-[620px]:h-11 [@media(pointer:coarse)]:h-11"
      />
      {wrong && (
        <span role="alert" className="text-[color:var(--danger)]">
          1~{MAX_PRIORITY}
        </span>
      )}
    </label>
  );
}
