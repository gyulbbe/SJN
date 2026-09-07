-- Apply in a Supabase project. No credentials or seed users are included.
-- All writes go through validated Next.js routes using service_role only.
begin;
create table public.admin_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.projects (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  storage_revision bigint not null check (storage_revision > 0),
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_owner_date on public.projects(owner_id, updated_at desc);
create table public.materials (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  current_version_id uuid not null,
  active boolean not null default true,
  scope text not null check (scope in ('personal','shared')),
  updated_at timestamptz not null default now()
);
create index materials_owner on public.materials(owner_id);
create table public.material_versions (
  id uuid primary key,
  material_id uuid not null references public.materials(id) on delete cascade,
  version integer not null check (version > 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique(material_id, version)
);
alter table public.materials add constraint material_current_version foreign key(current_version_id) references public.material_versions(id) deferrable initially deferred;
create table public.assets (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  object_path text not null unique,
  source_asset_id uuid references public.assets(id),
  metadata jsonb not null,
  deleting boolean not null default false,
  created_at timestamptz not null default now()
);
create index assets_owner on public.assets(owner_id);
create index assets_source on public.assets(source_asset_id);
create table public.asset_references (
  asset_id uuid not null references public.assets(id),
  project_id uuid references public.projects(id) on delete cascade,
  material_version_id uuid references public.material_versions(id) on delete cascade,
  check ((project_id is null) <> (material_version_id is null))
);
create unique index asset_project_reference on public.asset_references(asset_id, project_id) where project_id is not null;
create unique index asset_material_reference on public.asset_references(asset_id, material_version_id) where material_version_id is not null;
create index asset_references_project on public.asset_references(project_id);
create index asset_references_version on public.asset_references(material_version_id);
create table public.project_material_versions (
  project_id uuid not null references public.projects(id) on delete cascade,
  version_id uuid not null references public.material_versions(id),
  primary key(project_id,version_id)
);
create table public.cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  object_path text not null unique,
  asset_id uuid not null,
  reason text not null,
  attempts integer not null default 0,
  claimed_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create function public.is_catalog_admin(actor uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.admin_roles where user_id = actor)
$$;
create function public.can_read_asset(actor uuid, asset uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive visible_assets(id,source_asset_id) as (
    select a.id,a.source_asset_id from public.assets a where not a.deleting and (
      a.owner_id = actor or exists (
        select 1 from public.asset_references r
        join public.material_versions v on v.id = r.material_version_id
        join public.materials m on m.id = v.material_id
        where r.asset_id = a.id and m.scope = 'shared'
      )
    )
    union
    select a.id,a.source_asset_id from public.assets a join visible_assets v on v.source_asset_id = a.id where not a.deleting
  ) select exists(select 1 from visible_assets where id = asset)
$$;

alter table public.admin_roles enable row level security;
alter table public.projects enable row level security;
alter table public.materials enable row level security;
alter table public.material_versions enable row level security;
alter table public.assets enable row level security;
alter table public.asset_references enable row level security;
alter table public.project_material_versions enable row level security;
alter table public.cleanup_jobs enable row level security;

create policy own_admin_status on public.admin_roles for select to authenticated using (user_id = (select auth.uid()));
create policy own_projects on public.projects for select to authenticated using (owner_id = (select auth.uid()));
create policy visible_materials on public.materials for select to authenticated using (owner_id = (select auth.uid()) or scope = 'shared');
create policy visible_versions on public.material_versions for select to authenticated using (exists(select 1 from public.materials m where m.id = material_id and (m.owner_id = (select auth.uid()) or m.scope = 'shared')));
create policy visible_assets on public.assets for select to authenticated using (public.can_read_asset((select auth.uid()),id));
create policy own_project_versions on public.project_material_versions for select to authenticated using (exists(select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));
create policy visible_asset_references on public.asset_references for select to authenticated using (
  exists(select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())) or
  exists(select 1 from public.material_versions v join public.materials m on m.id = v.material_id where v.id = material_version_id and (m.owner_id = (select auth.uid()) or m.scope = 'shared'))
);
-- No client write policies on any table, no read policy for cleanup jobs.
revoke all on public.admin_roles,public.projects,public.materials,public.material_versions,public.assets,public.asset_references,public.project_material_versions,public.cleanup_jobs from anon,authenticated;
grant select on public.admin_roles,public.projects,public.materials,public.material_versions,public.assets,public.asset_references,public.project_material_versions to authenticated;
grant all on public.admin_roles,public.projects,public.materials,public.material_versions,public.assets,public.asset_references,public.project_material_versions,public.cleanup_jobs to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('scene-assets','scene-assets',false,26214400,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public = false,file_size_limit = excluded.file_size_limit,allowed_mime_types = excluded.allowed_mime_types;
create policy scene_assets_read on storage.objects for select to authenticated using (
  bucket_id = 'scene-assets' and exists(select 1 from public.assets a where a.object_path = name and public.can_read_asset((select auth.uid()),a.id))
);
-- There are deliberately no INSERT/UPDATE/DELETE policies for this bucket.
-- The secret key is used only after a route authenticates and decodes the image.

create function public.document_asset_ids(doc jsonb) returns setof uuid
language sql immutable set search_path = '' as $$
  select distinct (value #>> '{}')::uuid from (
    select jsonb_path_query(doc,'$.**.originalAssetId') as value union all
    select jsonb_path_query(doc,'$.**.previewAssetId') union all
    select jsonb_path_query(doc,'$.**.backgroundAssetId') union all
    select jsonb_path_query(doc,'$.thumbnailAssetId')
  ) refs where value <> 'null'::jsonb
$$;
create function public.document_version_ids(doc jsonb) returns setof uuid
language sql immutable set search_path = '' as $$
  select distinct (value #>> '{}')::uuid from jsonb_path_query(doc,'$.**.materialVersionId') value where value <> 'null'::jsonb
$$;
create function public.material_asset_ids(doc jsonb) returns setof uuid
language sql immutable set search_path = '' as $$
  select distinct (value #>> '{}')::uuid from (
    select doc -> 'coverAssetId' as value union all
    select jsonb_array_elements(coalesce(doc -> 'imageAssetIds','[]'::jsonb)) union all
    select jsonb_array_elements(coalesce(doc -> 'textureAssetIds','[]'::jsonb)) union all
    select jsonb_path_query(doc,'$.views[*].assetId')
  ) refs where value is not null and value <> 'null'::jsonb
$$;

create function public.register_asset(actor_id uuid, asset_data jsonb, path text, job_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare source_id uuid; new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  new_id := (asset_data ->> 'id')::uuid;
  source_id := (asset_data ->> 'sourceAssetId')::uuid;
  if path <> actor_id::text || '/' || new_id::text then raise exception 'invalid storage path' using errcode='42501'; end if;
  if source_id is not null and not public.can_read_asset(actor_id,source_id) then raise exception 'invalid source' using errcode='23503'; end if;
  if not exists(select 1 from public.cleanup_jobs j where j.id = job_id and j.owner_id = actor_id and j.object_path = path and j.claimed_at is null) then raise exception 'missing or expired upload intent' using errcode='23503'; end if;
  if not exists(select 1 from storage.objects o where o.bucket_id = 'scene-assets' and o.name = path) then raise exception 'missing uploaded object' using errcode='23503'; end if;
  insert into public.assets(id,owner_id,object_path,source_asset_id,metadata)
  values(new_id,actor_id,path,source_id,asset_data || jsonb_build_object('ownerId',actor_id));
  delete from public.cleanup_jobs where id = job_id;
end $$;

create function public.save_project(actor_id uuid, project_data jsonb, expected_revision bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare project_uuid uuid; existing public.projects; saved jsonb; asset_id uuid; version_id uuid; next_revision bigint; stamp timestamptz := clock_timestamp(); fixture jsonb; material_payload jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  project_uuid := (project_data ->> 'id')::uuid;
  select * into existing from public.projects where id = project_uuid for update;
  if found then
    if existing.owner_id <> actor_id then raise exception 'not owner' using errcode='42501'; end if;
    if expected_revision is null or expected_revision <> existing.storage_revision then raise exception 'stale revision' using errcode='40001'; end if;
    next_revision := existing.storage_revision + 1;
  else
    if expected_revision is not null then raise exception 'missing project' using errcode='P0002'; end if;
    next_revision := 1;
  end if;
  for asset_id in select public.document_asset_ids(project_data) loop
    if not public.can_read_asset(actor_id,asset_id) then raise exception 'invalid asset' using errcode='23503'; end if;
    perform 1 from public.assets a where a.id = asset_id and not a.deleting for key share;
    if not found then raise exception 'asset is deleting' using errcode='23503'; end if;
  end loop;
  for version_id in select public.document_version_ids(project_data) loop
    if not exists(select 1 from public.material_versions v join public.materials m on m.id = v.material_id where v.id = version_id and (m.owner_id = actor_id or m.scope = 'shared')) then raise exception 'invalid material version' using errcode='23503'; end if;
  end loop;
  for fixture in select jsonb_path_query(project_data,'$.**.fixtures[*]') loop
    select v.payload into material_payload from public.material_versions v where v.id = (fixture ->> 'materialVersionId')::uuid;
    if material_payload ->> 'category' = 'tile' or (fixture ->> 'viewIndex')::integer >= greatest(1,jsonb_array_length(material_payload -> 'views')) then
      raise exception 'invalid fixture view' using errcode='23514';
    end if;
  end loop;
  saved := project_data || jsonb_build_object('ownerId',actor_id,'storageRevision',next_revision,'updatedAt',stamp,'createdAt',coalesce(existing.created_at,stamp));
  if expected_revision is null then
    -- A concurrent create with the same UUID must fail, never update another owner.
    insert into public.projects(id,owner_id,name,storage_revision,document,created_at,updated_at)
    values(project_uuid,actor_id,saved ->> 'name',next_revision,saved,stamp,stamp);
  else
    update public.projects p set name = saved ->> 'name',storage_revision = next_revision,document = saved,updated_at = stamp
    where p.id = project_uuid and p.owner_id = actor_id;
  end if;
  delete from public.asset_references r where r.project_id = project_uuid;
  insert into public.asset_references(asset_id,project_id) select public.document_asset_ids(saved),project_uuid;
  delete from public.project_material_versions p where p.project_id = project_uuid;
  insert into public.project_material_versions(project_id,version_id) select project_uuid,public.document_version_ids(saved);
  return saved;
end $$;

create function public.delete_project(actor_id uuid, project_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  if exists(select 1 from public.projects p where p.id = project_id and p.owner_id <> actor_id) then raise exception 'not owner' using errcode='42501'; end if;
  delete from public.projects p where p.id = project_id and p.owner_id = actor_id;
end $$;

create function public.save_material(actor_id uuid, material_id uuid, material_data jsonb, expected_version_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing public.materials; version_uuid uuid := gen_random_uuid(); version_number integer; asset_id uuid; scope_value text; saved jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into existing from public.materials m where m.id = material_id for update;
  if found then
    if (existing.scope = 'shared' and not public.is_catalog_admin(actor_id)) or (existing.scope = 'personal' and existing.owner_id <> actor_id) then raise exception 'not owner or admin' using errcode='42501'; end if;
    if expected_version_id is null or expected_version_id <> existing.current_version_id then raise exception 'stale version' using errcode='40001'; end if;
    select v.version + 1 into version_number from public.material_versions v where v.id = existing.current_version_id;
    scope_value := existing.scope;
  else
    if expected_version_id is not null then raise exception 'missing material' using errcode='P0002'; end if;
    scope_value := material_data ->> 'scope'; version_number := 1;
    if scope_value = 'shared' and not public.is_catalog_admin(actor_id) then raise exception 'admin required' using errcode='42501'; end if;
  end if;
  for asset_id in select public.material_asset_ids(material_data) loop
    if not public.can_read_asset(actor_id,asset_id) then raise exception 'invalid asset' using errcode='23503'; end if;
    perform 1 from public.assets a where a.id = asset_id and not a.deleting for key share;
    if not found then raise exception 'asset is deleting' using errcode='23503'; end if;
  end loop;
  saved := material_data || jsonb_build_object('id',version_uuid,'materialId',material_id,'version',version_number,'scope',scope_value,'createdAt',clock_timestamp());
  if expected_version_id is null then
    insert into public.materials(id,owner_id,current_version_id,scope) values(material_id,actor_id,version_uuid,scope_value);
  else
    update public.materials m set current_version_id = version_uuid,updated_at = clock_timestamp() where m.id = material_id;
  end if;
  insert into public.material_versions(id,material_id,version,payload) values(version_uuid,material_id,version_number,saved);
  insert into public.asset_references(asset_id,material_version_id) select public.material_asset_ids(saved),version_uuid;
  return saved;
end $$;

create function public.set_material_active(actor_id uuid, material_id uuid, is_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare existing public.materials;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into existing from public.materials m where m.id = material_id for update;
  if not found then raise exception 'missing material' using errcode='P0002'; end if;
  if (existing.scope = 'shared' and not public.is_catalog_admin(actor_id)) or (existing.scope = 'personal' and existing.owner_id <> actor_id) then raise exception 'not owner or admin' using errcode='42501'; end if;
  update public.materials m set active = is_active,updated_at = clock_timestamp() where m.id = material_id;
end $$;

create function public.prepare_asset_cleanup(actor_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare candidate public.assets;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  -- Child sources are retained until their children are removed. Subsequent runs
  -- collect newly unreachable ancestors; references include all 50 history scenes.
  for candidate in select a.* from public.assets a
    where a.owner_id = actor_id and a.created_at < now() - interval '24 hours' and not a.deleting
    and not exists(select 1 from public.asset_references r where r.asset_id = a.id)
    and not exists(select 1 from public.assets child where child.source_asset_id = a.id)
    for update
  loop
    update public.assets set deleting = true where id = candidate.id;
    insert into public.cleanup_jobs(owner_id,object_path,asset_id,reason,created_at)
    values(actor_id,candidate.object_path,candidate.id,'unreferenced-asset',candidate.created_at)
    on conflict(object_path) do nothing;
  end loop;
end $$;

create function public.finish_asset_cleanup(actor_id uuid, job_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare job public.cleanup_jobs;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into job from public.cleanup_jobs j where j.id = job_id and j.owner_id = actor_id for update;
  if not found then return; end if;
  delete from public.assets a where a.id = job.asset_id and a.owner_id = actor_id and a.deleting;
  delete from public.cleanup_jobs where id = job.id;
end $$;

create function public.claim_asset_cleanup(actor_id uuid) returns setof public.cleanup_jobs
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  return query update public.cleanup_jobs j set claimed_at = clock_timestamp()
    where j.id in (select q.id from public.cleanup_jobs q where q.owner_id = actor_id
      and q.created_at < now() - interval '24 hours' and q.next_attempt_at <= now()
      and (q.claimed_at is null or q.claimed_at < now() - interval '10 minutes')
      order by q.created_at limit 100 for update skip locked)
    returning j.*;
end $$;

-- Prevent bypassing route validation or spoofing actor_id via Data API RPC calls.
revoke all on function public.register_asset(uuid,jsonb,text,uuid),public.save_project(uuid,jsonb,bigint),public.delete_project(uuid,uuid),public.save_material(uuid,uuid,jsonb,uuid),public.set_material_active(uuid,uuid,boolean),public.prepare_asset_cleanup(uuid),public.finish_asset_cleanup(uuid,uuid),public.claim_asset_cleanup(uuid) from public,anon,authenticated;
grant execute on function public.register_asset(uuid,jsonb,text,uuid),public.save_project(uuid,jsonb,bigint),public.delete_project(uuid,uuid),public.save_material(uuid,uuid,jsonb,uuid),public.set_material_active(uuid,uuid,boolean),public.prepare_asset_cleanup(uuid),public.finish_asset_cleanup(uuid,uuid),public.claim_asset_cleanup(uuid) to service_role;
revoke all on function public.is_catalog_admin(uuid),public.can_read_asset(uuid,uuid),public.document_asset_ids(jsonb),public.document_version_ids(jsonb),public.material_asset_ids(jsonb) from public,anon;
grant execute on function public.is_catalog_admin(uuid),public.can_read_asset(uuid,uuid) to authenticated,service_role;
grant execute on function public.document_asset_ids(jsonb),public.document_version_ids(jsonb),public.material_asset_ids(jsonb) to service_role;
commit;
