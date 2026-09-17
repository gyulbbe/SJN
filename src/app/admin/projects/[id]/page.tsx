import AdminGuard from '@/components/materials/admin-guard';
import AdminProjectEditor from '@/components/admin/admin-project-editor';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminGuard>
      <AdminProjectEditor id={id} />
    </AdminGuard>
  );
}
