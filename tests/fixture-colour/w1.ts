/**
 * W1 of the fixture-colour trial (docs/fixture-colour-20261115.md): the white ceramics' lightness back.
 * Adopted 2026-11-15; the step is the app's own (src/lib/ai-export/fixture-light.ts), re-exported here
 * so the trial's tools (pictures.ts, w2.ts) draw exactly what the app draws.
 */
export {
  CERAMIC_KINDS,
  fixtureMask,
  MIN_FIXTURE_PIXELS,
  type FixtureLight as FixtureChange,
} from '../../src/lib/ai-export/fixture-light';
import { restoreFixtureLightness as appStep } from '../../src/lib/ai-export/fixture-light';

/** The trial's name for the app's step; `changes` is the app's `fixtures`. */
export function restoreFixtureLightness(input: Parameters<typeof appStep>[0]) {
  const out = appStep(input);
  return { image: out.image, changes: out.fixtures };
}
