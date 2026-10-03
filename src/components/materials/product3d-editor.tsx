'use client';
import { useEffect, useRef, useState } from 'react';
import { getRepositories } from '@/lib/repositories';
import type { MaterialVersion } from '@/lib/types';
import { MAX_PRODUCT_VIEWS, productViewName } from '@/lib/product3d/apply';
import { isProductDirection, nextProductDirection, type ProductDirection } from '@/lib/product-direction';
import { directionMismatch, poseForDirection } from '@/lib/product3d/direction-pose';
import { AssetImage } from './asset-image';
import { AngleNameSelect } from './angle-name-input';
import type {
  PhotoCameraReference,
  Product3dReference,
  ProductMesh,
  ProductPose,
  ProductShading,
} from '@/lib/product3d/state-types';
import type {
  Product3dApplication,
  Product3dProgress,
  Product3dResult,
  ProductInput,
} from '@/lib/product3d/types';
import type { Product3dClient } from '@/lib/product3d/client';
import { decodeProductMesh } from '@/lib/product3d/codec';
import {
  prepareFittedMesh,
  preparePaintedMesh,
  prepareProductFit,
  prepareProductSurface,
} from '@/lib/product3d/surface';
import { decodeProductPhoto } from '@/lib/product3d/input-cutout';
import type { PhotoCamera } from '@/lib/product3d/photo-camera';
import {
  buildFit,
  fittedPhotoDirection,
  sizeMismatch,
  startingFit,
  SIZE_MISMATCH,
  validProductSize,
  type FitEstimate,
  type ProductFit,
  type ProductSize,
} from '@/lib/product3d/fit';
import type { MaterialCategory } from '@/lib/types';
import { readPhotoSize, smallPhotoNotice } from '@/lib/image-size-hint';
import { resolveProductInput } from '@/lib/product3d/source';
import { createDefaultPose, sourceViewAngle } from '@/lib/product3d/pose';
import { estimateUprightQuaternion } from '@/lib/product3d/upright';
import { Product3dViewport, type ProductViewportHandle } from './product3d-viewport';
import styles from './product3d-editor.module.css';
import { PRODUCT3D_LOAD, product3dLoadEvent } from '@/lib/ai-progress';
import { ModelLoadingProgress, useModelLoadingProgress } from '@/components/model-loading-progress';
const seconds = (value: number) => `${(value / 1000).toFixed(2)}초`;
/** Products that are left-right symmetric: the mirror evening-out starts on for these. */
const SYMMETRIC_CATEGORIES = new Set<string>(['toilet', 'basin', 'bath', 'vanity']);
const percent = (share: number) => `${share >= 0 ? '+' : ''}${Math.round(share * 100)}%`;
/** Beyond this, most of what the viewer shows was not in the photo. */
const GUESSED_VIEW_DEGREES = 40;
/** One step of the fit's undo history: the fit and whether the photo's colours were on. */
interface FitStep {
  fit: ProductFit | undefined;
  photo: boolean;
}
/** The next photo's name: the first direction not used yet. */
function nextAngleName(names: string[]): ProductDirection {
  return nextProductDirection(names) ?? '정면';
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
  size,
  category,
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
  /** The material's width, depth and height (mm) as typed in the form, for the real-size fit. */
  size?: ProductSize;
  category?: MaterialCategory;
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
  const modelLoading = useModelLoadingProgress(PRODUCT3D_LOAD);
  const [busy, setBusy] = useState(false),
    [applying, setApplying] = useState(false),
    [capturing, setCapturing] = useState(false);
  const [error, setError] = useState(''),
    [sourceError, setSourceError] = useState(''),
    [viewerError, setViewerError] = useState('');
  const [newAngleName, setNewAngleName] = useState<string>(() =>
    nextAngleName(views.map((view) => view.direction)),
  );
  const [nameError, setNameError] = useState('');
  const [renaming, setRenaming] = useState(false),
    [renameName, setRenameName] = useState('');
  const [notice, setNotice] = useState(''),
    // Said before the photo is turned into 3D when it is small (see image-size-hint).
    [smallPhoto, setSmallPhoto] = useState('');
  // New reconstructions start mixed; saved views reopen the way they were saved (older ones unlit).
  const [shading, setShading] = useState<ProductShading>('mixed'),
    [viewAngle, setViewAngle] = useState(0);
  // How the mesh is fitted to the product (real size, mirror symmetry, front); see product3d/fit.ts.
  const [fit, setFit] = useState<ProductFit>(),
    [fitted, setFitted] = useState<{ source: ProductMesh; mesh: ProductMesh }>(),
    [estimate, setEstimate] = useState<FitEstimate>(),
    [flip, setFlip] = useState(false),
    [fitting, setFitting] = useState(false),
    [fitNote, setFitNote] = useState(''),
    [fitPast, setFitPast] = useState<FitStep[]>([]),
    [fitFuture, setFitFuture] = useState<FitStep[]>([]),
    [sizeAsk, setSizeAsk] = useState<ReturnType<typeof sizeMismatch>>();
  // The input photo's colours on the mesh (see product3d/photo-color.ts): on or off, the camera found
  // for the photo (kept while off, so turning it on again does not search again), and a plain-language note.
  const [paintOn, setPaintOn] = useState(false),
    [paintBusy, setPaintBusy] = useState(false),
    [paintNote, setPaintNote] = useState(''),
    [paintMatch, setPaintMatch] = useState<number>();
  const paintCamera = useRef<PhotoCamera>(undefined);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  /**
   * Puts the input photo's colours on `mesh` (or finds out it cannot be done): the camera is searched
   * the first time and remembered. Gives the painted mesh, or undefined with the reason in the note.
   */
  const paintMesh = async (mesh: ProductMesh, photo: Blob, known?: PhotoCamera) => {
    setPaintBusy(true);
    setPaintNote('');
    try {
      const outcome = await preparePaintedMesh(mesh, () => decodeProductPhoto(photo), known);
      if (!alive.current) return undefined;
      if (outcome.status === 'ok') {
        paintCamera.current = outcome.camera;
        setPaintMatch(outcome.iou);
        return outcome.mesh;
      }
      setPaintMatch(outcome.iou || undefined);
      setPaintNote(outcome.message);
      return undefined;
    } finally {
      if (alive.current) setPaintBusy(false);
    }
  };
  const selectedView = views[selectedViewIndex];
  const locked = loading || busy || applying || capturing || fitting;
  const latestPose = useRef<ProductPose>(createDefaultPose());
  // The live pose, to compare with the names while the product is turned.
  const [livePose, setLivePose] = useState<ProductPose>(() => createDefaultPose());
  const trackPose = (pose: ProductPose) => {
    latestPose.current = pose;
    setLivePose(pose);
  };
  // A name and the way the product faces right now, for the warnings (more than 25° apart).
  const addMismatch =
    result && isProductDirection(newAngleName) ? directionMismatch(livePose, newAngleName) : undefined;
  const replaceMismatch =
    result && selectedView && isProductDirection(selectedView.direction)
      ? directionMismatch(livePose, selectedView.direction)
      : undefined;
  const [attempt, setAttempt] = useState(0),
    [viewerKey, setViewerKey] = useState(0),
    // A model just made opens level by its outline; a saved one and a retried viewer open as they were.
    [freshModel, setFreshModel] = useState(false),
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
    setSmallPhoto('');
    setResult(undefined);
    setFit(undefined);
    setFitted(undefined);
    setEstimate(undefined);
    setFlip(false);
    setFitNote('');
    setFitPast([]);
    setFitFuture([]);
    setSizeAsk(undefined);
    setPaintOn(false);
    setPaintBusy(false);
    setPaintNote('');
    setPaintMatch(undefined);
    paintCamera.current = undefined;
    setStored(false);
    setShading(product3d && !blob ? (product3d.shading ?? 'baked') : 'mixed');
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
      if (!(product3d && !blob))
        void readPhotoSize(source.blob).then((size) => {
          if (active && size) setSmallPhoto(smallPhotoNotice([{ name: source.name, ...size }]));
        });
      if (product3d && !blob) {
        try {
          const asset = await repositories.assets.get(product3d.meshAssetId);
          if (asset.kind !== 'product-mesh' || asset.sourceAssetId !== product3d.inputAssetId)
            throw new Error('저장된 입체 형상 종류가 올바르지 않아요.');
          const mesh = await decodeProductMesh(asset.blob);
          // A view saved with the photo's colours reads the photo back and lays it over the mesh.
          const painted = product3d.photoCamera
            ? await paintMesh(mesh, source.blob, product3d.photoCamera)
            : undefined;
          if (painted) setPaintOn(true);
          // A view saved with a fit draws the fitted mesh (the saved one is left as it was made).
          const shown = await prepareFittedMesh(painted ?? mesh, product3d.fit, sizeRef.current);
          // A lit view's colours are worked out off the main thread before the viewer opens.
          if (product3d.shading) await prepareProductSurface(product3d.shading, shown);
          if (!active) return;
          if (painted || product3d.fit) setFitted({ source: mesh, mesh: shown });
          if (product3d.fit) {
            setFit(structuredClone(product3d.fit));
            // The saved fit stands in for a search: turning a part off and on again uses its numbers.
            setEstimate({
              fit: structuredClone(product3d.fit),
              symmetric: product3d.fit.mirror !== undefined || product3d.fit.front !== 0,
              uncertainFront: false,
            });
          }
          trackPose(structuredClone(product3d.pose));
          setInitialPose(structuredClone(product3d.pose));
          setFreshModel(false);
          setViewAngle(
            sourceViewAngle(product3d.pose, product3d.fit ? fittedPhotoDirection(product3d.fit) : undefined),
          );
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
    modelLoading.reset();
  };
  const generate = async () => {
    if (!input || busy || operation.current) return;
    const run = ++generation.current;
    client.current?.dispose();
    setBusy(true);
    setError('');
    setViewerError('');
    setProgress(undefined);
    modelLoading.reset();
    try {
      const { Product3dClient: Client } = await import('@/lib/product3d/client');
      if (!alive.current || run !== generation.current) return;
      const activeClient = new Client();
      client.current = activeClient;
      const next = await activeClient.run(input.blob, (p) => {
        if (!alive.current || run !== generation.current) return;
        setProgress(p);
        modelLoading.push(product3dLoadEvent(p));
      });
      if (!alive.current || run !== generation.current) return;
      // A single photo cannot tell the camera height, so stand the new model upright first.
      const pose = {
        ...createDefaultPose(),
        objectQuaternion: estimateUprightQuaternion(next.mesh.positions),
      };
      // Then fit it to the product: where its mirror plane and front are, and the material's real size.
      setProgress({ stage: 'geometry', message: '제품의 크기와 좌우 대칭을 맞추고 있어요.' });
      const found = await prepareProductFit(next.mesh, pose.objectQuaternion, {
        size: sizeRef.current,
        mirror: true,
      });
      if (!alive.current || run !== generation.current) return;
      // A typed size that the photo disagrees with by a lot is not applied on its own: it is asked.
      const { fit: first, ask } = startingFit(next.mesh, found, {
        size: sizeRef.current,
        symmetricKind: SYMMETRIC_CATEGORIES.has(category ?? ''),
      });
      // The input photo's own colours go on what the photo shows (when its outline fits the model's).
      setProgress({ stage: 'coloring', message: '사진의 색과 무늬를 입체에 입히고 있어요.' });
      paintCamera.current = undefined;
      const painted = await paintMesh(next.mesh, input.blob);
      if (!alive.current || run !== generation.current) return;
      const shown = await prepareFittedMesh(painted ?? next.mesh, first, sizeRef.current);
      // The mixed colours (what the photo shows keeps its detail, the rest is clean) take a moment.
      setProgress({ stage: 'coloring', message: '안 찍힌 면의 색을 정리하고 있어요.' });
      await prepareProductSurface('mixed', shown);
      if (!alive.current || run !== generation.current) return;
      setPaintOn(!!painted);
      setMeshAssetId(undefined);
      setEstimate(found);
      setFit(first);
      setFitted({ source: next.mesh, mesh: shown });
      setFlip(false);
      setFitPast([]);
      setFitFuture([]);
      setSizeAsk(ask);
      setFitNote('');
      trackPose(pose);
      setInitialPose(pose);
      setViewAngle(sourceViewAngle(pose, first ? fittedPhotoDirection(first) : undefined));
      setShading('mixed');
      setStored(false);
      setFreshModel(true);
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
      name = productViewName(mode === 'add' ? newAngleName : selectedView.direction);
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
          shading,
          ...(fit ? { fit } : {}),
          ...(paintOn && paintCamera.current && paintMatch !== undefined
            ? { photoCamera: { ...paintCamera.current, iou: paintMatch } satisfies PhotoCameraReference }
            : {}),
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
        if (mode === 'add') {
          // Ready for the next direction, turned to face it.
          const next = nextAngleName([...views.map((view) => view.direction), name]);
          setNewAngleName(next);
          turnTo(next);
        }
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
  /**
   * Draws the mesh with `next` as its fit (undefined: as made) and the photo's colours on or off,
   * keeping the pose the product has now.
   */
  const changeFit = async (next: ProductFit | undefined, remember = true, photo = paintOn) => {
    if (!result || fitting) return;
    setFitting(true);
    setError('');
    try {
      const painted =
        photo && input ? await paintMesh(result.mesh, input.blob, paintCamera.current) : undefined;
      if (!alive.current) return;
      const shown = await prepareFittedMesh(painted ?? result.mesh, next, sizeRef.current);
      if (shading !== 'baked') await prepareProductSurface(shading, shown);
      if (!alive.current) return;
      if (remember) {
        setFitPast((past) => [...past.slice(-19), { fit, photo: paintOn }]);
        setFitFuture([]);
      }
      setPaintOn(!!painted);
      const pose = viewport.current ? viewport.current.getPose() : latestPose.current;
      trackPose(pose);
      setInitialPose(structuredClone(pose));
      setFit(next);
      setFitted({ source: result.mesh, mesh: shown });
      setFreshModel(false);
      setViewAngle(sourceViewAngle(pose, next ? fittedPhotoDirection(next) : undefined));
      setViewerKey((key) => key + 1);
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : '제품 맞춤을 적용하지 못했어요.');
    } finally {
      if (alive.current) setFitting(false);
    }
  };
  /** The search for the mirror plane and front, once for the pose the product has now. */
  const search = async (again = false) => {
    if ((estimate && !again) || !result) return estimate;
    const found = await prepareProductFit(result.mesh, latestPose.current.objectQuaternion, {
      size: sizeRef.current,
      mirror: true,
    });
    if (alive.current) setEstimate(found);
    return found;
  };
  const choice = (change: Partial<{ size: boolean; mirror: boolean; flip: boolean }>) => ({
    size: !!fit?.size,
    mirror: fit?.mirror !== undefined,
    flip,
    ...change,
  });
  const setPart = async (change: Partial<{ size: boolean; mirror: boolean }>) => {
    if (!result || locked) return;
    setFitNote('');
    setSizeAsk(undefined);
    setFitting(true);
    let found: FitEstimate | undefined;
    try {
      // A fit read back from a save has no mirror plane to turn on when it was saved without one: search.
      found = await search(!!change.mirror && estimate !== undefined && estimate.fit.mirror === undefined);
    } finally {
      if (alive.current) setFitting(false);
    }
    if (!found || !alive.current) return;
    if (change.mirror && !found.symmetric) {
      setFitNote('좌우 대칭인 면을 찾지 못해 형상은 그대로 뒀어요. 앞쪽 방향도 모델 기준 그대로예요.');
      return;
    }
    // A typed size the photo disagrees with by a lot is asked about, not applied.
    if (change.size && validProductSize(sizeRef.current)) {
      const measured = sizeMismatch(result.mesh, found.fit, sizeRef.current);
      if (measured.worst > SIZE_MISMATCH) {
        setSizeAsk(measured);
        return;
      }
    }
    await changeFit(buildFit(found, choice(change)));
  };
  const undoFit = () => {
    const previous = fitPast.at(-1);
    if (!previous || fitting) return;
    setFitPast(fitPast.slice(0, -1));
    setFitFuture([{ fit, photo: paintOn }, ...fitFuture]);
    void changeFit(previous.fit, false, previous.photo);
  };
  const redoFit = () => {
    if (fitFuture.length === 0 || fitting) return;
    const [next, ...rest] = fitFuture;
    setFitFuture(rest);
    setFitPast([...fitPast, { fit, photo: paintOn }]);
    void changeFit(next.fit, false, next.photo);
  };
  const changeView = (index: number) => {
    if (locked || index === selectedViewIndex) return;
    setNotice('');
    setNameError('');
    setRenaming(false);
    onSelectView(index);
  };
  /** Turns the product to face a name's direction (the new angle's name is picked → it follows). */
  const turnTo = (name: string) => {
    if (!isProductDirection(name) || !viewport.current || !result || viewerError) return;
    try {
      viewport.current.setPose(poseForDirection(viewport.current.getPose(), name));
    } catch {
      // The viewer is not ready: the warning below tells if the pose and name disagree.
    }
  };
  const saveName = () => {
    if (locked || !canApply || !selectedView) return;
    try {
      const value = productViewName(renameName);
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
            {!stored && smallPhoto && (
              <p className={styles.note} role="status" data-testid="product3d-small-photo">
                {smallPhoto}
              </p>
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
            <strong>
              {progress?.message ?? '입체화 실행 모듈을 준비하고 있어요.'}
              {progress?.completed !== undefined && progress.total
                ? ` (${progress.completed}/${progress.total})`
                : ''}
            </strong>
            {modelLoading.visible && modelLoading.snapshot && (
              // Three model files load between inference steps; the percentage covers all of them.
              <ModelLoadingProgress
                title="360° 입체화 AI 모델 준비"
                label="입체화 모델 다운로드"
                snapshot={modelLoading.snapshot}
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
                mesh={fitted?.source === result.mesh ? fitted.mesh : result.mesh}
                initialPose={initialPose}
                levelOnOpen={freshModel}
                shading={shading}
                onShadingChange={setShading}
                onPoseChange={(pose) => {
                  trackPose(pose);
                  setViewAngle(sourceViewAngle(pose, fit ? fittedPhotoDirection(fit) : undefined));
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
                    setFreshModel(false);
                    setViewerKey((v) => v + 1);
                  }}
                >
                  뷰어 다시 열기
                </button>
              </div>
            )}
            <fieldset className={styles.fit} aria-label="제품 맞추기" disabled={fitting || busy || applying}>
              <legend>제품 맞추기</legend>
              <label>
                <input
                  type="checkbox"
                  data-testid="product3d-fit-size"
                  checked={!!fit?.size}
                  disabled={!validProductSize(size)}
                  onChange={(event) => void setPart({ size: event.target.checked })}
                />{' '}
                실제 크기 맞추기
              </label>
              <label>
                <input
                  type="checkbox"
                  data-testid="product3d-fit-mirror"
                  checked={fit?.mirror !== undefined}
                  onChange={(event) => void setPart({ mirror: event.target.checked })}
                />{' '}
                좌우 대칭 다듬기
              </label>
              <button
                type="button"
                className="btn"
                data-testid="product3d-fit-flip"
                disabled={!fit || !estimate?.symmetric}
                onClick={() => {
                  if (!estimate || !fit) return;
                  setFlip(!flip);
                  void changeFit(buildFit(estimate, choice({ flip: !flip })));
                }}
              >
                앞쪽 뒤집기
              </button>
              <button
                type="button"
                className="btn"
                data-testid="product3d-fit-undo"
                disabled={fitPast.length === 0}
                onClick={undoFit}
              >
                맞춤 실행 취소
              </button>
              <button
                type="button"
                className="btn"
                data-testid="product3d-fit-redo"
                disabled={fitFuture.length === 0}
                onClick={redoFit}
              >
                맞춤 다시 실행
              </button>
              <p className={styles.note} role="status" data-testid="product3d-fit-note">
                {fitting
                  ? '맞추고 있어요…'
                  : fitNote ||
                    (validProductSize(size)
                      ? fit?.size
                        ? `자재의 가로 ${size.widthMm} × 깊이 ${size.depthMm} × 높이 ${size.heightMm}mm에 맞춰 보여 줘요. 자재 크기를 고치면 다시 열 때 따라가요.`
                        : `자재 크기(가로 ${size.widthMm} × 깊이 ${size.depthMm} × 높이 ${size.heightMm}mm)는 아직 적용하지 않았어요.`
                      : '실제 크기를 맞추려면 자재의 가로·깊이·높이(10~5000mm)를 입력해 주세요. 깊이가 9mm(타일 기본값)이면 맞추지 않아요.')}
                {!fitting && fit && estimate?.symmetric && estimate.uncertainFront && !flip
                  ? ' 제품의 앞쪽 방향을 확신하지 못했어요. 맞는지 확인하고 틀리면 앞쪽 뒤집기를 눌러 주세요.'
                  : ''}
              </p>
              {sizeAsk && size && (
                <div role="status" className={styles.error} data-testid="product3d-fit-ask">
                  <p>
                    입력한 크기와 사진의 비율이 많이 달라요(깊이 {percent(sizeAsk.depth)}, 가로{' '}
                    {percent(sizeAsk.width)}, 높이 {percent(sizeAsk.height)}). 크기를 잘못 입력했다면 형상이
                    망가질 수 있어요. 그래도 맞출까요?
                  </p>
                  <button
                    type="button"
                    className="btn"
                    data-testid="product3d-fit-ask-yes"
                    onClick={() => {
                      setSizeAsk(undefined);
                      const found = estimate;
                      if (found) void changeFit(buildFit(found, choice({ size: true })));
                    }}
                  >
                    그래도 맞추기
                  </button>
                  <button type="button" className="btn" onClick={() => setSizeAsk(undefined)}>
                    맞추지 않기
                  </button>
                </div>
              )}
            </fieldset>
            <fieldset
              className={styles.fit}
              aria-label="사진 색 입히기"
              disabled={fitting || busy || applying || paintBusy || !input}
            >
              <legend>사진 색 입히기</legend>
              <label>
                <input
                  type="checkbox"
                  data-testid="product3d-photo-color"
                  checked={paintOn}
                  onChange={(event) => void changeFit(fit, true, event.target.checked)}
                />{' '}
                원본 사진의 색 입히기
              </label>
              <p className={styles.note} role="status" data-testid="product3d-photo-note">
                {paintBusy
                  ? '사진의 색과 무늬를 입히고 있어요…'
                  : paintNote ||
                    (paintOn
                      ? `사진을 찍은 쪽 면에 원본 사진의 색과 무늬를 그대로 입혔어요(윤곽 일치 ${Math.round((paintMatch ?? 0) * 100)}%). 사진에 안 보이는 면은 모델이 추측한 색이에요. 되돌리려면 위의 맞춤 실행 취소를 눌러요.`
                      : '켜면 사진을 찍은 쪽 면의 색을 원본 사진에서 직접 가져와 얼굴 무늬·테두리가 또렷해져요.')}
              </p>
            </fieldset>
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
                <AngleNameSelect
                  label="각도 이름 변경"
                  value={renameName}
                  disabled={locked || !canApply}
                  taken={views.filter((_, i) => i !== selectedViewIndex).map((view) => view.direction)}
                  onChange={(value) => {
                    setRenameName(value);
                    setNameError('');
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
            <AngleNameSelect
              label="새 각도 이름"
              value={newAngleName}
              disabled={locked || !canApply}
              taken={views.map((view) => view.direction)}
              onChange={(value) => {
                setNewAngleName(value);
                setNameError('');
                // Picking a name turns the product to face that direction.
                turnTo(value);
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
          {result && addMismatch && (
            <div
              data-testid="product3d-direction-warning"
              role="status"
              className="text-[13px] text-amber-800"
            >
              <p>
                ‘{newAngleName}’ 이름과 제품이 바라보는 방향이 달라요
                {addMismatch.degrees > 0 ? ` (약 ${Math.round(addMismatch.degrees)}° 차이)` : ''}. 지금 모습은
                ‘{addMismatch.nearest}’에 가까워요. 이대로 저장하면 방에서 이름의 방향대로 놓여 제품이 어긋나
                보일 수 있어요.
              </p>
              <button
                type="button"
                className="btn"
                disabled={locked || !canApply || views.some((view) => view.direction === addMismatch.nearest)}
                onClick={() => {
                  setNewAngleName(addMismatch.nearest);
                  setNameError('');
                }}
              >
                가장 가까운 이름으로 바꾸기
              </button>
              <button
                type="button"
                className="btn"
                disabled={locked || !canApply}
                onClick={() => turnTo(newAngleName)}
              >
                ‘{newAngleName}’ 방향으로 돌리기
              </button>
            </div>
          )}
          {result && replaceMismatch && (
            <p data-testid="product3d-replace-warning" role="status" className="text-[13px] text-amber-800">
              선택한 ‘{selectedView?.direction}’ 각도를 지금 모습으로 수정하면 이름과 방향이 달라요(지금은 ‘
              {replaceMismatch.nearest}’에 가까워요).
            </p>
          )}
          {result && viewAngle > GUESSED_VIEW_DEGREES && (
            <p
              data-testid="product3d-angle-warning"
              aria-live="polite"
              className="text-[13px] text-amber-800"
            >
              사진에 없던 면이라 모양이 부정확할 수 있어요. 지금 시점은 사진 방향에서 약{' '}
              {Math.round(viewAngle)}° 돌아가 있어요.
            </p>
          )}
          {views.length >= MAX_PRODUCT_VIEWS && (
            <p className={styles.nameError}>
              각도 사진은 방향마다 한 장, 자재당 최대 {MAX_PRODUCT_VIEWS}장까지 저장할 수 있어요. 새 각도를
              추가하려면 기존 사진을 삭제하거나 ‘선택한 각도 수정’을 써 주세요.
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
            disabled={
              !result ||
              locked ||
              !canApply ||
              !!viewerError ||
              views.length >= MAX_PRODUCT_VIEWS ||
              views.some((view) => view.direction === newAngleName)
            }
            onClick={() => void apply('add')}
          >
            {applying ? '각도 저장 중…' : '이 각도 추가'}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
