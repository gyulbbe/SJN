'use client';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Image from 'next/image';
import { Check, Copy, Images, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { DesignDocument, MaterialVersion } from '@/lib/types';
import {
  MAX_DESIGNS,
  MAX_COMPARISON_DESIGNS,
  DESIGN_LIMIT_MESSAGE,
  COMPARISON_LIMIT_MESSAGE,
} from '@/lib/designs';
import type { AssetReader } from '@/lib/render/compositor';
import { deleteDesignPreviewCache } from '@/lib/render/design-preview-cache';
import { useDesignThumbnail } from './use-design-preview';
import styles from './designs.module.css';

type Action = void | Promise<unknown>;
export type DesignManagerProps = {
  projectId: string;
  sharedRevision: number;
  designs: DesignDocument[];
  activeDesignId: string | null;
  comparisonDesignIds: string[];
  materials: Record<string, MaterialVersion>;
  assetReader: AssetReader;
  writable: boolean;
  onCreate: (name?: string) => Action;
  onDuplicate: (id: string) => Action;
  onRename: (id: string, name: string) => Action;
  onDelete: (id: string) => Action;
  onActivate: (id: string) => Action;
  onToggleComparison: (id: string) => Action;
  onCompare: () => void;
  onClose: () => void;
};
export function trapDesignDialog(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return;
  const targets = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, a[href], [tabindex="0"]'),
  ].filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
  if (!targets.length) {
    event.preventDefault();
    return;
  }
  const first = targets[0],
    last = targets[targets.length - 1];
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === event.currentTarget)
  ) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
