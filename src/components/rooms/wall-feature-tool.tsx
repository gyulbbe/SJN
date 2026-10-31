'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type RefObject,
} from 'react';
import { BrickWall, Magnet } from 'lucide-react';
import { getEditingScene } from '@/lib/comparison';
import { useEditor } from '@/lib/editor-store';
import type { FacePoint } from '@/lib/region-editing';
import type { RegionBounds } from '@/lib/room-surface-regions';
import type { RoomDimensions, RoomFace } from '@/lib/room-types';
import type { MaterialVersion, Scene } from '@/lib/types';
import {
  featureFields,
  featureFromClick,
  featureFromDrag,
  featureIssue,
  featureUv,
  isWallFace,
  movedFeature,
  putWallFeature,
  removeWallFeature,
  WALL_FACE_NOTE,
  wallFeatureDrawIssue,
  wallFeatureTitle,
  wallFeatureToolIssue,
  withFields,
  type WallFeatureFields,
} from '@/lib/wall-feature-editing';
import { WALL_FEATURE_MAX_DEPTH_MM, type WallFeatureFace, type WallFeatureV1 } from '@/lib/wall-features';

/** A wall-feature outline for a canvas to project: drawn, being edited or moved, or selected. */
export type WallFeatureShape = {
  face: WallFeatureFace;
  box: RegionBounds;
  /**
   * `draw` is being drawn, `edit` is typed into its card and `move` dragged (none in the scene yet);
   * `selected` is the picked feature as it is. Canvases mark it data-testid="wall-feature-<source>".
   */
  source: 'draw' | 'edit' | 'move' | 'selected';
  /** It would overlap or touch another feature (or is otherwise invalid). */
  warn: boolean;
};

const latestScene = () => {
  const state = useEditor.getState();
  return state.project ? getEditingScene(state.project, state.editing) : undefined;
};

/**
 * The wall-feature tool shared by the 2D and 3D editor canvases: the rectangle being drawn, the card
 * being typed into and the feature being moved live here, never in the scene, so neither the photo
 * nor the 3D room is prepared again until one change (one history step, one save) is applied.
 */
