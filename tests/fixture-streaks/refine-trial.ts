/**
 * Trial copy of the app's refineCurrentResult (src/lib/ai-export/current-refine.ts) on the trial outline
 * rule (outline-method.ts). With `pieces` off it is the app, pixel for pixel.
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
} from '../../src/lib/ai-export/color';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import { restoreFixtureLightness } from '../../src/lib/ai-export/fixture-light';
import type { Cut, FixtureOutline } from '../../src/lib/ai-export/fixture-outline';
import { cutoutMaskTrial } from './outline-method';
import { restoreResultJoints, type JointRestore } from '../../src/lib/ai-export/joints';
import type { FluxFixture } from '../../src/lib/ai-export/scene-contract';

type CurrentRefine = {
  joints?: JointRestore;
  review: ColorReview;
  ceramics?: ReturnType<typeof restoreFixtureLightness>;
  /** The picture to show (absent when nothing changed). */
  shown?: Pixels;
  /** The model's fixture outline, when it was used. */
  outline?: FixtureOutline;
};

export function refineTrial(input: {
  pieces?: boolean;
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
      ? cutoutMaskTrial({
          pieces: input.pieces,
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
          ...(outline ? { behind: input.behind!.image, resultMask: outline.mask } : {}),
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
  return { joints, review, ceramics, shown: ceramics?.image ?? corrected, ...(outline ? { outline } : {}) };
}
