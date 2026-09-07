export type QuoteUnit = 'm2' | 'box' | 'piece' | 'set';

/** Optional on legacy material versions. null means not registered, never a free price. */
export type MaterialPricing = {
  unit: QuoteUnit;
  unitPrice: number | null;
  boxCoverageM2: number | null;
  piecesPerBox: number | null;
  wastePercent: number;
};

export type QuoteLine = {
  id: string;
  sourceKey?: string;
  materialVersionId?: string;
  category: 'tile' | 'fixture' | 'custom';
  name: string;
  specification: string;
  unit: QuoteUnit;
  unitPrice: number | null;
  quantity: number | null;
  quantityMode: 'auto' | 'manual';
  quantityConfirmed: boolean;
  areaM2: number | null;
  /** Absent on older quotations, which retain their manually entered areas. */
  areaSource?: 'room' | 'manual';
  sourceSurfaceIds?: string[];
  wastePercent: number;
  boxCoverageM2: number | null;
  piecesPerBox: number | null;
  tileAreaM2: number | null;
  included: boolean;
  note: string;
};

/** Self-contained commercial snapshot: source IDs are provenance, not asset references. */
export type QuoteDocument = {
  id: string;
  number: string;
  createdAt: string;
  updatedAt: string;
  sourceSignature: string;
  supplierName: string;
  supplierPhone: string;
  customerName: string;
  siteName: string;
  issueDate: string;
  validUntil: string;
  notes: string;
  discount: number;
  taxRate: number;
  lines: QuoteLine[];
};
