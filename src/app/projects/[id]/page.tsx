import Editor from '@/components/editor/editor';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Editor id={id} />;
}
