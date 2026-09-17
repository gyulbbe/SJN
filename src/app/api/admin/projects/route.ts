import { adminRoute } from '@/lib/admin/server';
import { adminProjects } from '@/lib/admin/projects';
export const dynamic = 'force-dynamic';
const handle = (request: Request) => adminRoute(request, adminProjects);
export { handle as GET, handle as POST };
