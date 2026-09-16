import { Vector3 } from 'three';
import { createTemplateModel, disposeTemplateModel } from './templates';
import { showerModelPartBounds } from './fixture-variants';
import type { CandidateFixturePlan } from './candidate-pipeline';
import type { RoomDefinition } from '../room-types';
import type { ShowerObservation } from './shower-observation';

const cache = new Map<string, { min: number[]; max: number[] }>();
/** Bounds of actual named template vertices, in product coordinates. No image-derived dimensions. */
export function showerObservedCorners(
  _room: RoomDefinition,
  plan: CandidateFixturePlan,
  part: ShowerObservation['observedPart'],
): Vector3[] | undefined {
  if (!plan.showerVariant || !['handset', 'overhead-head'].includes(part)) return undefined;
  const key = JSON.stringify([plan.showerVariant, plan.widthMm, plan.heightMm, plan.depthMm, part]);
  let bounds = cache.get(key);
  if (!bounds) {
    const model = createTemplateModel({
      ...plan,
      kind: 'shower',
      version: 2,
      color: '#888888',
      widthMm: plan.widthMm!,
      heightMm: plan.heightMm!,
      depthMm: plan.depthMm!,
    });
    try {
      const found = showerModelPartBounds(model)[part as 'handset' | 'overhead-head'];
      if (!found) return undefined;
      bounds = { min: [...found.min], max: [...found.max] };
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(key, bounds);
    } finally {
      disposeTemplateModel(model);
    }
  }
  const corners: Vector3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]])
      for (const z of [bounds.min[2], bounds.max[2]]) corners.push(new Vector3(x, y, z));
  return corners;
}