export function useWallFeatureTool({
  scene,
  materials,
  writable,
}: {
  scene?: Scene;
  materials: Record<string, MaterialVersion>;
  writable: boolean;
}) {
  const st = useEditor();
  const drawing = st.wallFeatureDrawing;
  const active = st.tool === 'wall-feature';
  const issue = wallFeatureToolIssue({ scene, writable, mode: st.mode, drafting: !!st.draft });
  // Another edit's open preview only pauses the tool; the rest turn it off.
  const blocked = wallFeatureToolIssue({ scene, writable, mode: st.mode, drafting: false });
  const [draw, setDraw] = useState<{ face: WallFeatureFace; from: FacePoint; to: FacePoint } | null>(null);
  const [edit, setEdit] = useState<{ feature: WallFeatureV1; isNew: boolean; error?: string } | null>(null);
  const [moving, setMoving] = useState<WallFeatureV1 | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    setDraw(null);
    setEdit(null);
    setMoving(null);
    setNote('');
  }, [st.tool, st.editing, st.project?.id, st.project?.activeDesignId, st.mode]);
  useEffect(() => {
    if (active && blocked) useEditor.getState().setTool('select');
  }, [active, blocked]);
  // Undo or Delete took away the feature whose card is open.
  const features = scene?.wallFeatures;
  useEffect(() => {
    if (edit && !edit.isNew && !features?.some((item) => item.id === edit.feature.id)) setEdit(null);
  }, [edit, features]);

  const room = scene?.room;
  const options = { depthMm: drawing.depthMm, snap: drawing.snap, materials };
  /** Starts a drawing where the pointer went down; false (with a note) when it cannot. */
  function start(face: RoomFace | null | undefined, uv: FacePoint | null | undefined): boolean {
    const problem =
      issue ??
      (scene && wallFeatureDrawIssue(scene)) ??
      (face && uv && isWallFace(face) ? null : WALL_FACE_NOTE);
    if (problem || !face || !uv || !isWallFace(face)) {
      setNote(problem ?? WALL_FACE_NOTE);
      return false;
    }
    setNote('');
    setEdit(null);
    setDraw({ face, from: uv, to: uv });
    return true;
  }
  function drag(to: FacePoint) {
    setDraw((current) => current && { ...current, to });
  }
  /** Let go: a drag (`to`) or a click (`to` null) opens the card on the feature it makes. */
  function place(face: WallFeatureFace, from: FacePoint, to: FacePoint | null) {
    setDraw(null);
    const latest = latestScene();
    if (!latest?.room) return;
    const made = to
      ? featureFromDrag(latest, face, from, to, options)
      : { feature: featureFromClick(latest.room, face, from, options) };
    if (!made.feature) return setNote(made.issue);
    const problem = featureIssue(latest.room, latest.wallFeatures, made.feature);
    if (problem) return setNote(problem);
    setNote('');
    useEditor.getState().select(null);
    setEdit({ feature: made.feature, isNew: true });
  }
  function cancelDraw() {
    setDraw(null);
  }
  /** Picks a feature of the scene: selected, its card open. */
  function open(id: string) {
    const feature = latestScene()?.wallFeatures?.find((item) => item.id === id);
    if (!feature) return;
    useEditor.getState().select(id);
    setNote('');
    setEdit({ feature: structuredClone(feature), isNew: false });
  }
  function startMove(id: string) {
    const feature = latestScene()?.wallFeatures?.find((item) => item.id === id);
    if (!feature) return undefined;
    useEditor.getState().select(id);
    setEdit(null);
    return structuredClone(feature);
  }
  /** The moved place, or the last free one when it would meet another feature. */
  function moveTo(original: WallFeatureV1, du: number, dv: number) {
    const latest = latestScene();
    if (!latest?.room) return;
    const next = movedFeature(original, latest.room, du, dv);
    if (!featureIssue(latest.room, latest.wallFeatures, next)) setMoving(next);
  }
  function endMove(commit: boolean) {
    const moved = moving;
    setMoving(null);
    if (commit && moved) write(moved);
  }
  /** One change (one history step, one save); a message when the scene refused it. */
  function write(feature: WallFeatureV1): string | null {
    const state = useEditor.getState();
    const latest = latestScene();
    if (!latest?.room) return null;
    const problem = featureIssue(latest.room, latest.wallFeatures, feature);
    if (problem) return problem;
    const previous = latest.wallFeatures?.find((item) => item.id === feature.id);
    if (JSON.stringify(previous) !== JSON.stringify(feature))
      try {
        state.change((draft) => putWallFeature(draft, feature));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    useEditor.getState().select(feature.id);
    return null;
  }
  function apply(feature: WallFeatureV1) {
    const error = write(feature);
    if (error) return setEdit((current) => current && { ...current, error });
    useEditor.getState().setWallFeatureDrawing({ depthMm: feature.depthMm });
    setEdit(null);
  }
  function remove(id: string) {
    useEditor.getState().change((draft) => removeWallFeature(draft, id));
    setEdit(null);
  }

  const shapes: WallFeatureShape[] = [];
  if (room && st.mode === 'after') {
    const shape = (feature: WallFeatureV1, source: WallFeatureShape['source']) => {
      const box = featureUv(feature, room);
      if (Object.values(box).every(Number.isFinite))
        shapes.push({
          face: feature.face,
          box,
          source,
          warn: source !== 'selected' && !!featureIssue(room, features, feature),
        });
    };
    const busy = edit?.feature.id ?? moving?.id;
    const selected = features?.find((item) => item.id === st.selection && item.id !== busy);
    if (selected && active) shape(selected, 'selected');
    if (draw && scene) {
      const made = featureFromDrag(scene, draw.face, draw.from, draw.to, options);
      if (made.feature) shape(made.feature, 'draw');
      else
        shapes.push({
          face: draw.face,
          source: 'draw',
          warn: false,
          box: {
            left: Math.min(draw.from.u, draw.to.u),
            right: Math.max(draw.from.u, draw.to.u),
            top: Math.min(draw.from.v, draw.to.v),
            bottom: Math.max(draw.from.v, draw.to.v),
          },
        });
    }
    if (edit) shape(edit.feature, 'edit');
    if (moving) shape(moving, 'move');
  }
  return {
    active,
    issue,
    note,
    shapes,
    edit,
    drawing: !!draw,
    start,
    drag,
    place,
    cancelDraw,
    open,
    startMove,
    moveTo,
    endMove,
    setEdit: (feature: WallFeatureV1) =>
      setEdit((current) => current && { ...current, feature, error: undefined }),
    closeEdit: () => setEdit(null),
    apply,
    remove,
  };
}
export type WallFeatureTool = ReturnType<typeof useWallFeatureTool>;

