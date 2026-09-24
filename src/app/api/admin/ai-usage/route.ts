import { adminRoute } from '@/lib/admin/server';
import { readAiUsage } from '@/lib/admin/ai-usage';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) =>
  adminRoute(request, async (ctx) =>
    Response.json(await readAiUsage(ctx.env as unknown as Record<string, unknown>)),
  );
