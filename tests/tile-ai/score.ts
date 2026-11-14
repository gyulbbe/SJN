/**
 * The tile AI trial's automatic "joint score" (docs/tile-ai-trials-20261113.md, round 0), free of I/O:
 * how well the fine lines of a result lie where a reference picture of the same view has them, face by
 * face. The reference is the app's capture with the joints drawn wide enough to see, so a face the
 * model re-laid at another tile size, or left plain, scores low. A number for screening only; what
 * counts is the person's rating.
 */
import type { FaceScore } from '../../src/lib/ai-export/joints';

// The score itself is the app's since 2026-11-14 (it picks the faces whose joints go back).
export { edgeField, faceScores, type FaceScore } from '../../src/lib/ai-export/joints';

/** The faces' scores as one number for the walls and one for the floor, weighted by size. */
export function summary(scores: readonly FaceScore[]) {
  const mean = (kind: 'wall' | 'floor') => {
    const rows = scores.filter((row) => row.kind === kind);
    const pixels = rows.reduce((sum, row) => sum + row.pixels, 0);
    return pixels ? +(rows.reduce((sum, row) => sum + row.score * row.pixels, 0) / pixels).toFixed(3) : NaN;
  };
  return { wall: mean('wall'), floor: mean('floor') };
}
