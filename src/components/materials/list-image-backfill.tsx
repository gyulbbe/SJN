'use client';
import { useRef, useState } from 'react';
import { Images } from 'lucide-react';
import { getRepositories } from '@/lib/repositories';
import { saveListImage } from '@/lib/list-images';
import type { ListImagePage } from '@/lib/d1/list-images';

/** Images made at once while the backfill runs (each is read, scaled and uploaded). */
const AT_ONCE = 3;
type Progress = { total: number; checked: number; made: number; failed: string[]; running: boolean };

/**
 * The administrator's one-time backfill (docs/list-thumbnails-results-20261023.md): walks every shared
 * material's card image a page at a time and makes the list images that are missing. It can stop and
 * start again; images that already have one are skipped.
 */
export function ListImageBackfill({ disabled }: { disabled: boolean }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const stop = useRef(false);
  async function run() {
    const repositories = getRepositories();
    const listImages = repositories.materials.listImages;
    if (!listImages) return;
    stop.current = false;
    let state: Progress = { total: 0, checked: 0, made: 0, failed: [], running: true };
    setProgress(state);
    let cursor: string | undefined;
    try {
      do {
        const page = (await listImages({ cursor })) as ListImagePage;
        if (page.total !== undefined) state = { ...state, total: page.total };
        const missing = page.items.filter((item) => !item.listImage);
        state = { ...state, checked: state.checked + page.items.length - missing.length };
        setProgress(state);
        for (let start = 0; start < missing.length && !stop.current; start += AT_ONCE) {
          const results = await Promise.allSettled(
            missing
              .slice(start, start + AT_ONCE)
              .map((item) => saveListImage(repositories.assets, item.imageAssetId)),
          );
          results.forEach((result, index) => {
            const item = missing[start + index];
            state = {
              ...state,
              checked: state.checked + 1,
              made: state.made + (result.status === 'fulfilled' && result.value === 'made' ? 1 : 0),
              failed: result.status === 'rejected' ? [...state.failed, item.name] : state.failed,
            };
          });
          setProgress(state);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor && !stop.current);
    } catch (reason) {
      state = {
        ...state,
        failed: [...state.failed, reason instanceof Error ? reason.message : '목록을 읽지 못했어요.'],
      };
    }
    setProgress({ ...state, running: false });
  }
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="list-image-backfill">
      {progress?.running ? (
        <button type="button" className="btn" onClick={() => (stop.current = true)}>
          멈추기
        </button>
      ) : (
        <button type="button" className="btn" disabled={disabled} onClick={() => void run()}>
          <Images size={16} aria-hidden="true" /> 목록 이미지 만들기
        </button>
      )}
      {progress && (
        <p role="status" aria-live="polite" className="m-0 text-[13px] text-[color:var(--muted)]">
          {progress.running ? '만드는 중 · ' : stop.current ? '멈춤 · ' : '끝 · '}
          확인 {progress.checked.toLocaleString('ko-KR')}
          {progress.total ? ` / ${progress.total.toLocaleString('ko-KR')}` : ''}개, 새로 만듦{' '}
          {progress.made.toLocaleString('ko-KR')}개
          {progress.failed.length
            ? ` · 실패 ${progress.failed.length}개: ${progress.failed.slice(0, 3).join(', ')}`
            : ''}
        </p>
      )}
    </div>
  );
}
