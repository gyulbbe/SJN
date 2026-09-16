import type { CloudGemmaOperation } from './cloud-gemma-contract';
import { CLOUD_GEMMA_GROUPED_INVENTORY_CONTRACT, flattenCloudGemmaGroupedInventory, requireCloudGemmaGroupedInventoryContract } from './cloud-gemma-inventory';
import { EXTENDED_INVENTORY_OUTPUT_CONTRACT, EXTENDED_INVENTORY_PROMPT_REVISION, parseFixtureInventory } from './inventory-observation';

/**
 * Gemma's native box convention is y1,x1,y2,x2 on a 0..1000 grid:
 * https://ai.google.dev/gemma/docs/capabilities/vision/image#object-detection
 * Internal ProductBounds and historical Qwen contracts remain x/y named fields.
 * This adapter is selected by provider/operation, never by photo or numeric heuristics.
 */
export const CLOUD_GEMMA_COORDINATE_CONTRACT = 'gemma-bbox-yxyx-1000-v1' as const;
const boxOperations = new Set<CloudGemmaOperation>([
  'inventory',
  'inventory-extended',
  'identity',
  'installation',
  'layout',
  'target-existence',
]);
const boxDescription =
  'Gemma bbox_2d: [ymin,xmin,ymax,xmax], integers 0..1000 in the upright full image. ymin/ymax measure vertical distance from the top; xmin/xmax measure horizontal distance from the left.';
const promptMarker = `Box coordinate contract: ${CLOUD_GEMMA_COORDINATE_CONTRACT}.`;
const nativeInstruction = `${promptMarker} ${boxDescription} Named bounds.left/top/right/bottom and named point.x/point.y retain their explicit meanings and their declared scale. Do not reorder named fields or point coordinates.`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The same permutation encodes xyxy→yxyx and decodes yxyx→xyxy. */
function transposeBox(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((item) => !Number.isInteger(item) || item < 0 || item > 1000)
  )
    throw new Error('Gemma bbox_2d must contain four integer coordinates in 0..1000.');
  return [value[1], value[0], value[3], value[2]];
}

/** Provider-only schema preparation; historical Qwen schemas remain unchanged. */
export function prepareCloudGemmaSchema<T>(schema: T): T {
  const result = structuredClone(schema);
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    // Provider compatibility: encode untyped primitive constants as explicit singleton enums.
    // Make primitive constant types explicit without changing allowed values or parser strictness.
    if ('const' in value && value.type === undefined) {
      const literal = value.const;
      if (literal === null) value.type = 'null';
      else if (typeof literal === 'boolean' || typeof literal === 'string') value.type = typeof literal;
      else if (typeof literal === 'number' && Number.isFinite(literal))
        value.type = Number.isInteger(literal) ? 'integer' : 'number';
      if (value.type !== undefined) {
        value.enum = [literal];
        delete value.const;
      }
    }
    const properties = value.properties;
    if (isRecord(properties) && isRecord(properties.bbox_2d) && properties.bbox_2d.type === 'array')
      properties.bbox_2d.description = boxDescription;
    Object.values(value).forEach(visit);
  }
  visit(result);
  return result;
}

/** Locate balanced JSON, respecting quoted strings, rather than regex-rewriting model prose. */
function jsonEnd(text: string, start: number): number | null {
  const stack: string[] = [];
  let quoted = false,
    escaped = false;
  for (let at = start; at < text.length; at++) {
    const character = text[at];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{' || character === '[') stack.push(character);
    else if (character === '}' || character === ']') {
      if (stack.pop() !== (character === '}' ? '{' : '[')) return null;
      if (!stack.length) return at + 1;
    }
  }
  return null;
}

function prepareEmbeddedJson(prompt: string): string {
  let result = '',
    previous = 0;
  for (let at = 0; at < prompt.length; at++) {
    if (prompt[at] !== '{' && prompt[at] !== '[') continue;
    const end = jsonEnd(prompt, at);
    if (end === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(prompt.slice(at, end));
    } catch {
      continue;
    }
    const canonical = JSON.stringify(parsed);
    function convertBoxes(value: unknown) {
      if (Array.isArray(value)) {
        value.forEach(convertBoxes);
        return;
      }
      if (!isRecord(value)) return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'bbox_2d' && Array.isArray(child)) value[key] = transposeBox(child);
        else convertBoxes(child);
      }
    }
    convertBoxes(parsed);
    const prepared = JSON.stringify(prepareCloudGemmaSchema(parsed));
    result += prompt.slice(previous, at) + (prepared === canonical ? prompt.slice(at, end) : prepared);
    previous = end;
    at = end - 1;
  }
  return result + prompt.slice(previous);
}

