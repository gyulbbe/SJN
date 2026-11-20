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
 *
 * Since 2026-11-20 (docs/fixture-shape-20261120.md, fixture-shape.ts) a thin piece the model drew
 * sticking up out of a fixture (an invented tap) leaves its cut-out (T1), and a ceramic the model drew
 * as metal (a thin side-on basin drawn as a towel bar) goes back as the render's fixture: the steps run
 * again without its cut-out and the render's pixels go on, in the model's light (P1).
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
import {
  metalCeramics,
  metalScores,
  pasteRenderFixtures,
  trimProtrusions,
  type TrimmedPiece,
} from './fixture-shape';
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
  /** Thin pieces taken out of the cut-outs (T1). */
  trimmed?: TrimmedPiece[];
  /** The ceramics the model drew as metal, put back as the render's (P1). */
  metal?: number[];
};

/**
 * How far the steps take the model's picture back toward the design (docs/refine-level-20261120.md);
 * every field absent keeps the app's own values.
 */
export type RefineTuning = {
  /** A restored face's share of the model's light shape (joints.ts RESTORE_LIGHT_KEEP). */
  lightKeep?: number;
  /** A restored face's share of the model's own fine detail (joints.ts restoreJoints, 0). */
  aiDetail?: number;
  /** The least a ceramic's shading below and above its median is narrowed to (fixture-body.ts). */
  bodyDark?: number;
  bodyBright?: number;
  /** How much of a darker ceramic median is raised to the render's (fixture-body.ts, 1). */
  bodyRaise?: number;
  /** How much of the lightness the walls' rule gives back a ceramic gets (fixture-light.ts, 1). */
  ceramicShare?: number;
};

type RefineInput = {
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
  tuning?: RefineTuning;
};

export function refineCurrentResult(input: RefineInput): CurrentRefine {
  const first = refineSteps(input);
  if (!first.outline || !first.shown || !input.cuts) return first;
  const metal = metalCeramics(
    metalScores({ ...input, shown: first.shown, colourMask: first.outline.colourMask }),
  );
  if (!metal.size) return first;
  const again = refineSteps({ ...input, cuts: input.cuts.filter((cut) => !metal.has(cut.fixture)) });
  if (!again.shown || !again.review.framing.aligned) return first;
  const { dx, dy } = again.review.framing;
  return {
    ...again,
    shown: pasteRenderFixtures({ ...input, shown: again.shown, metal, dx, dy }),
    metal: [...metal],
  };
}

function refineSteps(input: RefineInput): CurrentRefine {
  const { raw, capture, mask, layout, fixtures } = input;
  const tuning = input.tuning ?? {};
  const size = { width: raw.width, height: raw.height };
  const frame =
    input.joints || input.behind ? framing(projectCapture(capture, layout, size), raw) : undefined;
  const renderMask = frame?.aligned
    ? shiftMask(projectMask(mask, layout, size), frame.dx, frame.dy)
    : undefined;
  const trim =
    input.behind && input.cuts && renderMask
      ? trimProtrusions({ cuts: input.cuts, renderMask, fixtures })
      : undefined;
  const cuts = trim?.cuts ?? input.cuts;
  const outline =
    input.behind && cuts && frame?.aligned && renderMask
      ? cutoutMask({
          model: raw,
          renderMask,
          behindMask: shiftMask(projectMask(input.behind.mask, layout, size), frame.dx, frame.dy),
          fixtures,
          cuts,
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
          ...(tuning.lightKeep !== undefined ? { lightKeep: tuning.lightKeep } : {}),
          ...(tuning.aiDetail ? { aiDetail: tuning.aiDetail } : {}),
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
        ...(tuning.ceramicShare !== undefined ? { share: tuning.ceramicShare } : {}),
      })
    : undefined;
  const finished = ceramics?.image ?? corrected;
  const trimmed = trim?.trimmed.length ? { trimmed: trim.trimmed } : {};
  if (!outline || !finished || !cuts)
    return { joints, review, ceramics, shown: finished, ...(outline ? { outline } : {}), ...trimmed };
  const edges = finishFixtureEdges({ shown: finished, outline, cuts, fixtures });
  const bodies = finishFixtureBodies({
    result: edges.image,
    capture,
    mask,
    layout,
    fixtures,
    resultMask: outline.colourMask,
    ...(tuning.bodyDark !== undefined ? { dark: tuning.bodyDark } : {}),
    ...(tuning.bodyBright !== undefined ? { bright: tuning.bodyBright } : {}),
    ...(tuning.bodyRaise !== undefined ? { raise: tuning.bodyRaise } : {}),
  });
  return {
    joints,
    review,
    ceramics,
    shown: bodies.image ?? edges.image,
    outline,
    bodies: bodies.fixtures,
    ...trimmed,
  };
}
