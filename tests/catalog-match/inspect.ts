/**
 * Round 9 (docs/catalog-match-trials-20261102.md): checking each face's piece before matching. The
 * segmentation's pixel labels as a blocked-point test (② 가리는 것 빼기), the share of a piece inside
 * annotated boxes (scoring only), and the fixed rule that turns Gemma's check of each piece into how
 * that face is matched and what is said about it (④, ⑤). Pure functions, used in node and the page.
 */
import {
  applyHomography,
  rgbToLab,
  squareToQuad,
  type Box,
  type Point,
  type Quad,
  type Rgba,
  type UvRect,
} from './tile-features';

export type Face = 'back' | 'left' | 'right' | 'floor';
/** The app's DeepLab ADE20K labels count background as 0 (`src/lib/segmentation/worker.ts`). */
export const LABEL = { wall: 1, floor: 4 } as const;
export type Labels = { data: ArrayLike<number>; width: number; height: number };

/** A point (0–1 in the photo) the segmentation does not call this face's wall or floor. */
export function labelBlocked(labels: Labels, face: Face): (p: Point) => boolean {
  const want = face === 'floor' ? LABEL.floor : LABEL.wall;
  return (p) => {
    const x = Math.min(labels.width - 1, Math.max(0, Math.floor(p.x * labels.width)));
    const y = Math.min(labels.height - 1, Math.max(0, Math.floor(p.y * labels.height)));
    return labels.data[y * labels.width + x] !== want;
  };
}

/** The share of a piece (its quad, sampled n×n in its own u-v) that falls inside any of the boxes. */
export function overlapShare(quad: Quad, boxes: Box[], n = 16): number {
  const m = squareToQuad(quad);
  let inside = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const p = applyHomography(m, { x: (i + 0.5) / n, y: (j + 0.5) / n });
      if (boxes.some((b) => p.x > b.left && p.x < b.right && p.y > b.top && p.y < b.bottom)) inside++;
    }
  return inside / (n * n);
}

export function rectIou(a: UvRect, b: UvRect): number {
  const w = Math.max(0, Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0));
  const h = Math.max(0, Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0));
  const area = (r: UvRect) => (r.u1 - r.u0) * (r.v1 - r.v0);
  return (w * h) / (area(a) + area(b) - w * h || 1);
}

/** The colour of a dirty piece: only its pixels between the 60th and 95th percentile of lightness. */
export function brightMask(image: Rgba, low = 0.6, high = 0.95): Uint8Array {
  const n = image.width * image.height;
  const lightness = new Float32Array(n);
  for (let i = 0; i < n; i++)
    lightness[i] = rgbToLab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2])[0];
  const sorted = Float32Array.from(lightness).sort();
  const lo = sorted[Math.floor(low * (n - 1))],
    hi = sorted[Math.floor(high * (n - 1))];
  return Uint8Array.from(lightness, (l) => (l >= lo && l <= hi ? 1 : 0));
}

// ---------- Gemma's check of each piece, and the rule ----------
export const CONTENTS = [
  'tile',
  'door',
  'shower_curtain',
  'glass_partition',
  'mirror',
  'window',
  'cabinet_or_shelf',
  'painted_wall',
  'other',
] as const;
export const VISIBLE = ['all', 'most', 'half', 'little', 'none'] as const;
export const STATES = ['clean', 'slightly_dirty', 'very_dirty', 'wet_or_reflective', 'unknown'] as const;
export const MARKS = [
  'none',
  'tile_design',
  'dirt_or_stain',
  'mould',
  'water_or_reflection',
  'mixed',
] as const;
export const CONFIDENCE = ['high', 'medium', 'low'] as const;
export type Inspection = {
  content: (typeof CONTENTS)[number];
  tile_visible: (typeof VISIBLE)[number];
  state: (typeof STATES)[number];
  marks: (typeof MARKS)[number];
  confidence: (typeof CONFIDENCE)[number];
};
export const notTile = (i: Inspection) =>
  i.content !== 'tile' || i.tile_visible === 'little' || i.tile_visible === 'none';
export const dirty = (i: Inspection) =>
  i.marks === 'dirt_or_stain' || i.marks === 'mould' || i.marks === 'mixed' || i.state === 'very_dirty';

