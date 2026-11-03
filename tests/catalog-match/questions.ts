/**
 * The questions of the catalog-match trial's AI rounds: the same words for every photo, no answer and no
 * answer-sheet text in them, and the request shape of each model (Gemma, Llama, Clef).
 */
import { CONFIDENCE, CONTENTS, MARKS, STATES, VISIBLE } from './inspect';

export const TILE_TEXT =
  'The left panel labelled PHOTO is a tiled wall or floor cut out of a bathroom photo and straightened. The 12 numbered squares on the right are catalogue tiles, each drawn repeated with its joints over the same 900 mm square. Which number is the same tile as in the photo, judging colour, pattern, veining and finish (the photo may be darker or tinted by its light)? Answer 0 if none of them is close.';
export const PRODUCT_TEXT =
  'The left panel labelled PHOTO is a bathroom product cut out of a photo. The numbered pictures on the right are catalogue products of the same kind, each shown from the front on white. Which number is the most similar product, judging overall shape, outline, tank or bowl shape, base and colour? Answer 0 if none of them is close (for example a clearly different colour or form).';
export const POSITION_TEXT =
  'This bathroom photo has numbered red boxes around products. For each box, say which wall of the room the product is installed against or stands in front of — back (the wall the camera faces), left or right — and where along that wall it is as the photo shows the wall: left, middle or right third.';
export const gemmaInput = (text: string, image: string, schema: object) => ({
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: image } },
      ],
    },
  ],
  stream: false,
  temperature: 0,
  max_completion_tokens: 400,
  chat_template_kwargs: { enable_thinking: false },
  response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } },
});
export const choiceSchema = (max: number) => ({
  type: 'object',
  properties: {
    choice: { type: 'integer', minimum: 0, maximum: max },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['choice', 'confidence'],
  additionalProperties: false,
});
export const positionSchema = (n: number) => ({
  type: 'object',
  properties: {
    items: {
      type: 'array',
      minItems: n,
      maxItems: n,
      items: {
        type: 'object',
        properties: {
          box: { type: 'integer', minimum: 1, maximum: n },
          wall: { type: 'string', enum: ['back', 'left', 'right'] },
          third: { type: 'string', enum: ['left', 'middle', 'right'] },
        },
        required: ['box', 'wall', 'third'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
});
/** Llama 3.2 Vision: the same words and image, JSON asked for in the text (no schema option). */
export const llamaInput = (text: string, image: string) => ({
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: image } },
      ],
    },
  ],
  temperature: 0,
  max_tokens: 400,
});
export const clefInput = (
  model: string,
  text: string,
  image: string,
  questions: Record<string, unknown>,
) => ({
  model,
  state: text,
  questions,
  images: [image],
});
export const clefChoices = (count: number) =>
  Object.fromEntries([
    ...Array.from({ length: count }, (_, i) => [String(i + 1), `candidate number ${i + 1}`]),
    ['none', 'none of them is close'],
  ]);

// ---------- round 4 ----------
/** The catalogue's colour and finish names (2026-11-02 snapshot), in English for the model. */
export const COLOURS: Record<string, string> = {
  white: '화이트',
  ivory: '아이보리',
  beige: '베이지',
  grey: '그레이',
  charcoal: '차콜',
  black: '블랙',
  brown: '브라운',
  blue: '블루',
  green: '그린',
};
export const FINISHES: Record<string, string> = {
  matte: '무광',
  glossy: '유광',
  polished: '폴리싱',
  embossed: '엠보',
};
export const TILE_NAMES_TEXT =
  " Also name the photo tile's main colour and its surface finish from the given lists, as the tile itself would be sold (not the light).";
