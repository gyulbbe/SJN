-- Run after migrations on a disposable Supabase database as postgres.
-- This is an executable privilege/policy smoke test, not live user-isolation coverage.
begin;
do $$
declare object regclass;
begin
  foreach object in array array['public.projects'::regclass,'public.materials'::regclass,'public.material_versions'::regclass,'public.assets'::regclass,'public.asset_references'::regclass,'public.project_material_versions'::regclass,'public.cleanup_jobs'::regclass,'public.admin_roles'::regclass] loop
    assert (select relrowsecurity from pg_class where oid = object), 'RLS must be enabled';
    assert not has_table_privilege('authenticated',object,'INSERT,UPDATE,DELETE'), 'client writes must be denied';
    assert not has_table_privilege('anon',object,'SELECT,INSERT,UPDATE,DELETE'), 'anonymous access must be denied';
  end loop;
  assert not has_function_privilege('authenticated','public.save_project(uuid,jsonb,bigint)','EXECUTE'), 'actor spoofing RPC must be denied';
  assert not has_function_privilege('authenticated','public.register_asset(uuid,jsonb,text,uuid)','EXECUTE'), 'unverified image registration must be denied';
  assert not has_function_privilege('authenticated','public.save_material(uuid,uuid,jsonb,uuid)','EXECUTE'), 'catalog RPC must be service only';
  assert has_function_privilege('service_role','public.save_project(uuid,jsonb,bigint)','EXECUTE');
  assert (select not public from storage.buckets where id = 'scene-assets'), 'private bucket required';
  assert not exists(select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'scene_assets%' and cmd <> 'SELECT'), 'no direct upload policy';
end $$;
rollback;
