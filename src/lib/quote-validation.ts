import { z } from 'zod';

const unit = z.enum(['m2', 'box', 'piece', 'set']);
const quantity = z.number().finite().min(0).max(100000);
const coverage = z.number().finite().positive().max(100000).nullable();
const price = z.number().finite().int().min(0).max(100000000).nullable();
const percent = z.number().finite().min(0).max(100);
export const materialPricingSchema = z.object({
  unit,
  unitPrice: price,
  boxCoverageM2: coverage,
  piecesPerBox: z.number().int().positive().max(100000).nullable(),
  wastePercent: percent,
});
const quoteLineSchema = z.object({
  id: z.string().uuid(),
  sourceKey: z.string().max(200).optional(),
  materialVersionId: z.string().uuid().optional(),
  category: z.enum(['tile', 'fixture', 'custom']),
  name: z.string().max(200),
  specification: z.string().max(300),
  unit,
  unitPrice: price,
  quantity: quantity.nullable(),
  quantityMode: z.enum(['auto', 'manual']),
  quantityConfirmed: z.boolean(),
  areaM2: quantity.nullable(),
  areaSource: z.enum(['room', 'manual']).optional(),
  sourceSurfaceIds: z.array(z.string().uuid()).max(100).optional(),
  wastePercent: percent,
  boxCoverageM2: coverage,
  piecesPerBox: z.number().int().positive().max(100000).nullable(),
  tileAreaM2: coverage,
  included: z.boolean(),
  note: z.string().max(2000),
});
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const quoteDocumentSchema = z.object({
  id: z.string().uuid(),
  number: z.string().min(1).max(100),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  sourceSignature: z.string().max(100000),
  supplierName: z.string().max(200),
  supplierPhone: z.string().max(100),
  customerName: z.string().max(200),
  siteName: z.string().max(200),
  issueDate: day,
  validUntil: z.union([day, z.literal('')]),
  notes: z.string().max(5000),
  discount: z.number().finite().int().min(0).max(1e12),
  taxRate: percent,
  lines: z.array(quoteLineSchema).max(300),
});
