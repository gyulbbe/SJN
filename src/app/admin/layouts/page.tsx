import AdminGuard from '@/components/materials/admin-guard';
import FixtureLayoutsAdmin from '@/components/admin/fixture-layouts-admin';
export default function Page() {
  return (
    <AdminGuard>
      <FixtureLayoutsAdmin />
    </AdminGuard>
  );
}