function Thumbnail({
  design,
  ...props
}: Pick<DesignManagerProps, 'projectId' | 'sharedRevision' | 'materials' | 'assetReader'> & {
  design: DesignDocument;
}) {
  const preview = useDesignThumbnail({ ...props, design });
  return (
    <div
      className={styles.thumbnail}
      style={{ aspectRatio: `${design.scene.imageWidth}/${design.scene.imageHeight}` }}
    >
      {preview.url && (
        <Image
          unoptimized
          src={preview.url}
          alt={`${design.name} 미리보기`}
          width={360}
          height={Math.round((360 * design.scene.imageHeight) / design.scene.imageWidth)}
        />
      )}
      {!preview.url && <Images size={28} aria-hidden />}
      {preview.status === 'loading' && <span className={styles.previewState}>이미지 준비 중…</span>}
      {preview.status === 'error' && (
        <span className={styles.previewState}>미리보기를 불러오지 못했어요</span>
      )}
    </div>
  );
}
export default function DesignManager(props: DesignManagerProps) {
  const { designs, activeDesignId, comparisonDesignIds, writable, onClose } = props;
  const container = useRef<HTMLElement>(null),
    nameInput = useRef<HTMLInputElement>(null),
    confirmCancel = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null),
    [name, setName] = useState('');
  const [deleting, setDeleting] = useState<DesignDocument | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    container.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (renaming) {
      nameInput.current?.focus();
      nameInput.current?.select();
    }
  }, [renaming]);
  useEffect(() => {
    if (deleting) confirmCancel.current?.focus();
  }, [deleting]);
  async function act(callback: () => Action) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await callback();
    } catch (error) {
      setError(error instanceof Error ? error.message : '시안을 변경하지 못했어요. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }
  const selectedCount = designs.filter((design) => comparisonDesignIds.includes(design.id)).length;
  return (
    <div className={styles.backdrop}>
      <section
        className={styles.manager}
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-labelledby="design-manager-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          trapDesignDialog(event);
          if (event.key === 'Escape') {
            event.preventDefault();
            if (deleting) setDeleting(null);
            else if (renaming) setRenaming(null);
            else onClose();
          }
        }}
      >
        <header className={styles.modalHeader}>
          <div>
            <h2 id="design-manager-title">
              시안 관리{' '}
              <span>
                {designs.length}/{MAX_DESIGNS}
              </span>
            </h2>
            <p>같은 공간에 여러 자재와 제품을 놓고 비교해 보세요.</p>
          </div>
          <button className={styles.iconButton} aria-label="시안 관리 닫기" onClick={onClose}>
            <X size={21} />
          </button>
        </header>
        <div className={styles.managerTools}>
          <span>
            {activeDesignId ? (
              <>
                <span className={styles.dot} />{' '}
                <b>{designs.find((design) => design.id === activeDesignId)?.name}</b> 편집 중
              </>
            ) : (
              '기본 공간을 편집 중이에요.'
            )}
          </span>
          <button
            className={styles.primaryButton}
            disabled={!writable || busy || designs.length >= MAX_DESIGNS}
            onClick={() => void act(() => props.onCreate())}
          >
            <Plus size={16} />새 시안
          </button>
        </div>
        {designs.length >= MAX_DESIGNS && (
          <div className={styles.limitNotice} role="status">
            {DESIGN_LIMIT_MESSAGE}
          </div>
        )}
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        <div className={styles.managerBody}>
          {!designs.length ? (
            <div className={styles.empty}>
              <Images size={36} />
              <h3>첫 번째 시안을 만들어 보세요</h3>
              <p>자재와 도기를 바꿔도 기본 공간은 유지돼요.</p>
            </div>
          ) : (
            <div className={styles.designList}>
              {designs.map((design) => {
                const selected = comparisonDesignIds.includes(design.id),
                  active = activeDesignId === design.id;
                return (
                  <article
                    className={`${styles.designCard} ${active ? styles.activeCard : ''}`}
                    key={design.id}
                    data-testid="design-card"
                    data-design-id={design.id}
                  >
                    <button
                      className={styles.thumbnailButton}
                      aria-label={`${design.name} ${writable ? '편집하기' : '열기'}`}
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await props.onActivate(design.id);
                          onClose();
                        })
                      }
                    >
                      <Thumbnail
                        projectId={props.projectId}
                        sharedRevision={props.sharedRevision}
                        materials={props.materials}
                        assetReader={props.assetReader}
                        design={design}
                      />
                      {active && <span className={styles.activeBadge}>현재 편집 중</span>}
                    </button>
                    <div className={styles.cardBody}>
                      {renaming === design.id ? (
                        <form
                          className={styles.nameForm}
                          onSubmit={(event) => {
                            event.preventDefault();
                            const value = name.trim();
                            if (!value) {
                              setError('시안 이름을 입력해 주세요.');
                              return;
                            }
                            void act(async () => {
                              await props.onRename(design.id, value);
                              setRenaming(null);
                            });
                          }}
                        >
                          <input
                            ref={nameInput}
                            aria-label="새 시안 이름"
                            value={name}
                            maxLength={100}
                            disabled={busy}
                            onChange={(event) => setName(event.target.value)}
                          />
                          <button
                            className={styles.iconButton}
                            aria-label="시안 이름 저장"
                            disabled={busy || !name.trim()}
                          >
                            <Check size={17} />
                          </button>
                          <button
                            type="button"
                            className={styles.iconButton}
                            aria-label="시안 이름 변경 취소"
                            onClick={() => setRenaming(null)}
                          >
                            <X size={17} />
                          </button>
                        </form>
                      ) : (
                        <div className={styles.cardTitle}>
                          <h3>{design.name}</h3>
                          <button
                            className={styles.iconButton}
                            aria-label={`${design.name} 이름 변경`}
                            disabled={!writable || busy}
                            onClick={() => {
                              setName(design.name);
                              setRenaming(design.id);
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                        </div>
                      )}
                      <div className={styles.cardActions}>
                        <label
                          className={styles.compareCheck}
                          title={
                            !selected && selectedCount >= MAX_COMPARISON_DESIGNS
                              ? COMPARISON_LIMIT_MESSAGE
                              : undefined
                          }
                        >
                          <input
                            type="checkbox"
                            aria-label={`${design.name} 비교 선택`}
                            checked={selected}
                            disabled={busy}
                            onChange={() => void act(() => props.onToggleComparison(design.id))}
                          />
                          비교
                        </label>
                        <div>
                          <button
                            className={styles.iconButton}
                            aria-label={`${design.name} 복제`}
                            title="복제"
                            disabled={!writable || busy || designs.length >= MAX_DESIGNS}
                            onClick={() => void act(() => props.onDuplicate(design.id))}
                          >
                            <Copy size={16} />
                          </button>
                          <button
                            className={styles.iconButton}
                            aria-label={`${design.name} 삭제`}
                            title="시안 삭제"
                            disabled={!writable || busy}
                            onClick={() => setDeleting(design)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
        <footer className={styles.managerFooter}>
          <p>
            <b>
              비교 선택 {selectedCount}/{MAX_COMPARISON_DESIGNS}
            </b>
            <span>2개 이상 선택하면 나란히 볼 수 있어요.</span>
          </p>
          <button
            className={styles.primaryButton}
            disabled={selectedCount < 2 || busy}
            onClick={() => {
              props.onCompare();
            }}
          >
            선택한 시안 비교 <Images size={16} />
          </button>
        </footer>
        {deleting && (
          <div className={styles.confirmBackdrop}>
            <section
              className={styles.confirm}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-design-title"
              data-design-confirm
              onKeyDown={(event) => {
                event.stopPropagation();
                trapDesignDialog(event);
                if (event.key === 'Escape') setDeleting(null);
              }}
            >
              <h3 id="delete-design-title">이 시안을 삭제할까요?</h3>
              <p>
                <b>{deleting.name}</b>의 자재 배치와 편집 기록을 삭제해요. 다른 시안과 기본 공간은 유지돼요.
              </p>
              <div>
                <button
                  ref={confirmCancel}
                  className={styles.secondaryButton}
                  disabled={busy}
                  onClick={() => setDeleting(null)}
                >
                  취소
                </button>
                <button
                  className={styles.dangerButton}
                  disabled={busy || !writable}
                  onClick={() =>
                    void act(async () => {
                      await props.onDelete(deleting.id);
                      await deleteDesignPreviewCache(props.projectId, deleting.id);
                      setDeleting(null);
                    })
                  }
                >
                  {busy ? '삭제 중…' : '시안 삭제'}
                </button>
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
