import { FLUX_PROMPT } from './contract';
import type { FluxFixture, FluxFixtureKind, FluxScene, FluxSurface } from './scene-contract';

/** Workers AI does not document a prompt limit; stay well inside typical text-encoder budgets. */
export const FLUX_PROMPT_MAX_CHARS = 2400;

const NOUNS: Record<FluxFixtureKind, string> = {
  toilet: 'toilet',
  basin: 'washbasin',
  vanity: 'bathroom vanity cabinet with a basin',
  bath: 'bathtub',
  shower: 'shower set',
  faucet: 'faucet',
  mirror: 'mirror',
  mirrorCabinet: 'mirror cabinet',
  wallCabinet: 'wall cabinet',
  wallShelf: 'wall shelf',
  glassPartition: 'glass shower partition',
  lowPartition: 'low partition wall',
  showerCurtain: 'shower curtain',
  door: 'door',
  window: 'window',
};
/** Small or easily confused objects first: they are the ones the model tends to replace. */
export const FLUX_KIND_PRIORITY: Record<FluxFixtureKind, number> = {
  toilet: 0,
  basin: 1,
  vanity: 1,
  bath: 2,
  shower: 3,
  faucet: 4,
  mirror: 5,
  mirrorCabinet: 5,
  wallCabinet: 6,
  wallShelf: 6,
  glassPartition: 7,
  lowPartition: 7,
  showerCurtain: 7,
  door: 8,
  window: 8,
};
const FACE_WORDS = { floor: 'floor', back: 'back wall', left: 'left wall', right: 'right wall' } as const;

/** A plain colour word plus the exact hex; FLUX.2 follows hex values in prompts. */
export function colorWords(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    light = (max + min) / 2,
    delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
  let word: string;
  if (saturation < 0.14 || delta < 0.06)
    word =
      light > 0.92
        ? 'white'
        : light > 0.86
          ? 'off-white'
          : light > 0.6
            ? 'light grey'
            : light > 0.36
              ? 'grey'
              : light > 0.16
                ? 'dark grey'
                : 'black';
  else {
    const hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    const degrees = hue * 60;
    const name =
      degrees < 15 || degrees >= 345
        ? 'red'
        : degrees < 40
          ? light > 0.6
            ? 'beige'
            : 'brown'
          : degrees < 65
            ? light > 0.6
              ? 'cream'
              : 'olive'
            : degrees < 170
              ? 'green'
              : degrees < 200
                ? 'teal'
                : degrees < 255
                  ? 'blue'
                  : degrees < 290
                    ? 'purple'
                    : 'pink';
    word = `${light > 0.72 ? 'light ' : light < 0.3 ? 'dark ' : ''}${name}`;
  }
  return `${word} (${hex})`;
}

function place([left, top, right, bottom]: FluxFixture['box']) {
  const x = (left + right) / 2,
    y = (top + bottom) / 2;
  const horizontal = x < 0.36 ? 'left' : x > 0.64 ? 'right' : 'centre';
  const vertical = y < 0.36 ? 'upper' : y > 0.64 ? 'lower' : 'middle';
  return vertical === 'middle' && horizontal === 'centre'
    ? 'centre'
    : vertical === 'middle'
      ? `${horizontal} side`
      : horizontal === 'centre'
        ? `${vertical} centre`
        : `${vertical} ${horizontal}`;
}
const percent = (value: number) => Math.round(value * 100);

function fixtureSentence(fixture: FluxFixture, index: number, detailed: boolean): string {
  const noun = NOUNS[fixture.kind];
  const forms = fixture.forms.length ? `${fixture.forms.join(', ')} ` : '';
  const [left, top, right, bottom] = fixture.box;
  const where = detailed
    ? `at the ${place(fixture.box)} of image 0 (x ${percent(left)}–${percent(right)}%, y ${percent(top)}–${percent(bottom)}%), on the ${FACE_WORDS[fixture.face]}`
    : `at the ${place(fixture.box)} of image 0`;
  const size = detailed
    ? `, about ${fixture.sizeMm.map((value) => Math.round(value)).join(' × ')} mm (W × H × D)`
    : '';
  return `${index}. A ${colorWords(fixture.color)} ${fixture.finish} ${forms}${noun} ${where}${size}. It must remain a ${noun} in the same place and size.`;
}

function surfaceSentence(surface: FluxSurface): string {
  const faces = surface.faces.map((face) => FACE_WORDS[face]).join(' and ');
  const grout =
    surface.groutMm > 0
      ? `, ${colorWords(surface.groutColor)} grout ${Math.round(surface.groutMm * 10) / 10} mm`
      : ', no visible grout';
  return `${faces[0].toUpperCase()}${faces.slice(1)}: ${colorWords(surface.color)} ${surface.finish} tiles, ${surface.tileMm.map((value) => Math.round(value)).join(' × ')} mm, ${surface.pattern === 'brick' ? 'staggered' : 'grid'} layout${grout}.`;
}

/** Deterministic: the same scene always yields the same text. Fixtures keep the order given. */
export function buildFluxPrompt(scene: FluxScene | undefined): string {
  if (!scene || (!scene.fixtures.length && !scene.surfaces.length)) return FLUX_PROMPT;
  const counts = new Map<string, number>();
  for (const fixture of scene.fixtures)
    counts.set(NOUNS[fixture.kind], (counts.get(NOUNS[fixture.kind]) ?? 0) + 1);
  const summary = scene.fixtures.length
    ? `Image 0 contains exactly these fixtures: ${[...counts].map(([noun, count]) => `${count} ${noun}${count > 1 ? 's' : ''}`).join(', ')}. Each one keeps its type, position, size, shape and colour; no fixture turns into a different object and nothing is added.`
    : '';
  const surfaces = scene.surfaces.map(surfaceSentence);
  const compose = (listed: number, detailed: number, withSurfaces: boolean) =>
    [
      FLUX_PROMPT,
      ...scene.fixtures.slice(0, listed).map((fixture, i) => fixtureSentence(fixture, i + 1, i < detailed)),
      summary,
      ...(withSurfaces ? surfaces : []),
    ]
      .filter(Boolean)
      .join(' ');
  // Shorten the least important fixture's detail first, then the tile notes, then list fewer
  // fixtures. The summary with every count always stays, so nothing is silently dropped.
  const all = scene.fixtures.length;
  for (let detailed = all; detailed >= 0; detailed--) {
    const text = compose(all, detailed, true);
    if (text.length <= FLUX_PROMPT_MAX_CHARS) return text;
  }
  for (let listed = all; listed >= 0; listed--) {
    const text = compose(listed, 0, false);
    if (text.length <= FLUX_PROMPT_MAX_CHARS) return text;
  }
  return compose(0, 0, false).slice(0, FLUX_PROMPT_MAX_CHARS);
}
