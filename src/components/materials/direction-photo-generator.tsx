'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { BackgroundRemovalClient } from '@/lib/background-removal/client';
import type { BackgroundRemovalProgress } from '@/lib/background-removal/types';
import { BACKGROUND_REMOVAL_LOAD, backgroundRemovalLoadEvent } from '@/lib/ai-progress';
import { ModelLoadingProgress, useModelLoadingProgress } from '@/components/model-loading-progress';
import { prepareReferenceImage } from '@/lib/ai-export/client';
import { pickImageFiles } from '@/lib/file-drop';
import { PRODUCT_DIRECTIONS, type ProductDirection } from '@/lib/product-direction';
import type { MaterialCategory, MaterialInput, Point } from '@/lib/types';
import {
  DIRECTION_PHOTO_FORMS,
  DIRECTION_PHOTO_MAX_MM,
  DIRECTION_PHOTO_MIN_MM,
  DIRECTION_PHOTO_PHOTO_ANGLES,
  directionPhotoSizeOk,
  directionPhotoView,
  isDirectionPhotoCategory,
  photoAngleTold,
  standsOnFloor,
  toiletLids,
  type DirectionPhotoCategory,
  type DirectionPhotoForm,
  type DirectionPhotoLid,
  type DirectionPhotoPhotoAngle,
  type DirectionPhotoSpec,
} from '@/lib/direction-photo/contract';
import type { DirectionGuide } from '@/lib/direction-photo/guide-render';
import {
  TOILET_BODY_COLORS,
  TOILET_LABELS,
  TOILET_SEAT_COLORS,
  TOILET_SKIRTS,
  type ToiletBodyColor,
  type ToiletSeatColor,
  type ToiletSkirt,
} from '@/lib/direction-photo/categories/toilet';
import { mirrorPng, readAlpha, requestDirectionPhoto } from '@/lib/direction-photo/client';
import {
  anchorFromAlpha,
  DIRECTION_PHOTO_CANDIDATES,
  directionJobs,
  planDirections,
  runDirectionJobs,
  runEstimate,
  type DirectionJob,
} from '@/lib/direction-photo/plan';
import { AiLimitHint } from '@/components/service-limit-banner';
import styles from './materials.module.css';

/** A photo the AI made for one direction and the person may pick. */
export type MadePhoto = { direction: ProductDirection; blob: Blob; anchor: Point };

const MAX_REFS = 3;
const FORM_LABELS: Record<DirectionPhotoForm, string> = {
  'oval-freestanding': '타원형 독립 욕조',
  rectangular: '사각 욕조(벽에 붙이는)',
  ...TOILET_LABELS.form,
  'wall-round': '벽걸이 · 둥근 그릇',
  'wall-rectangular': '벽걸이 · 사각 그릇',
  'pedestal-round': '받침대 · 둥근 그릇',
  'pedestal-rectangular': '받침대 · 사각 그릇',
};
const LID_LABELS: Record<DirectionPhotoLid, string> = TOILET_LABELS.lid;
/** Said as the slots name a photo: the way the product's front points in it. */
const PHOTO_ANGLE_LABELS: Record<DirectionPhotoPhotoAngle, string> = {
  unknown: '찍은 각도 모름',
  front: '정면',
  'front-right': '정면과 오른쪽 사이',
  'front-left': '정면과 왼쪽 사이',
  right: '오른쪽',
  left: '왼쪽',
};
/** The shape a kind starts with: the oval tub the trial checked, a two-piece toilet, a basin as installed. */
function defaultForm(category: DirectionPhotoCategory, installation: MaterialInput['installation']) {
  if (category === 'bath') return 'oval-freestanding';
  if (category === 'toilet') return 'two-piece';
  return installation === 'wall' || installation === 'suspended' ? 'wall-round' : 'pedestal-round';
}
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;

type Reference = {
  id: string;
  file: File;
  status: 'removing' | 'ready' | 'failed';
  /** Where the person says it was taken from (told to the model so it does not copy the angle). */
  angle: DirectionPhotoPhotoAngle;
  /** The photo without its background, on white, within the model's input size. */
  onWhite?: Blob;
  url?: string;
  error?: string;
};
type Candidate = { status: 'made'; blob: Blob; url: string } | { status: 'failed'; message: string };

