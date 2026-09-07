'use client';
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { ArrowLeft, Download, Expand, Maximize, Minus, Plus, X } from 'lucide-react';
import type { DesignDocument, MaterialVersion } from '@/lib/types';
import type { AssetReader } from '@/lib/render/compositor';
import { MAX_COMPARISON_DESIGNS } from '@/lib/designs';
import {
  acquireDesignPreviewSession,
  DesignPreviewCancelled,
  designGrid,
  type DesignPreviewInput,
} from '@/lib/render/design-preview';
import {
  comparisonPreviewEdge,
  fittedDesignView,
  fitDesignBox,
  panDesignView,
  zoomDesignView,
  type DesignView,
} from '@/lib/render/design-comparison-view';
import { useDesignPreview } from './use-design-preview';
import styles from './designs.module.css';
import { calculateMaterialUsage } from '@/lib/material-usage';
import MaterialUsagePanel from '@/components/materials/material-usage-panel';

export type DesignComparisonProps = {
  projectId: string;
  sharedRevision: number;
  designs: DesignDocument[];
  materials: Record<string, MaterialVersion>;
  assetReader: AssetReader;
  writable: boolean;
  onEdit: (id: string) => void;
  onExclude: (id: string) => void;
  onClose: () => void;
  onAddDesigns?: () => void;
};
type CardProps = Pick<
  DesignComparisonProps,
  'projectId' | 'sharedRevision' | 'materials' | 'assetReader' | 'writable' | 'onEdit' | 'onExclude'
