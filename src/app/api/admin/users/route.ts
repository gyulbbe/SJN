import { adminRoute } from '@/lib/admin/server';
import { handleAdminUsers } from '@/lib/admin/users';
export const dynamic = 'force-dynamic';
const handle = (request: Request) => adminRoute(request, (ctx, input) => handleAdminUsers(input, ctx.env, ctx.actor));
export { handle as GET, handle as POST };
