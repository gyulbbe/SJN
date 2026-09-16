import AdminGuard from '@/components/materials/admin-guard';
import MaterialManager from '@/components/materials/material-manager';
export default function Page() {
  return (
    <AdminGuard>
      <MaterialManager />
    </AdminGuard>
  );
}
