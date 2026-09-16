export async function getSupabaseSessionUser(request: Request) {
  const { authenticated } = await import('../supabase/server');
  const { user } = await authenticated(request);
  return { id: user.id, name: user.user_metadata?.name ?? '', email: user.email };
}
