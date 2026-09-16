import { requireD1Environment, serverError } from '@/lib/storage/server';
export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  try {
    const env = requireD1Environment();
    const { handleD1Auth } = await import('@/lib/auth/d1');
    return await handleD1Auth(request, env as unknown as Parameters<typeof handleD1Auth>[1]);
  } catch (error) { return serverError(error); }
}
export { handle as GET, handle as POST };