/** 이 or 가 after a Korean word, by whether its last syllable has a final consonant. */
const subject = (word: string) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return word + (code >= 0 && code < 11172 && code % 28 === 0 ? '가' : '이');
};
const KO_FACE: Record<Face, string> = { back: '뒤 벽', left: '왼쪽 벽', right: '오른쪽 벽', floor: '바닥' };
const KO_CONTENT: Record<Inspection['content'], string> = {
  tile: '타일',
  door: '문',
  shower_curtain: '샤워 커튼',
  glass_partition: '유리 칸막이',
  mirror: '거울',
  window: '창',
  cabinet_or_shelf: '수납장·선반',
  painted_wall: '칠한 벽',
  other: '타일이 아닌 것',
};
const KO_VISIBLE: Record<Inspection['tile_visible'], string> = {
  all: '타일이 다 보임',
  most: '타일이 대부분 보임',
  half: '타일이 절반쯤 보임',
  little: '타일이 조금 보임',
  none: '타일이 안 보임',
};
const KO_STATE: Record<Inspection['state'], string> = {
  clean: '깨끗함',
  slightly_dirty: '조금 더러움',
  very_dirty: '많이 더러움',
  wet_or_reflective: '젖거나 반사됨',
  unknown: '상태 모름',
};

export type FaceCheck = {
  face: Face;
  /** ② left a piece of at least 300 × 300 mm. */
  usable: boolean;
  inspection?: Inspection;
};
export type Decision = {
  face: Face;
  /** own: the fused first; colour: colour only (bright pixels); borrow: another wall's tile; keep: own, unsure. */
  mode: 'own' | 'colour' | 'borrow' | 'keep';
  from?: Face;
  confidence: 'high' | 'medium' | 'low';
  seen?: string;
  state?: string;
  reason: string;
};

const VISIBLE_RANK = { all: 0, most: 1, half: 2, little: 3, none: 4 };
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };

/**
 * ④ How each face of one photo is matched, fixed before round 9 ran:
 * - not tile (content is not tile, tile little or none visible, or no usable piece): a wall takes the
 *   tile of the photo's best-checked usable tile wall; a floor, or a wall with none, keeps its own (low);
 * - dirty (dirt, mould or mixed marks, or very dirty): colour only;
 * - otherwise the fused first. High confidence only for a clean piece seen high with all or most tile.
 */
export function decide(faces: FaceCheck[]): Decision[] {
  const good = (f: FaceCheck) => f.usable && f.inspection && !notTile(f.inspection);
  return faces.map((f): Decision => {
    const i = f.inspection;
    const seen = i ? `${KO_CONTENT[i.content]}, ${KO_VISIBLE[i.tile_visible]}` : undefined;
    const state = i ? KO_STATE[i.state] : undefined;
    if (!f.usable || (i && notTile(i))) {
      const why = !f.usable
        ? '가리는 것을 빼니 타일이 거의 남지 않음'
        : `주로 ${subject(KO_CONTENT[i!.content])} 보임`;
      const donor =
        f.face === 'floor'
          ? undefined
          : faces
              .filter((o) => o.face !== 'floor' && o.face !== f.face && good(o))
              .sort(
                (a, b) =>
                  VISIBLE_RANK[a.inspection!.tile_visible] - VISIBLE_RANK[b.inspection!.tile_visible] ||
                  CONFIDENCE_RANK[a.inspection!.confidence] - CONFIDENCE_RANK[b.inspection!.confidence] ||
                  Number(dirty(a.inspection!)) - Number(dirty(b.inspection!)),
              )[0];
      if (donor)
        return {
          face: f.face,
          mode: 'borrow',
          from: donor.face,
          confidence: 'low',
          seen,
          state,
          reason: `${why}. ${KO_FACE[donor.face]}에서 고른 타일을 씀`,
        };
      return {
        face: f.face,
        mode: 'keep',
        confidence: 'low',
        seen,
        state,
        reason: `${why}. 쓸 다른 면이 없어 보이는 부분으로 고름(확신 낮음)`,
      };
    }
    if (!i) return { face: f.face, mode: 'own', confidence: 'medium', reason: '점검 답이 없어 그대로 고름' };
    if (dirty(i))
      return {
        face: f.face,
        mode: 'colour',
        confidence: 'medium',
        seen,
        state,
        reason: '때·얼룩이 보여 무늬는 보지 않고 밝은 부분의 색으로 고름',
      };
    return {
      face: f.face,
      mode: 'own',
      confidence:
        i.confidence === 'high' && (i.tile_visible === 'all' || i.tile_visible === 'most')
          ? 'high'
          : 'medium',
      seen,
      state,
      reason: '타일이 잘 보여 색·무늬로 고름',
    };
  });
}
