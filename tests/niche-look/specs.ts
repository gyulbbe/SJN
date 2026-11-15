/**
 * The niche-look trial's scenes (docs/niche-look-20261115.md): the ledge trial's two scenes with a
 * niche (tests/ledge-ai/specs.ts) and the same back-wall niche alone.
 */
import type { SceneSpec } from '../export-photoreal/scene-builder';
import { SPECS as LEDGE_SPECS } from '../ledge-ai/specs';

const structure = LEDGE_SPECS.find((s) => s.id === 'structure')!;
const busy = LEDGE_SPECS.find((s) => s.id === 'busy')!;
export const SPECS: SceneSpec[] = [
  structure,
  { ...structure, id: 'niche-only', features: structure.features!.filter((f) => f.kind === 'closed-niche') },
  { ...busy, holdout: false },
];