/**
 * "AI로 방향 사진 만들기" in the material form (bath, toilet, basin): the person's photos of the
 * product (any angle, staged ones too), the guide of each direction (the kind's standard model at the
 * registered size, src/lib/direction-photo/guide-render.ts), FLUX.2 klein 4B makes candidates on the
 * server, the person picks one a direction, and the pick goes into that direction's photo slot without
 * its background, the anchor set from its outline. Nothing is saved until "자재 등록".
 */
export function DirectionPhotoGenerator({
  category,
  widthMm,
  heightMm,
  depthMm,
  installation,
  userId,
  disabled,
  hasCover,
  onApply,
}: {
  category: MaterialCategory;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  installation: MaterialInput['installation'];
  userId?: string | null;
  disabled: boolean;
  hasCover: boolean;
  onApply: (photos: MadePhoto[], cover?: File) => Promise<void>;
}) {
  const kind = isDirectionPhotoCategory(category) ? category : undefined;
  /** The shape the person picked; until then the kind's default for its installation. */
  const [chosen, setChosen] = useState<DirectionPhotoForm>();
  /** A toilet's lid as picked (closed until then, and when the body has no such lid). */
  const [chosenLid, setChosenLid] = useState<DirectionPhotoLid>('closed');
  /** A two-piece toilet's lower part as picked (the foot in the open until then). */
  const [chosenSkirt, setChosenSkirt] = useState<ToiletSkirt>('exposed');
  /** A toilet's colours as said: none ('') is as the photos show; the seat may follow the body. */
  const [chosenBody, setChosenBody] = useState<ToiletBodyColor | ''>('');
  const [chosenSeat, setChosenSeat] = useState<ToiletSeatColor | 'body' | ''>('');
  const [symmetric, setSymmetric] = useState(true);
  const [useCover, setUseCover] = useState(!hasCover);
  const [refs, setRefs] = useState<Reference[]>([]);
  const [refNotice, setRefNotice] = useState('');
  const [guides, setGuides] = useState<DirectionGuide[]>();
  const [guideUrls, setGuideUrls] = useState<Partial<Record<ProductDirection, string>>>({});
  const [guideError, setGuideError] = useState('');
  const [candidates, setCandidates] = useState<Partial<Record<ProductDirection, Candidate[]>>>({});
  const [picked, setPicked] = useState<Partial<Record<ProductDirection, number>>>({});
  const [running, setRunning] = useState<{ done: number; total: number }>();
  const [notice, setNotice] = useState('');
  const [applying, setApplying] = useState('');
  const [madeWith, setMadeWith] = useState('');
  const [removal, setRemoval] = useState<BackgroundRemovalProgress>();
  const loading = useModelLoadingProgress(BACKGROUND_REMOVAL_LOAD);
  const { push: pushLoading } = loading;
  const controller = useRef<AbortController | null>(null);
  const client = useRef<BackgroundRemovalClient | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const urls = useRef(new Set<string>());
  const alive = useRef(true);

  const forms = kind ? (DIRECTION_PHOTO_FORMS[kind] as readonly DirectionPhotoForm[]) : [];
  const shape: DirectionPhotoForm =
    chosen && forms.includes(chosen) ? chosen : defaultForm(kind ?? 'bath', installation);
  const entered = widthMm > 0 && heightMm > 0 && depthMm > 0;
  // The route's own range: a size it would turn down (a tile's 9 mm depth left after switching the
  // category) draws no guide and sends nothing.
  const sized = directionPhotoSizeOk([widthMm, heightMm, depthMm]);
  const sizeText = `가로 ${widthMm} × 높이 ${heightMm} × 깊이 ${depthMm}mm`;
  const lid: DirectionPhotoLid | undefined =
    kind === 'toilet' ? (toiletLids(shape).includes(chosenLid) ? chosenLid : 'closed') : undefined;
  // A toilet's finer choices (categories/toilet.ts), sent only when said: none, the same as before.
  const skirt =
    kind === 'toilet' && shape === 'two-piece' && chosenSkirt === 'skirted' ? chosenSkirt : undefined;
  const bodyColor = kind === 'toilet' ? chosenBody || undefined : undefined;
  const seatColor =
    kind !== 'toilet' ? undefined : chosenSeat === 'body' ? bodyColor : chosenSeat || undefined;
  // The photos' angles, asked and sent for a toilet shaped like the product only (contract.ts).
  const anglesTold = !!kind && photoAngleTold(kind, shape);
  const wallToilet = kind === 'toilet' && !standsOnFloor(installation);
  const plan = planDirections({ category: kind, installation, symmetric });
  const ready = refs.filter((ref) => ref.status === 'ready' && ref.onWhite);
  const inputs = JSON.stringify([
    kind,
    shape,
    lid,
    skirt,
    bodyColor,
    seatColor,
    widthMm,
    heightMm,
    depthMm,
    installation,
  ]);

  const keep = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    return url;
  };
  const drop = (url?: string) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    urls.current.delete(url);
  };
  useEffect(() => {
    alive.current = true;
    const owned = urls.current;
    return () => {
      alive.current = false;
      controller.current?.abort();
      client.current?.dispose();
      owned.forEach((url) => URL.revokeObjectURL(url));
      owned.clear();
    };
  }, []);

  /** The background taken off a picture (BiRefNet in this browser), one picture at a time. */
  const cutout = (blob: Blob): Promise<Blob> => {
    const run = queue.current.then(async () => {
      const { BackgroundRemovalClient: Client } = await import('@/lib/background-removal/client');
      client.current ??= new Client();
      const result = await client.current.run(blob, (progress) => {
        if (!alive.current) return;
        setRemoval(progress);
        pushLoading(backgroundRemovalLoadEvent(progress));
      });
      return result.blob;
    });
    queue.current = run.catch(() => {});
    return run.finally(() => {
      if (alive.current) setRemoval(undefined);
    });
  };

  // The guides of all four directions, drawn again when the kind, shape, size or installation change.
  useEffect(() => {
    if (!kind || !sized || wallToilet) {
      setGuides(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { renderDirectionGuides } = await import('@/lib/direction-photo/guide-render');
          const made = await renderDirectionGuides(
            { category: kind, form: shape, lid, skirt, sizeMm: [widthMm, heightMm, depthMm], installation },
            PRODUCT_DIRECTIONS,
          );
          if (!current) return;
          setGuideError('');
          setGuides(made);
          setGuideUrls((previous) => {
            Object.values(previous).forEach(drop);
            return Object.fromEntries(made.map((guide) => [guide.direction, keep(guide.blob)]));
          });
        } catch (error) {
          if (current)
            setGuideError(error instanceof Error ? error.message : '가이드 그림을 그리지 못했어요.');
        }
      })();
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [kind, shape, lid, skirt, widthMm, heightMm, depthMm, installation, sized, wallToilet]);

  const addRefs = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    const pick = pickImageFiles(files, { multiple: true, max: MAX_REFS, current: refs.length });
    setRefNotice(pick.error ?? pick.notice ?? '');
    for (const file of pick.files) {
      const id = crypto.randomUUID();
      setRefs((current) => [...current, { id, file, status: 'removing', angle: 'unknown' }]);
      void cutout(file)
        .then(prepareReferenceImage)
        .then((onWhite) => {
          if (!alive.current) return;
          const url = keep(onWhite);
          setRefs((current) =>
            current.map((ref) => (ref.id === id ? { ...ref, status: 'ready', onWhite, url } : ref)),
          );
        })
        .catch((error: unknown) => {
          if (!alive.current) return;
          setRefs((current) =>
            current.map((ref) =>
              ref.id === id
                ? {
                    ...ref,
                    status: 'failed',
                    error: error instanceof Error ? error.message : '배경을 지우지 못했어요.',
                  }
                : ref,
            ),
          );
        });
    }
  };
  const removeRef = (id: string) =>
    setRefs((current) => {
      drop(current.find((ref) => ref.id === id)?.url);
      return current.filter((ref) => ref.id !== id);
    });

  const guideOf = (direction: ProductDirection) => guides?.find((guide) => guide.direction === direction);
  const estimate = guides
    ? runEstimate(
        plan.made.map((direction) => guideOf(direction)!),
        Math.max(1, ready.length),
      )
    : undefined;
  const canMake =
    !!kind && sized && !wallToilet && !!guides && ready.length > 0 && !running && !applying && !disabled;

  /** Sends the jobs for these directions; their candidates replace what was there. */
  const make = async (directions: readonly ProductDirection[]) => {
    if (!kind || !guides || !ready.length) return;
    const abort = new AbortController();
    controller.current = abort;
    const jobs = directionJobs(directions, DIRECTION_PHOTO_CANDIDATES, randomSeed);
    const photos = ready.map((ref) => ref.onWhite!);
    const photoAngles = anglesTold ? ready.map((ref) => ref.angle) : undefined;
    const sizeMm: [number, number, number] = [widthMm, heightMm, depthMm].map(Math.round) as [
      number,
      number,
      number,
    ];
    setNotice('');
    setRunning({ done: 0, total: jobs.length });
    try {
      const outcomes = await runDirectionJobs({
        jobs,
        signal: abort.signal,
        onProgress: (done, total) => alive.current && setRunning({ done, total }),
        request: (job: DirectionJob, signal) => {
          const spec: DirectionPhotoSpec = {
            category: kind,
            form: shape,
            ...(lid && { lid }),
            direction: directionPhotoView(job.direction),
            installation,
            sizeMm,
            ...(photoAngles && { photoAngles }),
            ...(skirt && { skirt }),
            ...(bodyColor && { bodyColor }),
            ...(seatColor && { seatColor }),
          };
          return requestDirectionPhoto({
            guide: guideOf(job.direction)!.blob,
            refs: photos,
            seed: job.seed,
            spec,
            signal,
            userId,
          });
        },
      });
      if (!alive.current) return;
      // The new answers replace the directions' earlier ones only now (a cancelled run keeps them).
      setCandidates((current) => {
        const next = { ...current };
        for (const direction of directions) {
          next[direction]?.forEach((candidate) => candidate.status === 'made' && drop(candidate.url));
          delete next[direction];
        }
        for (const outcome of outcomes) {
          const list = (next[outcome.job.direction] ??= []);
          list[outcome.job.candidate] =
            outcome.status === 'made'
              ? { status: 'made', blob: outcome.image, url: keep(outcome.image) }
              : { status: 'failed', message: outcome.message };
        }
        return next;
      });
      setPicked((current) => {
        const next = { ...current };
        for (const direction of directions) delete next[direction];
        return next;
      });
      setMadeWith(inputs);
      const failed = outcomes.filter((outcome) => outcome.status === 'failed');
      if (failed.length)
        setNotice(
          failed.length === outcomes.length
            ? `만들지 못했어요. ${failed[0].status === 'failed' ? failed[0].message : ''}`
            : `${outcomes.length}장 중 ${failed.length}장을 만들지 못했어요. ${failed[0].status === 'failed' ? failed[0].message : ''}`,
        );
    } catch (error) {
      if (alive.current)
        setNotice(
          abort.signal.aborted
            ? '취소했어요. 이미 보낸 요청은 사용량에 포함될 수 있어요.'
            : error instanceof Error
              ? error.message
              : '방향 사진을 만들지 못했어요.',
        );
    } finally {
      if (controller.current === abort) controller.current = null;
      if (alive.current) setRunning(undefined);
    }
  };

  const pickedDirections = plan.made.filter((direction) => picked[direction] !== undefined);
  const apply = async () => {
    if (!pickedDirections.length) return;
    const total = pickedDirections.length;
    const onFloor = standsOnFloor(installation);
    const photos: MadePhoto[] = [];
    try {
      for (const [index, direction] of pickedDirections.entries()) {
        setApplying(`고른 사진의 배경을 지우는 중이에요 ${index + 1}/${total}`);
        const candidate = candidates[direction]?.[picked[direction]!];
        if (candidate?.status !== 'made') continue;
        const blob = await cutout(candidate.blob);
        const { alpha, width, height } = await readAlpha(blob);
        const anchor = anchorFromAlpha(alpha, width, height, onFloor);
        if (!anchor)
          throw new Error(`‘${direction}’ 사진에서 제품을 찾지 못했어요. 다른 후보를 골라 주세요.`);
        photos.push({ direction, blob, anchor });
        if (direction === '왼쪽' && plan.mirrored.includes('오른쪽')) {
          const turned = await mirrorPng(blob);
          const mirrored = await readAlpha(turned);
          photos.push({
            direction: '오른쪽',
            blob: turned,
            anchor: anchorFromAlpha(mirrored.alpha, mirrored.width, mirrored.height, onFloor)!,
          });
        }
      }
      setApplying('방향 칸에 넣는 중이에요');
      await onApply(
        photos.sort(
          (a, b) => PRODUCT_DIRECTIONS.indexOf(a.direction) - PRODUCT_DIRECTIONS.indexOf(b.direction),
        ),
        useCover && refs[0] ? refs[0].file : undefined,
      );
      if (alive.current)
        setNotice(
          `${photos.map((photo) => photo.direction).join('·')} 칸에 넣었어요. 확인한 뒤 ‘자재 등록’을 눌러 주세요.`,
        );
    } catch (error) {
      if (alive.current) setNotice(error instanceof Error ? error.message : '사진을 넣지 못했어요.');
    } finally {
      if (alive.current) setApplying('');
    }
  };

  const busyText = useMemo(() => {
    if (running) return `만드는 중 ${running.done}/${running.total}`;
    return applying;
  }, [running, applying]);

  if (!kind) return null;
  const madeAny = Object.keys(candidates).length > 0;
  const status = (direction: ProductDirection) =>
    plan.made.includes(direction)
      ? `후보 ${DIRECTION_PHOTO_CANDIDATES}장을 만들어요`
      : plan.mirrored.includes(direction)
        ? '왼쪽 사진을 좌우 반전해 써요'
        : (plan.skipped.find((skip) => skip.direction === direction)?.reason ?? '');
  return (
    <details className={styles.promptGuide} data-testid="ai-direction-photos">
      <summary>AI로 방향 사진 만들기</summary>
      <p className={styles.note}>
        제품 사진 1~3장(어느 각도든, 연출 사진도 돼요)을 올리면 이 제품의 종류·크기에 맞춘 가이드 그림을
        기준으로 AI가 방향별 사진을 만들어요. 고른 사진은 배경을 지워 그 방향 칸에 넣어요. 저장은 ‘자재
        등록’을 눌러야 돼요.
      </p>
      <div className={styles.toolbar}>
        <label className="btn small">
          + 참고 사진 올리기(1~3장)
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            hidden
            aria-label="+ 참고 사진 올리기(1~3장)"
            disabled={disabled || refs.length >= MAX_REFS || !!running || !!applying}
            onChange={addRefs}
          />
        </label>
        <span className="muted">배경을 지워 흰 바탕으로 AI에 보내요(이 브라우저에서 지워요).</span>
      </div>
      {refNotice && (
        <p role="status" className={styles.promptNotice}>
          {refNotice}
        </p>
      )}
      {refs.length > 0 && (
        <div className={styles.aiRefRow}>
          {refs.map((ref, index) => (
            <figure key={ref.id} className={styles.aiRef}>
              {ref.url ? (
                <img src={ref.url} alt={`참고 사진 ${index + 1}(배경 지움)`} />
              ) : (
                <span className={styles.note}>
                  {ref.status === 'failed' ? ref.error : '배경을 지우는 중'}
                </span>
              )}
              {anglesTold && (
                <select
                  className="input"
                  aria-label={`참고 사진 ${index + 1} 찍은 각도`}
                  title="사진에서 제품의 앞이 향하는 쪽(방향 칸과 같은 이름)"
                  value={ref.angle}
                  disabled={!!running || !!applying}
                  onChange={(event) =>
                    setRefs((current) =>
                      current.map((item) =>
                        item.id === ref.id
                          ? { ...item, angle: event.target.value as DirectionPhotoPhotoAngle }
                          : item,
                      ),
                    )
                  }
                >
                  {DIRECTION_PHOTO_PHOTO_ANGLES.map((angle) => (
                    <option key={angle} value={angle}>
                      {PHOTO_ANGLE_LABELS[angle]}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className={styles.textButton}
                disabled={!!running || !!applying}
                onClick={() => removeRef(ref.id)}
              >
                참고 사진 {index + 1} 빼기
              </button>
            </figure>
          ))}
        </div>
      )}
      {removal && loading.visible && loading.snapshot && (
        <ModelLoadingProgress
          title="배경 제거 AI 모델 준비 중(처음 한 번만 내려받아요)"
          label="모델 다운로드 진행"
          snapshot={loading.snapshot}
        />
      )}
      {refs.length > 0 && (
        <label className={styles.aiCheck}>
          <input type="checkbox" checked={useCover} onChange={(event) => setUseCover(event.target.checked)} />
          첫 참고 사진을 대표 이미지로 쓰기
        </label>
      )}
      {kind === 'toilet' && (
        <p className={styles.note}>
          흰색이 아닌 변기(검정 몸통, 색 있는 시트 등)는 색을 골라 주세요. 사진만으로는 흰색으로 바뀌어 나오기
          쉬워요. 고르면 그 색을 AI에 알려요(사진대로면 알리지 않아요).
        </p>
      )}
      {refs.length > 0 && anglesTold && (
        <p className={styles.note}>
          찍은 각도는 사진에서 제품의 앞이 향하는 쪽이에요(방향 칸과 같은 이름). 이 몸통은 가이드가 제품과
          비슷해서 AI가 사진의 각도를 베끼기 쉬워요. 각도를 알려 주면 가이드의 시점으로 그려요.
        </p>
      )}
      <div className={styles.toolbar}>
        <label className="field">
          {kind === 'toilet' ? '몸통' : '모양'}
          <select
            className="input"
            aria-label={kind === 'toilet' ? '변기 몸통' : '가이드 모양'}
            value={shape}
            disabled={!!running}
            onChange={(event) => setChosen(event.target.value as DirectionPhotoForm)}
          >
            {forms.map((value) => (
              <option key={value} value={value}>
                {FORM_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        {lid && (
          <label className="field">
            뚜껑
            <select
              className="input"
              aria-label="변기 뚜껑"
              value={lid}
              disabled={!!running}
              onChange={(event) => setChosenLid(event.target.value as DirectionPhotoLid)}
            >
              {toiletLids(shape).map((value) => (
                <option key={value} value={value}>
                  {LID_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === 'toilet' && shape === 'two-piece' && (
          <label className="field">
            아래 모양
            <select
              className="input"
              aria-label="변기 아래 모양"
              title="물탱크 아래 몸통이 바닥까지 매끈하게 덮였으면 치마형이에요"
              value={chosenSkirt}
              disabled={!!running}
              onChange={(event) => setChosenSkirt(event.target.value as ToiletSkirt)}
            >
              {TOILET_SKIRTS.map((value) => (
                <option key={value} value={value}>
                  {TOILET_LABELS.skirt[value]}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === 'toilet' && (
          <label className="field">
            몸통 색
            <select
              className="input"
              aria-label="변기 몸통 색"
              value={chosenBody}
              disabled={!!running}
              onChange={(event) => setChosenBody(event.target.value as ToiletBodyColor | '')}
            >
              <option value="">사진대로</option>
              {TOILET_BODY_COLORS.map((value) => (
                <option key={value} value={value}>
                  {TOILET_LABELS.color[value]}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === 'toilet' && (
          <label className="field">
            {lid === 'seat' ? '시트 색' : '시트·뚜껑 색'}
            <select
              className="input"
              aria-label="변기 시트 색"
              value={chosenSeat}
              disabled={!!running}
              onChange={(event) => setChosenSeat(event.target.value as ToiletSeatColor | 'body' | '')}
            >
              <option value="">사진대로</option>
              <option value="body" disabled={!chosenBody}>
                몸통과 같음
              </option>
              {TOILET_SEAT_COLORS.filter((value) => value !== 'ivory').map((value) => (
                <option key={value} value={value}>
                  {TOILET_LABELS.color[value]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={styles.aiCheck}>
          <input
            type="checkbox"
            checked={symmetric}
            disabled={!!running}
            onChange={(event) => setSymmetric(event.target.checked)}
          />
          좌우 대칭 제품(오른쪽은 왼쪽 사진을 좌우 반전해 써요. 로고·글자가 있으면 끄세요)
        </label>
      </div>
      {!sized && (
        <p role="status" className={styles.promptNotice} data-testid="ai-size-notice">
          {entered
            ? `가로·높이·깊이는 ${DIRECTION_PHOTO_MIN_MM}~${DIRECTION_PHOTO_MAX_MM.toLocaleString('ko-KR')}mm로 넣어 주세요(지금 ${sizeText}). 이 제품의 실제 크기로 고쳐 주세요.`
            : '가로·높이·깊이를 넣어 주세요. 가이드 그림을 그 크기로 그려요.'}
        </p>
      )}
      {wallToilet && (
        <p role="status" className={styles.promptNotice}>
          벽걸이 변기는 아직 만들 수 없어요. 설치 방식이 바닥형인 변기만 가이드가 있어요.
        </p>
      )}
      {guideError && (
        <p role="alert" className={styles.promptNotice}>
          {guideError}
        </p>
      )}
      {guides && (
        <div className={styles.aiGuideRow} data-testid="ai-guides">
          {PRODUCT_DIRECTIONS.map((direction) => {
            const guide = guideOf(direction);
            const smaller = guide ? Math.round((1 - guide.share) * 100) : 0;
            return (
              <figure key={direction} className={styles.aiGuide}>
                {guideUrls[direction] && <img src={guideUrls[direction]} alt={`${direction} 가이드`} />}
                <figcaption>
                  <strong>{direction}</strong> · {status(direction)}
                  {smaller >= 3 && <span> · 방 화면에서 약 {smaller}% 작게 보여요</span>}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
      {guides && (
        <p className={styles.note} data-testid="ai-guide-size">
          {sizeText}로 그렸어요. 제품 크기와 다르면 위 크기 칸을 고쳐 주세요.
        </p>
      )}
      {estimate && (
        <p className={styles.note} data-testid="ai-estimate">
          AI 요청 {estimate.calls}회 · 약 {estimate.neurons.toLocaleString('ko-KR')}뉴런(추정, 하루 무료
          10,000뉴런) · 방향마다 후보 {DIRECTION_PHOTO_CANDIDATES}장
        </p>
      )}
      <div className={styles.toolbar}>
        <button
          type="button"
          className="btn primary small"
          disabled={!canMake}
          onClick={() => void make(plan.made)}
        >
          {madeAny ? '모두 다시 만들기' : '방향 사진 만들기'}
        </button>
        <AiLimitHint />
        {running && (
          <button type="button" className="btn small" onClick={() => controller.current?.abort()}>
            만들기 취소
          </button>
        )}
        {busyText && (
          <span role="status" className={styles.note}>
            {busyText}
          </span>
        )}
      </div>
      {notice && (
        <p role="status" className={styles.promptNotice} data-testid="ai-notice">
          {notice}
        </p>
      )}
      {madeAny && madeWith !== inputs && (
        <p role="status" className={styles.promptNotice}>
          모양·색·크기·설치 방식이 바뀌었어요. 지금 후보는 이전 설정으로 만든 것이에요.
        </p>
      )}
      {plan.made.map((direction) =>
        candidates[direction] ? (
          <div key={direction} className={styles.aiCandidates} role="group" aria-label={`${direction} 후보`}>
            <strong>{direction}</strong>
            <div className={styles.aiCandidateRow}>
              {candidates[direction]!.map((candidate, index) =>
                candidate.status === 'made' ? (
                  <button
                    key={index}
                    type="button"
                    className={`${styles.aiCandidate}${picked[direction] === index ? ` ${styles.aiPicked}` : ''}`}
                    aria-label={`${direction} 후보 ${index + 1}`}
                    aria-pressed={picked[direction] === index}
                    disabled={!!applying}
                    onClick={() => setPicked((current) => ({ ...current, [direction]: index }))}
                  >
                    {}
                    <img src={candidate.url} alt="" />
                  </button>
                ) : (
                  <span key={index} className={styles.promptNotice}>
                    후보 {index + 1}: {candidate.message}
                  </span>
                ),
              )}
            </div>
            <button
              type="button"
              className="btn small"
              disabled={!canMake}
              onClick={() => void make([direction])}
            >
              {direction} 다시 만들기
            </button>
            {direction === '왼쪽' && plan.mirrored.includes('오른쪽') && (
              <span className={styles.note}>오른쪽은 고른 왼쪽 사진을 좌우 반전해 넣어요.</span>
            )}
          </div>
        ) : null,
      )}
      {madeAny && (
        <div className={styles.toolbar}>
          <button
            type="button"
            className="btn primary small"
            disabled={!pickedDirections.length || !!running || !!applying || disabled}
            onClick={() => void apply()}
          >
            고른 사진 넣기
          </button>
          <span className="muted">
            {pickedDirections.length
              ? `고른 방향: ${pickedDirections.join('·')}${
                  pickedDirections.includes('왼쪽') && plan.mirrored.includes('오른쪽')
                    ? '(오른쪽은 왼쪽 반전)'
                    : ''
                }. 이미 있는 그 방향 사진은 바뀌어요.`
              : '방향마다 후보를 하나씩 골라 주세요.'}
          </span>
        </div>
      )}
      <p className={styles.promptNotice}>
        AI로 만든 사진은 실제 제품과 다를 수 있어요. 실제 제품과 비교해 확인하세요.
      </p>
      <p className={styles.note}>
        윗면이 보이는 만큼 방 화면에서는 조금 작게 보여요. 사진은 약 10° 위에서 본 모습으로 만들어요.
      </p>
    </details>
  );
}
