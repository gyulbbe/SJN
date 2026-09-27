import { FLUX_PROMPT } from './contract';
import type { FluxCeiling, FluxFixture, FluxFixtureKind, FluxScene, FluxSurface } from './scene-contract';

/** Workers AI does not document a prompt limit; stay well inside typical text-encoder budgets. */
export const FLUX_PROMPT_MAX_CHARS = 2400;

/** English names of the fixture kinds, shared with the result check. */
export const FLUX_KIND_NOUNS: Record<FluxFixtureKind, string> = {
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

/** Whether a colour reads as grey/white/black (low saturation), the case the model tends to warm. */
function achromatic(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    light = (max + min) / 2,
    delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
  return saturation < 0.14 || delta < 0.06;
}

/**
 * A plain colour word plus the exact hex; FLUX.2 follows hex values in prompts. Very light greys
 * are "white": "off-white" read as cream or beige to the model (stage-3 white walls came back beige).
 */
export function colorWords(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    light = (max + min) / 2,
    delta = max - min;
  let word: string;
  if (achromatic(hex))
    word =
      light > 0.86
        ? 'white'
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
  const noun = FLUX_KIND_NOUNS[fixture.kind];
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

/**
 * One tile surface, colour first and held to image 0. `compact` keeps only the colour, for long
 * prompts: the colour sentence is the last thing to go.
 */
function surfaceSentence(surface: FluxSurface, compact = false): string {
  const faces = surface.faces.map((face) => FACE_WORDS[face]).join(' and ');
  const name = `${faces[0].toUpperCase()}${faces.slice(1)}`;
  const keep = achromatic(surface.color)
    ? `Keep this exact ${colorWords(surface.color).replace(/ \(.*$/, '')} as it appears in image 0; do not warm, yellow or tint it.`
    : 'Keep this exact colour as it appears in image 0; do not change its hue or saturation.';
  if (compact) return `${name}: ${colorWords(surface.color)} tiles. ${keep}`;
  const grout =
    surface.groutMm > 0
      ? `, ${colorWords(surface.groutColor)} grout ${Math.round(surface.groutMm * 10) / 10} mm`
      : ', no visible grout';
  return `${name}: ${colorWords(surface.color)} ${surface.finish} tiles, ${surface.tileMm.map((value) => Math.round(value)).join(' × ')} mm, ${surface.pattern === 'brick' ? 'staggered' : 'grid'} layout${grout}. ${keep}`;
}

/** An in-room view shows the ceiling: said plainly, as it is, so the model has nothing to invent there. */
export function ceilingSentence(ceiling: FluxCeiling): string {
  return `The ceiling is plain ${colorWords(ceiling.color)} paint with one flat square light panel.`;
}

/**
 * The composite export's instruction: the room is sent without fixtures and they are put back on
 * top afterwards, so nothing may be drawn in it. No fixture is described (a described fixture gets
 * drawn); what must not be added is named instead. With placeholders, the grey stand-ins stay grey.
 */
export const FLUX_EMPTY_ROOM_PROMPT = `Edit image 0 into a photorealistic photograph of the same bathroom interior, photographed on site by an architectural photographer. Preserve exactly the camera viewpoint, framing, room geometry, walls, floor and ceiling. Preserve the selected materials, tile colors, tile dimensions, grout pattern and spacing. The room has no fixtures and no furniture: do not add a shower, shower head, glass partition, faucet, shelf, toilet, washbasin, bathtub, cabinet, mirror, towel rail, window, door or any furniture. Only improve photographic realism: physically plausible lighting, soft shadows and subtle material texture. Natural exposure and neutral white balance. Do not add people, text, labels or watermarks.`;
export const FLUX_PLACEHOLDER_SENTENCE =
  'The flat grey shapes are placeholders for fixtures that are added later: keep each one in the same place and size as a plain matte grey shape with a soft contact shadow, and do not turn it into an object.';
function buildEmptyRoomPrompt(scene: FluxScene, mode: NonNullable<FluxScene['mode']>): string {
  const compose = (compact: boolean) =>
    [
      FLUX_EMPTY_ROOM_PROMPT,
      mode === 'placeholders' ? FLUX_PLACEHOLDER_SENTENCE : '',
      ...scene.surfaces.map((surface) => surfaceSentence(surface, compact)),
      scene.ceiling ? ceilingSentence(scene.ceiling) : '',
    ]
      .filter(Boolean)
      .join(' ');
  const text = compose(false);
  if (text.length <= FLUX_PROMPT_MAX_CHARS) return text;
  const short = compose(true);
  return short.length <= FLUX_PROMPT_MAX_CHARS ? short : short.slice(0, FLUX_PROMPT_MAX_CHARS);
}

/**
 * Deterministic: the same scene always yields the same text. The walls' and floor's colours come
 * right after the fixed instruction (the model weighs early text more), then the ceiling of an
 * in-room view, the fixtures in the order given and the count summary.
 */
export function buildFluxPrompt(scene: FluxScene | undefined): string {
  if (scene?.mode) return buildEmptyRoomPrompt(scene, scene.mode);
  if (!scene || (!scene.fixtures.length && !scene.surfaces.length && !scene.ceiling)) return FLUX_PROMPT;
  const counts = new Map<string, number>();
  for (const fixture of scene.fixtures)
    counts.set(FLUX_KIND_NOUNS[fixture.kind], (counts.get(FLUX_KIND_NOUNS[fixture.kind]) ?? 0) + 1);
  const summary = scene.fixtures.length
    ? `Image 0 contains exactly these fixtures: ${[...counts].map(([noun, count]) => `${count} ${noun}${count > 1 ? 's' : ''}`).join(', ')}. Each one keeps its type, position, size, shape and colour; no fixture turns into a different object and nothing is added.`
    : '';
  const compose = (listed: number, detailed: number, compact: boolean) =>
    [
      FLUX_PROMPT,
      ...scene.surfaces.map((surface) => surfaceSentence(surface, compact)),
      scene.ceiling ? ceilingSentence(scene.ceiling) : '',
      ...scene.fixtures.slice(0, listed).map((fixture, i) => fixtureSentence(fixture, i + 1, i < detailed)),
      summary,
    ]
      .filter(Boolean)
      .join(' ');
  // Shorten the least important fixture's detail first, then list fewer fixtures, then keep only
  // the tile colours. The summary with every count and the colours always stay.
  const all = scene.fixtures.length;
  for (let detailed = all; detailed >= 0; detailed--) {
    const text = compose(all, detailed, false);
    if (text.length <= FLUX_PROMPT_MAX_CHARS) return text;
  }
  for (let listed = all; listed >= 0; listed--) {
    const text = compose(listed, 0, false);
    if (text.length <= FLUX_PROMPT_MAX_CHARS) return text;
  }
  const text = compose(0, 0, true);
  return text.length <= FLUX_PROMPT_MAX_CHARS ? text : text.slice(0, FLUX_PROMPT_MAX_CHARS);
}
