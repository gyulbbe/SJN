import AdminGuard from '@/components/materials/admin-guard';
import AdminAiUsage from '@/components/admin/admin-ai-usage';
export default function Page() {
  return (
    <AdminGuard>
      <AdminAiUsage />
    </AdminGuard>
  );
}
