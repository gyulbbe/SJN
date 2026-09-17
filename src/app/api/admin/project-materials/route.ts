import { adminRoute } from '@/lib/admin/server';
import { adminProjectMaterials } from '@/lib/admin/projects';
export const dynamic = 'force-dynamic';
const handle = (request: Request) => adminRoute(request, adminProjectMaterials);
export { handle as GET, handle as POST };