/** Projected outlines inside a canvas's SVG overlay (`scale` is its viewBox size); red when refused. */
export function WallFeaturePolygons({
  items,
  scale,
}: {
  items: (WallFeatureShape & { points: { x: number; y: number }[] })[];
  scale: number;
}) {
  return (
    <>
      {items.map((item) => (
        <polygon
          key={item.source}
          data-testid={'wall-feature-' + item.source}
          data-warn={item.warn ? 'true' : undefined}
          points={item.points.map((point) => point.x * scale + ',' + point.y * scale).join(' ')}
          fill={
            item.source === 'selected'
              ? 'none'
              : item.warn
                ? 'rgba(179, 68, 68, 0.18)'
                : 'rgba(43, 151, 129, 0.16)'
          }
          stroke={item.warn ? '#b34444' : '#2b9781'}
          strokeWidth="2"
          strokeDasharray="5 3"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      ))}
    </>
  );
}

/** The four corners of a face rectangle, cut to the face, in face UV. */
export const boxCorners = (box: RegionBounds) => {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return [
    { u: clamp(box.left), v: clamp(box.top) },
    { u: clamp(box.right), v: clamp(box.top) },
    { u: clamp(box.right), v: clamp(box.bottom) },
    { u: clamp(box.left), v: clamp(box.bottom) },
  ];
};

/**
 * While a drawing tool is on, a finger's move over the canvas is never a browser gesture: a quick
 * drag would otherwise start a fling that swallows the next tap (the card's 적용 button). Pointer
 * events still arrive; the canvas already has touch-action: none.
 */
export function useNoTouchGesture(element: RefObject<HTMLElement | null>, on: boolean) {
  useEffect(() => {
    const target = element.current;
    if (!on || !target) return;
    const stop = (event: TouchEvent) => event.preventDefault();
    target.addEventListener('touchmove', stop, { passive: false });
    return () => target.removeEventListener('touchmove', stop);
  }, [element, on]);
}

/** Stage pixels around a shape's projected corners, for placing the card beside it. */
export type StageBox = { left: number; top: number; right: number; bottom: number };
export function stageBox(points: { x: number; y: number }[]): StageBox | undefined {
  if (!points.length) return undefined;
  return {
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

const CARD_WIDTH = 264;
const shown = (value: number) => (Number.isFinite(value) ? String(+value.toFixed(1)) : '');

/**
 * A feature's number fields measured like a partial tile's (from the left end and the floor), depth
 * first. Typed text stays as typed and untouched fields keep their exact values; give it a `key` of
 * the feature's id so another feature starts afresh.
 */
export function WallFeatureFieldInputs({
  feature,
  room,
  onChange,
  focusDepth = false,
}: {
  feature: WallFeatureV1;
  room: RoomDimensions;
  onChange: (feature: WallFeatureV1) => void;
  focusDepth?: boolean;
}) {
  const [state, setState] = useState(() => {
    const values = featureFields(feature, room);
    return {
      values,
      text: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, shown(value)])) as Record<
        keyof WallFeatureFields,
        string
      >,
    };
  });
  const depth = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusDepth) return;
    depth.current?.focus();
    depth.current?.select();
  }, [focusDepth]);
  const input = (key: keyof WallFeatureFields, label: string) => (
    <label className="field" key={key}>
      {label} (mm)
      <input
        ref={key === 'depthMm' ? depth : undefined}
        className="input"
        type="number"
        inputMode="decimal"
        step="any"
        aria-label={label + ' (mm)'}
        value={state.text[key]}
        onChange={(event) => {
          const text = event.target.value;
          const values = { ...state.values, [key]: text === '' ? NaN : Number(text) };
          setState({ values, text: { ...state.text, [key]: text } });
          onChange(withFields(feature, values, room));
        }}
      />
    </label>
  );
  return (
    <>
      {input('depthMm', '깊이')}
      {input('leftMm', '왼쪽 끝에서')}
      {input('bottomMm', '바닥에서')}
      {input('widthMm', '폭')}
      {input('heightMm', '높이')}
    </>
  );
}

/**
 * The card a drawn, clicked or picked wall feature opens beside it (a sheet at the foot of a phone):
 * the depth first, then its place and size measured like a partial tile's. Enter applies, Esc cancels.
 */