> & {
  design: DesignDocument;
  view: DesignView;
  onView: (view: DesignView) => void;
  onFocus: () => void;
  onDownload: () => void;
  downloading: boolean;
  onShowUsage: () => void;
};
const PreviewImage = memo(function PreviewImage({ url, design }: { url: string; design: DesignDocument }) {
  return (
    <Image
      unoptimized
      src={url}
      alt={design.name + ' After'}
      width={design.scene.imageWidth}
      height={design.scene.imageHeight}
      draggable={false}
    />
  );
});
function ComparisonCard({
  design,
  view,
  onView,
  onFocus,
  onDownload,
  downloading,
  onShowUsage,
  ...props
}: CardProps) {
  const usage = useMemo(
    () => calculateMaterialUsage(design.scene, props.materials, design.materialUsage, design.quote),
    [design.scene, design.materialUsage, design.quote, props.materials],
  );
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; view: DesignView } | null>(null);
  const [box, setBox] = useState({ width: 640, height: 480, dpr: 1 });
  const aspect = design.scene.imageWidth / design.scene.imageHeight;
  const fit = fitDesignBox(box.width, box.height, aspect);
  const preview = useDesignPreview({
    ...props,
    design,
    purpose: 'comparison',
    edge: comparisonPreviewEdge(fit.width, fit.height, 1, box.dpr),
    delayMs: 160,
  });
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setBox({ width: rect.width, height: rect.height, dpr: window.devicePixelRatio });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);
  // A non-passive wheel listener keeps zoom input inside this viewport, including trackpads.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      onFocus();
      const rect = element.getBoundingClientRect();
      const anchor = {
        x: 0.5 + (event.clientX - rect.left - rect.width / 2) / fit.width,
        y: 0.5 + (event.clientY - rect.top - rect.height / 2) / fit.height,
      };
      onView(
        zoomDesignView(
          view,
          view.zoom * Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.002),
          anchor,
        ),
      );
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [view, fit.width, fit.height, onView, onFocus]);
  return (
    <article className={styles.comparisonCard} data-testid="comparison-card" data-design-id={design.id}>
      <header className={styles.comparisonCardHeader}>
        <h3>{design.name}</h3>
        <div>
          <button className={styles.textButton} onClick={() => props.onEdit(design.id)}>
            {props.writable ? '이 시안 편집' : '열기'}
          </button>
          <button
            className={styles.iconButton}
            aria-label={`${design.name} 비교에서 제외`}
            title="비교에서 제외"
            onClick={() => props.onExclude(design.id)}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <div
        ref={viewport}
        className={styles.viewport}
        tabIndex={0}
        role="group"
        aria-label={`${design.name} 이미지 확대 및 이동`}
        data-testid="comparison-viewport"
        data-zoom={view.zoom}
        data-center-x={view.center.x}
        data-center-y={view.center.y}
        onFocus={onFocus}
        onKeyDown={(event) => {
          const step = 0.08;
          if (event.key === '+' || event.key === '=') {
            event.preventDefault();
            onView(zoomDesignView(view, view.zoom * 1.25));
          } else if (event.key === '-') {
            event.preventDefault();
            onView(zoomDesignView(view, view.zoom / 1.25));
          } else if (event.key === '0') {
            event.preventDefault();
            onView(fittedDesignView());
          } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            onView(
              panDesignView(
                view,
                (event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0) * fit.width * step,
                (event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0) * fit.height * step,
                fit.width,
                fit.height,
              ),
            );
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          onFocus();
          drag.current = { x: event.clientX, y: event.clientY, view };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          onView(
            panDesignView(
              drag.current.view,
              event.clientX - drag.current.x,
              event.clientY - drag.current.y,
              fit.width,
              fit.height,
            ),
          );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        {preview.url && (
          <div
            className={styles.imagePlane}
            style={{
              width: fit.width,
              height: fit.height,
              transform: `translate3d(calc(-50% + ${(0.5 - view.center.x) * fit.width * view.zoom}px), calc(-50% + ${(0.5 - view.center.y) * fit.height * view.zoom}px), 0) scale(${view.zoom})`,
            }}
          >
            <PreviewImage url={preview.url} design={design} />
          </div>
        )}
        {preview.status === 'loading' && (
          <span className={styles.previewState} role="status">
            {preview.url ? '선명한 이미지 준비 중…' : '시안 이미지 준비 중…'}
          </span>
        )}
        {preview.status === 'error' && (
          <div className={styles.previewError} role="alert">
            <p>{preview.error}</p>
            <button
              className={styles.secondaryButton}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={preview.retry}
            >
              다시 시도
            </button>
          </div>
        )}
      </div>
      <div className={styles.costSummary} data-testid="comparison-usage-summary">
        <div>
          <span>{usage.complete ? '예상 자재비 합계' : '확인된 자재비'}</span>
          <strong>{usage.total.toLocaleString('ko-KR')}원</strong>
          {!usage.complete && (
            <small>
              미계산 {usage.unresolvedCount}종 · 면적·포장 확인 {usage.attentionCount}종
            </small>
          )}
        </div>
        <button className={styles.textButton} aria-label={`${design.name} 자재 보기`} onClick={onShowUsage}>
          자재 보기
        </button>
      </div>
      <footer className={styles.comparisonCardFooter}>
        <div>
          <button
            className={styles.iconButton}
            aria-label={`${design.name} 축소`}
            onClick={() => {
              onFocus();
              onView(zoomDesignView(view, view.zoom / 1.25));
            }}
            disabled={view.zoom <= 1}
          >
            <Minus size={15} />
          </button>
          <span>{Math.round(view.zoom * 100)}%</span>
          <button
            className={styles.iconButton}
            aria-label={`${design.name} 확대`}
            onClick={() => {
              onFocus();
              onView(zoomDesignView(view, view.zoom * 1.25));
            }}
            disabled={view.zoom >= 5}
          >
            <Plus size={15} />
          </button>
          <button
            className={styles.iconButton}
            aria-label={`${design.name} 화면 맞춤`}
            title="화면 맞춤"
            onClick={() => {
              onFocus();
              onView(fittedDesignView());
            }}
          >
            <Maximize size={15} />
          </button>
        </div>
        <button
          className={styles.textButton}
          disabled={downloading}
          onClick={onDownload}
          aria-label={`${design.name} PNG 다운로드`}
        >
          <Download size={14} />
          {downloading ? '이미지 만드는 중…' : 'PNG'}
        </button>
      </footer>
    </article>
  );
}
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name.replace(/[<>:"/\\|?*]/g, '-');
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function DesignComparison(props: DesignComparisonProps) {
  const exportSession = useRef<ReturnType<typeof acquireDesignPreviewSession> | null>(null);
  const container = useRef<HTMLElement>(null),
    alive = useRef(true),
    exportChannel = useId();
  const [sync, setSync] = useState(true),
    [sharedView, setSharedView] = useState(fittedDesignView);
  const [views, setViews] = useState<Record<string, DesignView>>({}),
    [focusedId, setFocusedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null),
    [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [detailDesignId, setDetailDesignId] = useState<string | null>(null);
  const detailDesign = props.designs.find((design) => design.id === detailDesignId);
  const designs = props.designs.slice(0, MAX_COMPARISON_DESIGNS);
  const grid = designGrid(Math.max(1, designs.length));
  const activeView = sync ? sharedView : (views[focusedId ?? designs[0]?.id] ?? fittedDesignView());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      exportSession.current?.service.cancel(exportChannel);
      exportSession.current?.release();
      exportSession.current = null;
    };
  }, [exportChannel]);
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  function updateView(id: string, view: DesignView) {
    setFocusedId(id);
    if (sync) setSharedView(view);
    else setViews((previous) => ({ ...previous, [id]: view }));
  }
  function toggleSync(value: boolean) {
    if (value) setSharedView(activeView);
    else setViews(Object.fromEntries(designs.map((design) => [design.id, sharedView])));
    setSync(value);
  }
  const input = (design: DesignDocument): DesignPreviewInput => ({
    projectId: props.projectId,
    sharedRevision: props.sharedRevision,
    design,
    materials: props.materials,
  });
  async function exportImage(design?: DesignDocument) {
    if (exporting) return;
    const session = acquireDesignPreviewSession(props.projectId, props.assetReader);
    exportSession.current = session;
    setExporting(design?.id ?? 'all');
    setError('');
    try {
      const blob = design
        ? await session.service.exportDesign(exportChannel, input(design))
        : await session.service.exportComparison(exportChannel, designs.map(input));
      if (alive.current) downloadBlob(blob, design ? `${design.name}.png` : '공간미리-시안비교.png');
    } catch (error) {
      if (alive.current && !(error instanceof DesignPreviewCancelled))
        setError(error instanceof Error ? error.message : '이미지를 내보내지 못했어요.');
    } finally {
      session.release();
      if (exportSession.current === session) exportSession.current = null;
      if (alive.current) setExporting(null);
    }
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === container.current) await document.exitFullscreen();
      else if (container.current?.requestFullscreen) await container.current.requestFullscreen();
      else setError('이 브라우저에서는 전체 화면을 지원하지 않아요.');
    } catch {
      setError('전체 화면을 열지 못했어요. 브라우저 설정을 확인해 주세요.');
    }
  }
  return (
    <section
      ref={container}
      className={styles.comparison}
      aria-label="시안 나란히 비교"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !document.fullscreenElement) props.onClose();
      }}
    >
      <header className={styles.comparisonToolbar}>
        <div>
          <button className={styles.secondaryButton} onClick={props.onClose}>
            <ArrowLeft size={16} />
            편집으로 돌아가기
          </button>
          <h2>
            시안 비교{' '}
            <span>
              {designs.length}/{MAX_COMPARISON_DESIGNS}
            </span>
          </h2>
        </div>
        <div>
          <label className={styles.compareCheck}>
            <input type="checkbox" checked={sync} onChange={(event) => toggleSync(event.target.checked)} />
            확대·이동 동기화
          </label>
          <button
            className={styles.secondaryButton}
            onClick={() => {
              setSharedView(fittedDesignView());
              setViews({});
            }}
          >
            <Maximize size={16} />
            모두 화면 맞춤
          </button>
          <button
            className={styles.iconButton}
            aria-label={fullscreen ? '전체 화면 종료' : '비교 전체 화면'}
            onClick={() => void toggleFullscreen()}
          >
            <Expand size={18} />
          </button>
          <button
            className={styles.primaryButton}
            disabled={!!exporting || designs.length < 2}
            onClick={() => void exportImage()}
          >
            <Download size={16} />
            {exporting === 'all' ? '비교 이미지 만드는 중…' : '비교 PNG'}
          </button>
        </div>
      </header>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={styles.comparisonHint}>
        <p>
          각 시안의 After를 같은 각도로 비교해요. 드래그로 이동하고 휠로 확대하세요. PNG에는 공간 전체가
          담겨요.
        </p>
        {props.onAddDesigns && (
          <button className={styles.textButton} onClick={props.onAddDesigns}>
            <Plus size={14} />
            비교할 시안 선택
          </button>
        )}
      </div>
      {designs.length < 2 && (
        <div className={styles.limitNotice}>시안을 2개 이상 선택하면 나란히 비교할 수 있어요.</div>
      )}
      <div className={styles.comparisonBody}>
        <div
          className={styles.comparisonGrid}
          data-count={designs.length}
          style={{ '--design-columns': grid.columns, '--design-rows': grid.rows } as React.CSSProperties}
        >
          {designs.map((design) => (
            <ComparisonCard
              key={design.id}
              {...props}
              design={design}
              view={sync ? sharedView : (views[design.id] ?? fittedDesignView())}
              onView={(view) => updateView(design.id, view)}
              onFocus={() => setFocusedId(design.id)}
              onDownload={() => void exportImage(design)}
              downloading={!!exporting}
              onShowUsage={() => setDetailDesignId(design.id)}
            />
          ))}
          {!designs.length && (
            <div className={styles.empty}>
              <h3>비교할 시안을 선택해 주세요</h3>
              {props.onAddDesigns && (
                <button className={styles.primaryButton} onClick={props.onAddDesigns}>
                  시안 선택
                </button>
              )}
            </div>
          )}
        </div>
        {detailDesign && (
          <div className={styles.usageDetail} data-testid="comparison-usage-detail">
            <MaterialUsagePanel
              key={detailDesign.id}
              design={detailDesign}
              materials={props.materials}
              assetReader={props.assetReader}
              writable={false}
              onEdit={props.writable ? () => props.onEdit(detailDesign.id) : undefined}
              onClose={() => setDetailDesignId(null)}
            />
          </div>
        )}
      </div>
    </section>
  );
}
