import { requireD1Environment, serverError } from '@/lib/storage/server';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const env = requireD1Environment();
    const auth = await import('@/lib/auth/d1');
    const session = await auth.getD1Session(
      request,
      env as unknown as Parameters<typeof auth.getD1Session>[1],
    );
    return Response.json(
      { user: session?.user ?? null },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return serverError(error);
  }
}