export function WallFeatureCard({
  tool,
  room,
  anchor,
  stage,
}: {
  tool: WallFeatureTool;
  room: RoomDimensions;
  anchor?: StageBox;
  stage: { width: number; height: number };
}) {
  // Its own height, so it stays inside the stage beside the outline (fields and buttons all shown).
  const form = useRef<HTMLFormElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const measured = form.current?.offsetHeight ?? 0;
    if (measured !== height) setHeight(measured);
  }, [height, tool.edit]);
  const edit = tool.edit;
  if (!edit) return null;
  const feature = edit.feature;
  const problem = featureIssue(room, latestScene()?.wallFeatures, feature) ?? edit.error;
  const x = anchor
    ? anchor.right + 12 + CARD_WIDTH <= stage.width - 8
      ? anchor.right + 12
      : anchor.left - 12 - CARD_WIDTH
    : stage.width - CARD_WIDTH - 8;
  const y = anchor ? anchor.top : 8;
  const place = {
    '--card-x': Math.max(8, Math.min(stage.width - CARD_WIDTH - 8, x)) + 'px',
    '--card-y': Math.max(8, Math.min(stage.height - height - 8, y)) + 'px',
    '--card-h': Math.max(160, stage.height - 16) + 'px',
  } as CSSProperties;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!problem) tool.apply(feature);
  }
  return (
    <form
      ref={form}
      role="dialog"
      aria-label="벽 구조 입력"
      data-testid="wall-feature-card"
      noValidate
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        tool.closeEdit();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      style={place}
      className="absolute left-(--card-x) top-(--card-y) z-20 flex max-h-(--card-h) w-66 flex-col gap-2 overflow-y-auto rounded-[10px] border border-(--line) bg-white p-3 text-[13px] shadow-[0_6px_24px_#2b3d4330] max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:left-0 max-sm:top-auto max-sm:max-h-[65vh] max-sm:w-auto max-sm:rounded-b-none"
    >
      <strong className="text-[13px]">{wallFeatureTitle(feature)}</strong>
      <div className="grid grid-cols-2 gap-2">
        <WallFeatureFieldInputs
          key={feature.id}
          feature={feature}
          room={room}
          onChange={tool.setEdit}
          focusDepth
        />
      </div>
      <p className="m-0 text-[11px] leading-snug text-[#6b777a]">
        왼쪽은 방 안에서 이 벽을 마주 봤을 때의 왼쪽이에요. 깊이는 최대 {WALL_FEATURE_MAX_DEPTH_MM}mm.
        바닥에서를 0으로 넣으면 바닥까지 이어져요.
      </p>
      {problem && (
        <p role="alert" className="m-0 text-[12px] text-(--danger)">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-1.5">
        {!edit.isNew && (
          <button type="button" className="btn small danger mr-auto" onClick={() => tool.remove(feature.id)}>
            삭제
          </button>
        )}
        <button type="button" className="btn small" onClick={tool.closeEdit}>
          취소
        </button>
        <button type="submit" className="btn small primary" disabled={!!problem}>
          적용
        </button>
      </div>
    </form>
  );
}

/** The tool button: an icon in the 2D toolbar, words in the 3D one. */
export function WallFeatureToolButton({ tool, compact }: { tool: WallFeatureTool; compact: boolean }) {
  const st = useEditor();
  const title = tool.issue ?? '벽 구조: 벽을 끌거나 눌러 벽 홈을 만들어요';
  return (
    <button
      title={title}
      aria-label="벽 구조"
      aria-pressed={tool.active}
      data-testid="wall-feature-tool"
      disabled={!!tool.issue && !tool.active}
      className={
        compact ? `icon-btn ${tool.active ? 'active' : ''}` : `btn small ${tool.active ? 'active' : ''}`
      }
      onClick={() => st.setTool('wall-feature')}
    >
      {compact ? <BrickWall size={17} /> : '벽 구조'}
    </button>
  );
}

/** While the tool is on: grout snapping and what to do (or why not). */
export function WallFeatureToolOptions({ tool, compact }: { tool: WallFeatureTool; compact: boolean }) {
  const st = useEditor();
  const drawing = st.wallFeatureDrawing;
  if (!tool.active && !tool.note) return null;
  return (
    <>
      {tool.active && (
        <button
          title="경계를 바탕 타일 줄눈에 맞춤"
          aria-label="벽 구조 경계를 바탕 타일 줄눈에 맞춤"
          aria-pressed={drawing.snap}
          data-testid="wall-feature-snap"
          className={
            compact ? `icon-btn ${drawing.snap ? 'active' : ''}` : `btn small ${drawing.snap ? 'active' : ''}`
          }
          onClick={() => st.setWallFeatureDrawing({ snap: !drawing.snap })}
        >
          {compact ? <Magnet size={17} /> : '줄눈 맞춤'}
        </button>
      )}
      <span className="tool-label" role="status" data-testid="wall-feature-note">
        {tool.note || '벽을 끌거나 눌러서 놓아요. 놓인 구조는 눌러서 고쳐요.'}
      </span>
    </>
  );
}
