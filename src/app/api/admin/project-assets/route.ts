import { adminRoute } from '@/lib/admin/server';
import { adminProjectAssets } from '@/lib/admin/projects';
export const dynamic = 'force-dynamic';
const handle = (request: Request) => adminRoute(request, adminProjectAssets);
export { handle as GET, handle as POST };
