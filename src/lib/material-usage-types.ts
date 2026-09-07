import type { MaterialVersion } from './types';

export type UsageUnit = 'm2' | 'box' | 'piece';
export type UsagePriceSnapshot = {
  /** Price provenance can advance while the visual material version stays unchanged. */
  sourceVersionId: string;
  unit: UsageUnit;
  unitPrice: number | null;
  boxCoverageM2: number | null;
  piecesPerBox: number | null;
  requiresUnitReview?: boolean;
};
export type UsageAssignment = {
  category: 'tile' | 'fixture';
  materialVersionId: string;
  pricing: UsagePriceSnapshot;
};
export type MaterialUsageState = {
  version: 1;
  assignments: Record<string, UsageAssignment>;
  areas: Record<string, { mode: 'manual'; areaM2: number | null }>;
  quantities: Record<string, { mode: 'manual'; quantity: number | null }>;
  /** Legacy total areas are never arbitrarily apportioned across their surfaces. */
  aggregateAreas: { materialVersionId: string; surfaceIds: string[]; areaM2: number }[];
  migratedQuoteId?: string;
};
export type UsageArea = {
  surfaceId: string;
  name: string;
  areaM2: number | null;
  roomAreaM2: number | null;
  source: 'room' | 'manual' | 'unknown' | 'legacy-total';
  issue?: string;
};
export type MaterialUsageRow = {
  key: string;
  category: 'tile' | 'fixture';
  materialVersionId: string;
  material?: MaterialVersion;
  entityIds: string[];
  surfaceIds: string[];
  fixtureIds: string[];
  locations: string[];
  pricing: UsagePriceSnapshot;
  areas: UsageArea[];
  areaM2: number | null;
  count: number;
  automaticQuantity: number | null;
  quantity: number | null;
  quantityMode: 'auto' | 'manual';
  amount: number | null;
  issues: string[];
  needsAttention: boolean;
};
export type MaterialUsageResult = {
  rows: MaterialUsageRow[];
  total: number;
  unresolvedCount: number;
  attentionCount: number;
  complete: boolean;
  state: MaterialUsageState;
};
export type LatestUsagePricing = {
  compatible: boolean;
  reason?: string;
  changed: boolean;
  unitChanged: boolean;
  previous: UsagePriceSnapshot;
  next: UsagePriceSnapshot;
};
