/** Bounds of an inspector slider; typed numbers follow the same range and step as dragging. */
export type RangeBounds = { min: number; max: number; step: number };

const decimals = (value: number) => {
  const text = String(value);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  return text.includes('.') ? text.split('.')[1].length : 0;
};

/** Clamps to the range and snaps to the slider step, trimming float noise to the step precision. */
export function snapRangeValue(value: number, { min, max, step }: RangeBounds): number {
  const snapped = step > 0 ? min + Math.round((value - min) / step) * step : value;
  const clamped = Math.max(min, Math.min(max, snapped));
  return Number(clamped.toFixed(Math.max(decimals(step), decimals(min))));
}

/** A typed value, or null when it is empty or not a number (the field then reverts). */
export function parseRangeInput(text: string, bounds: RangeBounds): number | null {
  const normalized = text.trim().replace(',', '.');
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? snapRangeValue(value, bounds) : null;
}

/** Arrow-key nudge: one step, or `multiplier` steps with Shift. */
export function stepRangeValue(value: number, direction: 1 | -1, bounds: RangeBounds, multiplier = 1) {
  return snapRangeValue(value + direction * bounds.step * multiplier, bounds);
}
