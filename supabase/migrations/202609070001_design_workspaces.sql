-- v3 stores ten editable designs and five comparison selections per project.
-- Documents and blobs stay private under the existing RLS and Storage policies.
-- This migration updates reference indexing without rewriting user documents.
create or replace function public.document_asset_ids(doc jsonb) returns setof uuid
language sql immutable set search_path = '' as $$
  select distinct (value #>> '{}')::uuid from (
    select jsonb_path_query(doc,'$.**.originalAssetId') as value union all
    select jsonb_path_query(doc,'$.**.previewAssetId') union all
    select jsonb_path_query(doc,'$.**.backgroundAssetId') union all
    select jsonb_path_query(doc,'$.**.referenceOriginalAssetId') union all
    select jsonb_path_query(doc,'$.**.referencePreviewAssetId') union all
    select jsonb_path_query(doc,'$.**.appearanceAssetId') union all
    select jsonb_path_query(doc,'$.**.thumbnailAssetId')
  ) refs where value <> 'null'::jsonb
$$;

-- A second boundary enforces the product limits even for privileged server writes.
-- Full geometry, quotation and schema validation remains in the authenticated route.
create function public.valid_design_workspace(workspace jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare design jsonb; item jsonb; design_ids text[] := array[]::text[]; selected_ids text[] := array[]::text[]; selected text;
begin
  if jsonb_typeof(workspace) is distinct from 'object'
    or jsonb_typeof(workspace -> 'designs') is distinct from 'array'
    or jsonb_typeof(workspace -> 'comparisonDesignIds') is distinct from 'array'
    or jsonb_typeof(workspace -> 'shared') is distinct from 'object'
    or not (workspace ? 'activeDesignId') then return false; end if;
  if jsonb_array_length(workspace -> 'designs') > 10
    or jsonb_array_length(workspace -> 'comparisonDesignIds') > 5 then return false; end if;
  for design in select jsonb_array_elements(workspace -> 'designs') loop
    if jsonb_typeof(design -> 'id') is distinct from 'string'
      or design ->> 'id' = any(design_ids)
      or jsonb_typeof(design #> '{history,past}') is distinct from 'array'
      or jsonb_typeof(design #> '{history,future}') is distinct from 'array' then return false; end if;
    if jsonb_array_length(design #> '{history,past}') > 50
      or jsonb_array_length(design #> '{history,future}') > 50 then return false; end if;
    design_ids := array_append(design_ids, design ->> 'id');
  end loop;
  if cardinality(design_ids) = 0 then
    if workspace -> 'activeDesignId' is distinct from 'null'::jsonb then return false; end if;
  elsif jsonb_typeof(workspace -> 'activeDesignId') is distinct from 'string'
    or not (workspace ->> 'activeDesignId' = any(design_ids)) then return false; end if;
  for item in select jsonb_array_elements(workspace -> 'comparisonDesignIds') loop
    selected := item #>> '{}';
    if jsonb_typeof(item) <> 'string' or not (selected = any(design_ids))
      or selected = any(selected_ids) then return false; end if;
    selected_ids := array_append(selected_ids, selected);
  end loop;
  return true;
end $$;

create function public.valid_project_designs(doc jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare backup jsonb;
begin
  if doc ->> 'schemaVersion' in ('1', '2') then return true; end if;
  if doc ->> 'schemaVersion' is distinct from '3'
    or not public.valid_design_workspace(doc)
    or jsonb_typeof(doc -> 'roomHistory') is distinct from 'object' then return false; end if;
  if (doc -> 'roomHistory') ? 'past' and (doc -> 'roomHistory') ? 'future' then return false; end if;
  if (doc -> 'roomHistory') - 'past' - 'future' <> '{}'::jsonb then return false; end if;
  for backup in select value from jsonb_each(doc -> 'roomHistory') loop
    if backup ? 'roomHistory' or not public.valid_design_workspace(backup) then return false; end if;
  end loop;
  return true;
end $$;

alter table public.projects add constraint projects_design_workspace_valid
  check (public.valid_project_designs(document));
revoke all on function public.valid_design_workspace(jsonb), public.valid_project_designs(jsonb) from public, anon, authenticated;
grant execute on function public.valid_design_workspace(jsonb), public.valid_project_designs(jsonb) to service_role;

-- Recursive paths cover baseline, shared Before, every design/history, legacy frames,
-- and the single non-recursive room checkpoint, including quotation material versions.
insert into public.asset_references(asset_id, project_id)
select public.document_asset_ids(p.document), p.id from public.projects p
on conflict do nothing;
insert into public.project_material_versions(project_id, version_id)
select p.id, public.document_version_ids(p.document) from public.projects p
on conflict do nothing;
