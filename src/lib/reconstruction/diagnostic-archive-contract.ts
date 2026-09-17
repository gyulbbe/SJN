import { z } from 'zod';
import type { ReconstructionLabReport } from './lab';
import type { DiagnosticRun } from './lab-diagnostics';

export const DIAGNOSTIC_RETENTION = { runs: 20, bytes: 25 * 1024 * 1024 } as const;
export type DiagnosticArchiveEntry = {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  status: DiagnosticRun['status'];
  input: DiagnosticRun['input'];
  engine: string;
  report?: ReconstructionLabReport;
  projectAnalysis?: Record<string, unknown>;
  failure?: Record<string, unknown>;
};
export type DiagnosticStorageStatus = { stored: true } | { stored: false; reason: string };

const schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    startedAt: z.string().datetime(),
    status: z.enum(['complete', 'failed', 'cancelled']),
    input: z
      .object({
        name: z.string().min(1).max(1000),
        bytes: z
          .number()
          .int()
          .min(0)
          .max(1024 ** 4),
        mime: z.string().max(100),
      })
      .strict(),
    engine: z.string().min(1).max(200),
    report: z.record(z.string(), z.unknown()).optional(),
    projectAnalysis: z.record(z.string(), z.unknown()).optional(),
    failure: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => !!(value.report || value.projectAnalysis || value.failure));

/** Bound JSON trees and reject inline file payloads and common authentication fields. */
export function parseDiagnosticArchive(value: unknown): DiagnosticArchiveEntry {
  const entry = schema.parse(value);
  const pending: { value: unknown; depth: number }[] = [{ value: entry, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 1_000_000 || current.depth > 40) throw new Error('진단 자료의 구조가 너무 커요.');
    const item = current.value;
    if (item === null || typeof item === 'boolean' || typeof item === 'undefined') continue;
    if (typeof item === 'string') {
      if (item.length > 65536 || /^(?:data:|blob:)/i.test(item) || /Bearer\s+[^\s["',;]+/i.test(item))
        throw new Error('진단 자료에 너무 긴 값이나 사진·인증 정보가 있어요.');
      continue;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('진단 숫자 범위가 올바르지 않아요.');
      continue;
    }
    if (Array.isArray(item)) {
      if (item.length > 100000) throw new Error('진단 배열이 너무 커요.');
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype)
      throw new Error('JSON 진단 자료만 보관할 수 있어요.');
    const fields = Object.entries(item);
    if (fields.length > 10000) throw new Error('진단 항목이 너무 많아요.');
    for (const [key, child] of fields) {
      if (
        key.length > 200 ||
        /^(?:__proto__|prototype|constructor|authorization|cookie|password|secret|api[-_]?key|access[-_]?token|refresh[-_]?token)$/i.test(
          key,
        )
      )
        throw new Error('진단 자료에 보관할 수 없는 필드가 있어요.');
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return entry as DiagnosticArchiveEntry;
}