/**
 * Fixed-ID array boxes are encoded for Gemma. Named bounds already have unambiguous axes.
 * Existing Qwen prompt constants are never mutated; historical installation-v1 points stay x/y.
 * The caller must hash this prepared prompt/schema when recording actual provider input.
 */
export function prepareCloudGemmaPrompt(prompt: string, operation?: CloudGemmaOperation): string {
  if (operation === 'appearance') {
    const instruction = 'Output envelope: the root JSON object must have schemaVersion equal to the number 1 and observations containing exactly the provided IDs. After the observations array, complete the root object and stop. Do not append whitespace, markdown or commentary.';
    return prompt.includes(instruction) ? prompt : prompt + '\n' + instruction;
  }
  if (operation !== undefined && !boxOperations.has(operation)) return prompt;
  if (prompt.includes(promptMarker)) return prompt;
  const prepared = prepareEmbeddedJson(prompt)
    .replaceAll('bbox_2d=[left,top,right,bottom]', 'bbox_2d=[ymin,xmin,ymax,xmax]')
    .replaceAll('Inventory boxes are [left,top,right,bottom]', 'Inventory boxes are [ymin,xmin,ymax,xmax]')
    .replaceAll('as [left,top,right,bottom]', 'as [ymin,xmin,ymax,xmax]');
  return `${prepared}\n${nativeInstruction}`;
}

/**
 * Return separate parser input; retain the exact provider rawText for provenance.
 * Only inventory stages generate boxes. All other current stage outputs are classifications
 * and relations; points, crop transforms, named bounds and arbitrary arrays are never swapped.
 */
export function normalizeCloudGemmaOutput(rawText: string, operation: CloudGemmaOperation, providerInventoryContract?: string): string {
  if (providerInventoryContract !== undefined && (operation !== 'inventory-extended' || providerInventoryContract !== CLOUD_GEMMA_GROUPED_INVENTORY_CONTRACT))
    throw new Error('지원하지 않는 Gemma 그룹 설비 관측 계약이에요.');
  if (operation !== 'inventory' && operation !== 'inventory-extended') return rawText;
  const parsed: unknown = providerInventoryContract === CLOUD_GEMMA_GROUPED_INVENTORY_CONTRACT
    ? flattenCloudGemmaGroupedInventory(rawText)
    : JSON.parse(rawText);
  if (!isRecord(parsed) || !Array.isArray(parsed.items))
    throw new Error('Gemma inventory output must contain an items array.');
  for (const item of parsed.items) {
    if (!isRecord(item)) throw new Error('Gemma inventory items must be objects.');
    item.bbox_2d = transposeBox(item.bbox_2d);
  }
  return JSON.stringify(parsed);
}

/** All current cloud inventory boundaries use the named grouped protocol; no envelope guessing. */
export function parseCloudGemmaExtendedInventory(value: { rawText: string; outputContract?: string; promptRevision: number }) {
  const contract = requireCloudGemmaGroupedInventoryContract(value);
  if (value.outputContract !== EXTENDED_INVENTORY_OUTPUT_CONTRACT || value.promptRevision !== EXTENDED_INVENTORY_PROMPT_REVISION)
    throw new Error('그룹 설비 관측의 canonical 계약 또는 프롬프트 버전이 달라요.');
  return parseFixtureInventory(normalizeCloudGemmaOutput(value.rawText, 'inventory-extended', contract), EXTENDED_INVENTORY_OUTPUT_CONTRACT);
}
