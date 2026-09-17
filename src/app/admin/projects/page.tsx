import AdminGuard from '@/components/materials/admin-guard';
import AdminProjects from '@/components/admin/admin-projects';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ ownerId?: string | string[] }>;
}) {
  const params = await searchParams;
  return (
    <AdminGuard>
      <AdminProjects initialOwnerId={typeof params.ownerId === 'string' ? params.ownerId : ''} />
    </AdminGuard>
  );
}
