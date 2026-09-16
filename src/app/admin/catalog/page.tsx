import AdminGuard from '@/components/materials/admin-guard';
import CatalogAdmin from '@/components/materials/catalog-admin';
export default function Page() {
  return (
    <AdminGuard>
      <CatalogAdmin />
    </AdminGuard>
  );
}
