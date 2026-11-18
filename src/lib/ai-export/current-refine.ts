/**
 * The finishing steps of today's method (the model draws the fixtures too), after the backdrop is
 * back, with no AI call: the design's joints back on the faces whose joints the model moved
 * (joints.ts), walls and floor back to the render's colours (color.ts), then the white ceramics the
 * model drew much darker get their lightness back (fixture-light.ts).
 *
 * With `behind` (the render with its fixtures hidden and its regions) and `cuts` (fixture-outline.ts:
 * where the model drew its fixtures), every step uses the model's fixture outline instead of the
 * render's (docs/fixture-haze-20261116.md, F1), so no haze is left where the model drew wall, and the
 * fixture it drew (its taps included) keeps its edge. Without them, or when the model moved the
 * framing, the steps run on the render's outline as before.
 *
 * On the model's outline (docs/fixture-shadows-20261118.md, 2026-11-18) the faces are also restored
 * up to the fixtures, the backdrop and each other (joints.ts OUTLINE_RIMS), so the model's contact
 * shadows, the white it left by the backdrop and its lines along the corners do not stay as outlines;
 * then the ceramics' edges are mixed again over the finished wall (fixture-edge.ts) and their shading
 * narrowed toward the render's (fixture-body.ts).
 */
import {
  framing,
  projectCapture,
  projectMask,
  reviewResultColors,
  shiftMask,
  type ColorReview,
  type Pixels,
  type RegionMask,
} from './color';
import type { FluxInputLayout } from './contract';
import { finishFixtureBodies, type FixtureBody } from './fixture-body';
import { finishFixtureEdges } from './fixture-edge';
import { restoreFixtureLightness } from './fixture-light';
import { cutoutMask, type Cut, type FixtureOutline } from './fixture-outline';
import { OUTLINE_RIMS, restoreResultJoints, type JointRestore } from './joints';
import type { FluxFixture } from './scene-contract';

export type CurrentRefine = {
  joints?: JointRestore;
  review: ColorReview;
  ceramics?: ReturnType<typeof restoreFixtureLightness>;
  /** The picture to show (absent when nothing changed). */
  shown?: Pixels;
  /** The model's fixture outline, when it was used. */
  outline?: FixtureOutline;
  /** The ceramics whose shading was narrowed toward the render's (on the model's outline only). */
  bodies?: FixtureBody[];
};

export function refineCurrentResult(input: {
  /** The model's picture, its backdrop restored. */
  raw: Pixels;
  capture: Pixels;
  mask: RegionMask;
  layout: FluxInputLayout;
  /** The capture with widened joints (none: no joints put back). */
  joints?: Pixels;
  fixtures: readonly FluxFixture[];
  /** The capture with the fixtures hidden (their shadows kept) and its regions. */
  behind?: { image: Pixels; mask: RegionMask };
  cuts?: readonly Cut[];
}): CurrentRefine {
  const { raw, capture, mask, layout, fixtures } = input;
  const size = { width: raw.width, height: raw.height };
  const frame =
    input.joints || input.behind ? framing(projectCapture(capture, layout, size), raw) : undefined;
  const outline =
    input.behind && input.cuts && frame?.aligned
      ? cutoutMask({
          model: raw,
          renderMask: shiftMask(projectMask(mask, layout, size), frame.dx, frame.dy),
          behindMask: shiftMask(projectMask(input.behind.mask, layout, size), frame.dx, frame.dy),
          fixtures,
          cuts: input.cuts,
        })
      : undefined;
  const joints =
    input.joints && frame?.aligned
      ? restoreResultJoints({
          capture,
          joints: input.joints,
          mask,
          layout,
          result: raw,
          frame,
          ...(outline ? { behind: input.behind!.image, resultMask: outline.mask, rims: OUTLINE_RIMS } : {}),
        })
      : undefined;
  const review = reviewResultColors({
    capture,
    mask,
    layout,
    result: joints?.image ?? raw,
    // The same shift the joints were put back at (the search would only find it again).
    ...((joints?.image || outline) && frame ? { alignment: { dx: frame.dx, dy: frame.dy } } : {}),
    ...(outline ? { resultMask: outline.colourMask } : {}),
  });
  const corrected = review.corrected ?? joints?.image;
  const ceramics = review.framing.aligned
    ? restoreFixtureLightness({
        capture,
        mask,
        layout,
        fixtures,
        result: corrected ?? raw,
        frame: review.framing,
        ...(outline ? { resultMask: outline.colourMask } : {}),
      })
    : undefined;
  const finished = ceramics?.image ?? corrected;
  if (!outline || !finished || !input.cuts)
    return { joints, review, ceramics, shown: finished, ...(outline ? { outline } : {}) };
  const edges = finishFixtureEdges({ shown: finished, outline, cuts: input.cuts, fixtures });
  const bodies = finishFixtureBodies({
    result: edges.image,
    capture,
    mask,
    layout,
    fixtures,
    resultMask: outline.colourMask,
  });
  return { joints, review, ceramics, shown: bodies.image ?? edges.image, outline, bodies: bodies.fixtures };
}
