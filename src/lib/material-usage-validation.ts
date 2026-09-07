import { z } from 'zod';

const id = z.string().uuid();
const quantity = z.number().finite().min(0).max(100_000);
export const usagePriceSnapshotSchema = z
  .object({
    sourceVersionId: id,
    unit: z.enum(['m2', 'box', 'piece']),
    unitPrice: z.number().finite().int().min(0).max(100_000_000).nullable(),
    boxCoverageM2: z.number().finite().positive().max(100_000).nullable(),
    piecesPerBox: z.number().finite().int().positive().max(100_000).nullable(),
    requiresUnitReview: z.boolean().optional(),
  })
  .strict();
export const materialUsageSchema = z
  .object({
    version: z.literal(1),
    assignments: z
      .record(
        id,
        z
          .object({
            category: z.enum(['tile', 'fixture']),
            materialVersionId: id,
            pricing: usagePriceSnapshotSchema,
          })
          .strict()
          .refine(
            (assignment) => assignment.category !== 'fixture' || assignment.pricing.unit === 'piece',
            '제품은 개당 단가를 확인해 주세요.',
          ),
      )
      .refine((values) => Object.keys(values).length <= 300),
    areas: z
      .record(id, z.object({ mode: z.literal('manual'), areaM2: quantity.nullable() }).strict())
      .refine((values) => Object.keys(values).length <= 100),
    quantities: z
      .record(
        z.string().min(1).max(10_000),
        z
          .object({
            mode: z.literal('manual'),
            quantity: quantity.nullable(),
          })
          .strict(),
      )
      .refine((values) => Object.keys(values).length <= 600),
    aggregateAreas: z
      .array(
        z
          .object({
            materialVersionId: id,
            surfaceIds: z
              .array(id)
              .min(1)
              .max(100)
              .refine((ids) => new Set(ids).size === ids.length),
            areaM2: quantity,
          })
          .strict(),
      )
      .max(300),
    migratedQuoteId: id.optional(),
  })
  .strict();
