import AdminGuard from '@/components/materials/admin-guard';
import AdminUsers from '@/components/admin/admin-users';
export default function Page() {
  return (
    <AdminGuard>
      <AdminUsers />
    </AdminGuard>
  );
}
