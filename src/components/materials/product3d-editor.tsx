'use client';
import { useEffect, useRef, useState } from 'react';
import { getRepositories } from '@/lib/repositories';
import type { MaterialVersion } from '@/lib/types';
import { MAX_PRODUCT_VIEWS, MAX_PRODUCT_VIEW_NAME } from '@/lib/product3d/apply';
import { AssetImage } from './asset-image';
import { AngleNameInput } from './angle-name-input';
import type { Product3dReference, ProductPose } from '@/lib/product3d/state-types';
import type {
  Product3dApplication,
  Product3dProgress,
  Product3dResult,
  ProductInput,
} from '@/lib/product3d/types';
import type { Product3dClient } from '@/lib/product3d/client';
import { decodeProductMesh } from '@/lib/product3d/codec';
import { resolveProductInput } from '@/lib/product3d/source';
import { createDefaultPose } from '@/lib/product3d/pose';
import { Product3dViewport, type ProductViewportHandle } from './product3d-viewport';
import styles from './product3d-editor.module.css';
const seconds = (value: number) => `${(value / 1000).toFixed(2)}초`;
function nextAngleName(names: string[]) {
  const taken = new Set(names);
  let index = 1;
  while (taken.has(`각도 ${index}`)) index++;
  return `각도 ${index}`;
}
function validateAngleName(name: string) {
  const value = name.trim();
  if (!value) throw new Error('각도 이름을 입력해 주세요.');
  if (value.length > MAX_PRODUCT_VIEW_NAME)
    throw new Error(`각도 이름은 ${MAX_PRODUCT_VIEW_NAME}자까지 입력할 수 있어요.`);
  return value;
}
export function Product3dEditor({
  assetId,
  inputSourceAssetId,
  product3d,
  views,
  selectedViewIndex,
  onSelectView,
  onRenameView,
  onDeleteView,
  blob,
  canApply = true,
  onApply,
  onClose,
  onRemoveBackground,
}: {
  assetId: string;
  inputSourceAssetId?: string;
  product3d?: Product3dReference;
  views: MaterialVersion['views'];
  selectedViewIndex: number;
  onSelectView: (index: number) => void;
  onRenameView: (index: number, name: string) => void;
  onDeleteView: (index: number) => void;
  blob?: Blob;
  canApply?: boolean;
  onApply: (result: Product3dApplication, mode: 'add' | 'replace', name: string) => Promise<void>;
  onClose: () => void;
  onRemoveBackground: (assetId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    viewport = useRef<ProductViewportHandle>(null),
    client = useRef<Product3dClient | null>(null);
  const generation = useRef(0),
    alive = useRef(true),
    operation = useRef(false);
  const [input, setInput] = useState<ProductInput>(),
    [sourceUrl, setSourceUrl] = useState(''),
    [loading, setLoading] = useState(true);
  const [result, setResult] = useState<Product3dResult>(),
    [initialPose, setInitialPose] = useState<ProductPose>(() => createDefaultPose());
  const [meshAssetId, setMeshAssetId] = useState<string>(),
    [progress, setProgress] = useState<Product3dProgress>();
  const [busy, setBusy] = useState(false),
    [applying, setApplying] = useState(false),
    [capturing, setCapturing] = useState(false);
  const [error, setError] = useState(''),
    [sourceError, setSourceError] = useState(''),
    [viewerError, setViewerError] = useState('');
  const [newAngleName, setNewAngleName] = useState(() => nextAngleName(views.map((view) => view.direction)));
  const [nameError, setNameError] = useState('');
  const [renaming, setRenaming] = useState(false),
    [renameName, setRenameName] = useState('');
  const [notice, setNotice] = useState('');
  const selectedView = views[selectedViewIndex];
  const locked = loading || busy || applying || capturing;
  const latestPose = useRef<ProductPose>(createDefaultPose());
  const [attempt, setAttempt] = useState(0),
    [viewerKey, setViewerKey] = useState(0),
    [stored, setStored] = useState(false);
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    return () => {
      alive.current = false;
      client.current?.dispose();
    };
  }, []);
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    setLoading(true);
    setError('');
    setSourceError('');
    setViewerError('');
    setSourceUrl('');
    setMeshAssetId(undefined);
    setRenaming(false);
    setNameError('');
    setInput(undefined);
    setResult(undefined);
    setStored(false);
    void (async () => {
      const repositories = getRepositories();
      let source: ProductInput;
      try {
        source = await resolveProductInput(
          inputSourceAssetId ?? assetId,
          blob ? undefined : product3d,
          blob,
          repositories.assets,
        );
      } catch (reason) {
        if (active)
          setSourceError(reason instanceof Error ? reason.message : '제품 사진을 불러오지 못했어요.');
        return;
      }
      if (!active) return;
      url = URL.createObjectURL(source.blob);
      setSourceUrl(url);
      setInput(source);
      if (product3d && !blob) {
        try {
          const asset = await repositories.assets.get(product3d.meshAssetId);
          if (asset.kind !== 'product-mesh' || asset.sourceAssetId !== product3d.inputAssetId)
            throw new Error('저장된 입체 형상 종류가 올바르지 않아요.');
          const mesh = await decodeProductMesh(asset.blob);
          if (!active) return;
          latestPose.current = structuredClone(product3d.pose);
          setInitialPose(structuredClone(product3d.pose));
          setMeshAssetId(asset.id);
          setStored(true);
          setResult({
            mesh,
            timings: {
              modelId: product3d.modelId,
              modelRevision: product3d.modelRevision,
              downloadMs: 0,
              initializationMs: 0,
              processingMs: 0,
              cacheSource: 'cache',
            },
          });
        } catch (reason) {
          if (active)
            setError(
              `저장된 입체 데이터를 열지 못했어요. ${reason instanceof Error ? reason.message : ''} 아래에서 다시 입체화할 수 있어요.`,
            );
        }
      }
    })().finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [assetId, inputSourceAssetId, product3d, blob, attempt, selectedViewIndex]);
  const close = () => {
    if (operation.current) return;
    generation.current++;
    client.current?.dispose();
    onClose();
  };
  const cancel = () => {
    generation.current++;
    client.current?.dispose();
    client.current = null;
    setBusy(false);
    setProgress(undefined);
  };
  const generate = async () => {
    if (!input || busy || operation.current) return;
    const run = ++generation.current;
    client.current?.dispose();
    setBusy(true);
    setError('');
    setViewerError('');
    setProgress(undefined);
    try {
      const { Product3dClient: Client } = await import('@/lib/product3d/client');
      if (!alive.current || run !== generation.current) return;
      const activeClient = new Client();
      client.current = activeClient;
      const next = await activeClient.run(input.blob, (p) => {
        if (alive.current && run === generation.current) setProgress(p);
      });
      if (!alive.current || run !== generation.current) return;
      setMeshAssetId(undefined);
      latestPose.current = createDefaultPose();
      setInitialPose(createDefaultPose());
      setStored(false);
      setViewerKey((k) => k + 1);
      setResult(next);
    } catch (reason) {
      if (alive.current && run === generation.current)
        setError(reason instanceof Error ? reason.message : '입체화에 실패했어요.');
    } finally {
      if (alive.current && run === generation.current) setBusy(false);
    }
  };
  const download = async () => {
    if (!viewport.current || !input || operation.current || busy) return;
    operation.current = true;
    setCapturing(true);
    setError('');
    try {
      const capture = await viewport.current.capture();
      if (!alive.current) return;
      const url = URL.createObjectURL(capture.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${input.name.replace(/\.[^/.]+$/, '')}_360.png`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : 'PNG를 만들지 못했어요.');
    } finally {
      operation.current = false;
      if (alive.current) setCapturing(false);
    }
  };
  const apply = async (mode: 'add' | 'replace') => {
    if (!viewport.current || !result || !input || busy || operation.current || !canApply) return;
    if (mode === 'replace' && !selectedView) return;
    let name: string;
    try {
      name = validateAngleName(mode === 'add' ? newAngleName : selectedView.direction);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '각도 이름을 확인해 주세요.';
      if (mode === 'add') setNameError(message);
      else setError(message);
      return;
    }
    operation.current = true;
    setApplying(true);
    setError('');
    setNameError('');
    setNotice('');
    try {
      const pose = viewport.current.getPose();
      const capture = await viewport.current.capture();
      await onApply(
        {
          capture,
          pose,
          mesh: result.mesh,
          meshAssetId,
          input,
          modelId: result.timings.modelId,
          modelRevision: result.timings.modelRevision,
        },
        mode,
        name,
      );
      if (alive.current) {
        setNotice(
          mode === 'add'
            ? `“${name}” 각도를 추가했어요. 이어서 다른 각도를 만들 수 있어요.`
            : `“${name}” 각도를 수정했어요.`,
        );
        if (mode === 'add') setNewAngleName(nextAngleName([...views.map((view) => view.direction), name]));
      }
    } catch (reason) {
      if (alive.current)
        setError(
          `각도 사진을 ${mode === 'add' ? '추가' : '수정'}하지 않았어요. ${reason instanceof Error ? reason.message : '저장에 실패했어요.'} 결과는 유지되므로 다시 시도할 수 있어요.`,
        );
    } finally {
      operation.current = false;
      if (alive.current) setApplying(false);
    }
  };
  const changeView = (index: number) => {
    if (locked || index === selectedViewIndex) return;
    setNotice('');
    setNameError('');
    setRenaming(false);
    onSelectView(index);
  };
  const saveName = () => {
    if (locked || !canApply || !selectedView) return;
    try {
      const value = validateAngleName(renameName);
      onRenameView(selectedViewIndex, value);
      setRenaming(false);
      setNameError('');
      setNotice(`각도 이름을 “${value}”로 바꿨어요.`);
    } catch (reason) {
      setNameError(reason instanceof Error ? reason.message : '이름을 변경하지 못했어요.');
    }
  };
  const deleteView = () => {
    if (locked || !canApply || !selectedView) return;
    if (!window.confirm(`“${selectedView.direction}” 각도 사진을 삭제할까요?`)) return;
    try {
      onDeleteView(selectedViewIndex);
      setRenaming(false);
      setNameError('');
      setNotice('선택한 각도 사진을 삭제했어요.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '각도 사진을 삭제하지 못했어요.');
    }
  };
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="product3d-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className={styles.header}>
        <div>
          <h2 id="product3d-title">360° 제품 편집</h2>
          <p>입체 제품을 돌려 보고, 원하는 각도를 여러 장 저장해 사용해요.</p>
        </div>
        <button type="button" className="btn" disabled={applying || capturing} onClick={close}>
          {busy ? '취소하고 닫기' : '닫기'}
        </button>
      </header>
      <div className={styles.content}>
        {notice && (
          <p className={styles.savedNotice} role="status">
            {notice}
          </p>
        )}
        <section className={styles.setup}>
          <div className={styles.source}>
            {sourceUrl ? (
              <img src={sourceUrl} alt="입체화에 사용할 원본 제품 사진" data-testid="product3d-source" />
            ) : (
              <span>사진 준비 중…</span>
            )}
          </div>
          <div>
            <strong>{stored ? '저장된 입체 데이터를 열었어요' : '제품 사진을 입체로 만들어요'}</strong>
            <p className={styles.note}>
              {stored
                ? 'AI 재실행 없이 저장한 시점과 기울기를 이어서 조절할 수 있어요.'
                : '배경을 제거한 제품 사진을 사용해요. 생성이 끝나면 마우스로 자유롭게 돌릴 수 있어요.'}
            </p>
            {!stored && (
              <div className={styles.requirements}>
                <p className={styles.note}>
                  처음 실행 시 모델 약 840MB를 받으며 기존 캐시를 재사용해요. GPU를 우선 사용하고 실행이
                  어려우면 같은 모델로 CPU 처리를 시도해요. 기기에 따라 수 분과 많은 메모리가 필요할 수
                  있어요.
                </p>
                <p className={styles.note}>사진은 이 브라우저에서 처리해요.</p>
              </div>
            )}
            <div className={styles.toolbar}>
              <button
                type="button"
                className="btn primary"
                onClick={generate}
                disabled={loading || busy || applying || capturing || !input}
              >
                {busy ? '입체화 중…' : result ? '다시 입체화' : '입체화 시작'}
              </button>
              {input && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy || applying || capturing}
                  onClick={() => onRemoveBackground(input.existingAssetId ?? input.sourceAssetId)}
                >
                  원본 배경 제거
                </button>
              )}
            </div>
          </div>
        </section>
        {loading && <p role="status">저장한 사진과 입체 데이터를 불러오고 있어요…</p>}
        {sourceError && (
          <div role="alert" className={styles.error}>
            <p>{sourceError}</p>
            <button className="btn" type="button" onClick={() => setAttempt((v) => v + 1)}>
              사진 다시 불러오기
            </button>
          </div>
        )}
        {busy && (
          <div className={styles.status} role="status">
            <strong>{progress?.message ?? '입체화 실행 모듈을 준비하고 있어요.'}</strong>
            {progress?.loadedBytes !== undefined && (
              <progress
                aria-label="입체화 모델 다운로드"
                max={progress.totalBytes ?? 1}
                value={progress.loadedBytes}
              />
            )}
            <button type="button" className="btn" onClick={cancel}>
              생성 취소
            </button>
          </div>
        )}
        {error && (
          <div role="alert" className={styles.error}>
            <p>{error}</p>
            {!result && input && !busy && (
              <button type="button" className="btn" onClick={generate}>
                다시 시도
              </button>
            )}
          </div>
        )}
        {result && (
          <div
            className={styles.viewer}
            inert={busy || applying || capturing}
            style={busy || applying || capturing ? { pointerEvents: 'none', opacity: 0.7 } : undefined}
          >
            {!viewerError && (
              <Product3dViewport
                key={viewerKey}
                ref={viewport}
                mesh={result.mesh}
                initialPose={initialPose}
                onPoseChange={(pose) => {
                  latestPose.current = pose;
                }}
                onError={setViewerError}
              />
            )}
            {viewerError && (
              <div role="alert" className={styles.error}>
                <p>{viewerError}</p>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setViewerError('');
                    setInitialPose(structuredClone(latestPose.current));
                    setViewerKey((v) => v + 1);
                  }}
                >
                  뷰어 다시 열기
                </button>
              </div>
            )}
            {!stored && (
              <dl className={styles.timings}>
                <div>
                  <dt>모델 다운로드</dt>
                  <dd>{seconds(result.timings.downloadMs)}</dd>
                </div>
                <div>
                  <dt>모델 준비</dt>
                  <dd>{seconds(result.timings.initializationMs)}</dd>
                </div>
                <div>
                  <dt>입체화 · {result.timings.backend === 'wasm' ? 'CPU' : 'GPU'}</dt>
                  <dd>{seconds(result.timings.processingMs)}</dd>
                </div>
              </dl>
            )}
            {result.timings.cacheNotice && <p className={styles.note}>{result.timings.cacheNotice}</p>}
            <p className={styles.note}>
              한 장에서 추정한 입체 형태예요. 보이지 않는 뒷면·얇은 부품·구멍은 실제 제품과 다를 수 있어요.
            </p>
          </div>
        )}
        <section className={styles.angles} aria-label="저장한 각도 사진">
          <div className={styles.angleHeading}>
            <h3>
              저장한 각도{' '}
              <span>
                {views.length}/{MAX_PRODUCT_VIEWS}
              </span>
            </h3>
            <p>각도를 바꾸면 아직 추가하거나 수정하지 않은 자세는 버려져요.</p>
          </div>
          <div className={styles.angleList}>
            {views.map((view, index) => (
              <article
                key={`${index}:${view.assetId}`}
                className={`${styles.angleCard} ${index === selectedViewIndex ? styles.selectedAngle : ''}`}
                data-testid="product3d-angle-card"
              >
                <button
                  type="button"
                  disabled={locked}
                  aria-label={`${view.direction} 각도 선택`}
                  aria-pressed={index === selectedViewIndex}
                  data-testid={`product3d-angle-select-${index}`}
                  onClick={() => changeView(index)}
                >
                  <AssetImage
                    assetId={view.assetId}
                    alt={`${view.direction} 각도 사진`}
                    className={styles.angleImage}
                  />
                  <strong>{view.direction}</strong>
                  <span className={styles.angleBadges}>
                    {index === selectedViewIndex && <span>선택됨</span>}
                  </span>
                </button>
              </article>
            ))}
          </div>
          {selectedView && (
            <div className={styles.angleActions}>
              <span>
                선택한 각도: <strong>{selectedView.direction}</strong>
              </span>
              <div className={styles.toolbar}>
                <button
                  type="button"
                  className="btn"
                  disabled={locked || !canApply}
                  aria-label={`${selectedView.direction} 이름 변경`}
                  onClick={() => {
                    setRenameName(selectedView.direction);
                    setNameError('');
                    setRenaming(true);
                  }}
                >
                  이름 변경
                </button>

                <button
                  type="button"
                  className="btn"
                  disabled={locked || !canApply}
                  aria-label={`${selectedView.direction} 삭제`}
                  onClick={deleteView}
                >
                  삭제
                </button>
              </div>
            </div>
          )}
          {renaming && (
            <div className={styles.rename}>
              <div className={styles.renameEditor}>
                <AngleNameInput
                  label="각도 이름 변경"
                  value={renameName}
                  disabled={locked || !canApply}
                  onChange={(value) => {
                    setRenameName(value);
                    setNameError('');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      saveName();
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setRenaming(false);
                    }
                  }}
                />
              </div>
              <button type="button" className="btn primary" disabled={locked || !canApply} onClick={saveName}>
                이름 저장
              </button>
              <button
                type="button"
                className="btn"
                disabled={locked}
                onClick={() => {
                  setRenaming(false);
                  setNameError('');
                }}
              >
                취소
              </button>
              {nameError && (
                <p role="alert" className={styles.nameError}>
                  {nameError}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
      <footer className={styles.footer}>
        <div className={styles.saveOptions}>
          <div className={styles.angleName}>
            <AngleNameInput
              label="새 각도 이름"
              value={newAngleName}
              disabled={locked || !canApply}
              onChange={(value) => {
                setNewAngleName(value);
                setNameError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void apply('add');
                }
              }}
            />
          </div>
          {!renaming && nameError && (
            <p role="alert" className={styles.nameError}>
              {nameError}
            </p>
          )}
          <p>
            추가는 새 사진을 만들고, 수정은 선택한 “{selectedView?.direction ?? '각도'}” 사진을 바꿔요. 자재
            저장 시 함께 반영돼요.
          </p>
          {views.length >= MAX_PRODUCT_VIEWS && (
            <p className={styles.nameError}>
              각도 사진은 자재당 최대 {MAX_PRODUCT_VIEWS}장까지 저장할 수 있어요. 새 각도를 추가하려면 기존
              사진을 삭제해 주세요.
            </p>
          )}
        </div>
        <div className={styles.toolbar}>
          <button
            type="button"
            className="btn"
            disabled={!result || locked || !!viewerError}
            onClick={download}
          >
            {capturing ? 'PNG 준비 중…' : '투명 PNG 다운로드'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!result || !selectedView || locked || !canApply || !!viewerError}
            onClick={() => void apply('replace')}
          >
            선택한 각도 수정
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!result || locked || !canApply || !!viewerError || views.length >= MAX_PRODUCT_VIEWS}
            onClick={() => void apply('add')}
          >
            {applying ? '각도 저장 중…' : '이 각도 추가'}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
