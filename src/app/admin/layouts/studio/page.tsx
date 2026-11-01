import AdminGuard from '@/components/materials/admin-guard';
import LayoutStudio from '@/components/admin/layout-studio';
export default function Page() {
  return (
    <AdminGuard>
      <LayoutStudio />
    </AdminGuard>
  );
}
