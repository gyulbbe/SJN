'use client';

import { Lightbulb, PanelTop } from 'lucide-react';
import { getEditingScene } from '@/lib/comparison';
import { useEditor } from '@/lib/editor-store';
import { ceilingToolIssue, toggleCeiling, toggleCeilingLight } from '@/lib/smc-ceiling';
import { useEditingCapabilities } from '../editor/editing-capabilities';

/** The SMC ceiling option and, while it is on, its light: an icon in the 2D toolbar, words in the 3D one. */
export function CeilingOptions({ compact }: { compact: boolean }) {
  const st = useEditor();
  const { writable } = useEditingCapabilities();
  const scene = st.project ? getEditingScene(st.project, st.editing) : undefined;
  const issue = ceilingToolIssue({ scene, editing: st.editing, writable, mode: st.mode });
  const ceiling = scene?.ceiling;
  const button = compact ? 'icon-btn' : 'btn small';
  return (
    <>
      <button
        title={issue ?? (ceiling ? 'SMC 천장 없애기' : 'SMC 천장 넣기')}
        aria-label="SMC 천장"
        aria-pressed={!!ceiling}
        data-testid="ceiling-toggle"
        disabled={!!issue}
        className={`${button} ${compact ? '' : 'shrink-0'} ${ceiling ? 'active' : ''}`}
        onClick={() => st.change(toggleCeiling)}
      >
        {compact ? <PanelTop size={17} /> : 'SMC 천장'}
      </button>
      {ceiling && (
        <button
          title={issue ?? (ceiling.light ? '조명 패널과 빛 끄기' : '조명 패널과 빛 켜기')}
          aria-label="조명 패널과 빛"
          aria-pressed={ceiling.light}
          data-testid="ceiling-light"
          disabled={!!issue}
          className={`${button} ${compact ? '' : 'shrink-0'} ${ceiling.light ? 'active' : ''}`}
          onClick={() => st.change(toggleCeilingLight)}
        >
          {compact ? <Lightbulb size={17} /> : '조명'}
        </button>
      )}
    </>
  );
}