export const tileSchema = (max: number) => ({
  type: 'object',
  properties: {
    choice: { type: 'integer', minimum: 0, maximum: max },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    colour: { type: 'string', enum: Object.keys(COLOURS) },
    finish: { type: 'string', enum: Object.keys(FINISHES) },
  },
  required: ['choice', 'confidence', 'colour', 'finish'],
  additionalProperties: false,
});
/** Product forms the catalogue tells apart (subcategories), plus the ones it has none of. */
export const SHAPES: Record<string, Record<string, string>> = {
  toilet: {
    'one-piece': 'one-piece toilet: tank and bowl one body',
    'two-piece': 'two-piece toilet: a separate tank on the bowl',
    'wall-hung': 'wall-hung toilet without a floor base',
    unknown: 'cannot tell',
  },
  basin: {
    'wall-hung': 'wall-hung basin, nothing below or only a half pedestal',
    pedestal: 'basin on a full pedestal or stand down to the floor',
    vessel: 'vessel bowl sitting on top of a counter',
    vanity: 'basin built into a cabinet or vanity unit',
    unknown: 'cannot tell',
  },
  bath: {
    'built-in': 'built-in bath with a front panel',
    freestanding: 'freestanding bath',
    unknown: 'cannot tell',
  },
};
export const SHAPE_TEXT = ' Also say the form of the product in the PHOTO panel from the given list.';
export const productSchema = (max: number, kind: string) => ({
  type: 'object',
  properties: {
    choice: { type: 'integer', minimum: 0, maximum: max },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    form: { type: 'string', enum: Object.keys(SHAPES[kind] ?? { unknown: '' }) },
  },
  required: ['choice', 'confidence', 'form'],
  additionalProperties: false,
});
/** Several board images in one Gemma request (the 12 candidates as boards of 4). */
export const gemmaImages = (text: string, images: string[], schema: object) => ({
  ...gemmaInput(text, images[0], schema),
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))],
    },
  ],
});
export const SPLIT_TILE_TEXT =
  'Each image shows, on the left (PHOTO), a tiled wall or floor cut out of a bathroom photo and straightened, and on the right four numbered catalogue tiles drawn repeated with their joints over the same 900 mm square. Across all images the numbers run 1 to 12. Which number is the same tile as in the photo, judging colour, pattern, veining and finish (the photo may be darker or tinted by its light)? Answer 0 if none of them is close.';
/** Finding products (Gemma), boxes as Gemma gives them: [ymin, xmin, ymax, xmax] in 0–1000. */
export const INVENTORY_KINDS = [
  'toilet',
  'basin',
  'vanity',
  'bath',
  'shower',
  'mirror',
  'glassPartition',
  'window',
  'door',
];
export const INVENTORY_TEXT =
  'List every bathroom fixture you can see in this photo: toilets, basins (sinks), vanity units, baths, showers, mirrors, glass partitions, windows and doors. Give each one its kind and its box as bbox_2d=[ymin,xmin,ymax,xmax], integers 0..1000 in the full image. Do not list reflections seen in a mirror or glass as separate fixtures.';
export const inventorySchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: INVENTORY_KINDS },
          bbox_2d: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: { type: 'integer', minimum: 0, maximum: 1000 },
          },
        },
        required: ['kind', 'bbox_2d'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};
/** "No match" by colour: the product body's colour on its cut-out (the catalogue's are white, black or beige). */
export const PRODUCT_COLOURS = [
  'white',
  'ivory',
  'grey',
  'black',
  'beige',
  'brown',
  'blue',
  'green',
  'yellow',
  'pink',
  'other',
];
export const PRODUCT_COLOUR_TEXT =
  'This is a bathroom product cut out of a photo onto white. What is the main colour of the product body itself (ignore shadows, the light and any taps or fittings)?';
export const productColourSchema = {
  type: 'object',
  properties: { colour: { type: 'string', enum: PRODUCT_COLOURS } },
  required: ['colour'],
  additionalProperties: false,
};
/** Round 9 (③ 조각 점검): what each face's piece shows and in what state, one call a photo. */
export const INSPECT_TEXT =
  'Image 1 is a bathroom photo with numbered red outlines on its walls and floor. Image 2 shows, under the same numbers, each outlined part cut out and straightened: the piece that will be used to recognise the tile of that wall or floor. For each numbered piece say: content — what mainly fills the piece (tile, door, shower_curtain, glass_partition, mirror, window, cabinet_or_shelf, painted_wall, other); tile_visible — how much of the piece is tile surface (all, most, half, little, none); state — the condition of the tile (clean, slightly_dirty, very_dirty, wet_or_reflective, unknown); marks — what the marks or variation on the tile are (none, tile_design for a printed pattern, veining or texture, dirt_or_stain, mould, water_or_reflection, mixed); confidence — high, medium or low.';
export const inspectSchema = (count: number) => ({
  type: 'object',
  properties: {
    pieces: {
      type: 'array',
      minItems: count,
      maxItems: count,
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer', minimum: 1, maximum: count },
          content: { type: 'string', enum: [...CONTENTS] },
          tile_visible: { type: 'string', enum: [...VISIBLE] },
          state: { type: 'string', enum: [...STATES] },
          marks: { type: 'string', enum: [...MARKS] },
          confidence: { type: 'string', enum: [...CONFIDENCE] },
        },
        required: ['number', 'content', 'tile_visible', 'state', 'marks', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['pieces'],
  additionalProperties: false,
});
