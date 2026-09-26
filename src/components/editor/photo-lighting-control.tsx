'use client';

import { useRef, useState } from 'react';
import { useEditor } from '@/lib/editor-store';
import { Range } from './inspector';

/**
 * "사진 조명 맞춤" for a comparison made from a photo: the renders take the photo's brightness and
 * colour temperature (PhotoLighting), on by default. Off shows the materials' own colours under
 * neutral light. Both sides of the comparison, every design and every render path follow it.
 */
export default function PhotoLightingControl() {
  const lighting = useEditor((state) => state.project?.shared.comparison?.photoLighting);
  const [draft, setDraft] = useState<number | null>(null);
  // Typing a value commits in the same event as the change, before state catches up.
  const pending = useRef<number | null>(null);
  if (!lighting) return null;
  const percent = draft ?? Math.round(lighting.strength * 100);
  const change = (fn: (value: NonNullable<typeof lighting>) => void) =>
    useEditor.getState().changeProject((project) => {
      const target = project.shared.comparison?.photoLighting;
      if (target) fn(target);
    });
  return (
    <div className="mb-4 rounded-[var(--radius-sm,8px)] border border-[color:var(--line)] px-3 py-2.5">
      <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-semibold text-[color:var(--ink)]">
        사진 조명 맞춤
        <input
          type="checkbox"
          aria-label="사진 조명 맞춤"
          checked={lighting.enabled}
          onChange={(event) => {
            const enabled = event.target.checked;
            change((value) => (value.enabled = enabled));
          }}
        />
      </label>
      <div className="mt-1 text-xs leading-relaxed text-[color:var(--muted)]">
        {lighting.enabled
          ? '원본 사진의 밝기·색온도에 맞춘 화면이에요. 자재 본래 색은 끄고 확인하세요.'
          : '자재 본래 색을 중립 조명으로 보여 줘요.'}
      </div>
      {lighting.enabled && (
        <div className="mt-2">
          <Range
            label="맞춤 세기"
            value={percent}
            min={0}
            max={100}
            step={1}
            unit="%"
            onChange={(value) => {
              pending.current = value;
              setDraft(value);
            }}
            onCommit={() => {
              const value = pending.current;
              pending.current = null;
              setDraft(null);
              if (value === null) return;
              const strength = Math.max(0, Math.min(1, value / 100));
              if (strength !== lighting.strength) change((value) => (value.strength = strength));
            }}
          />
        </div>
      )}
    </div>
  );
}
