-- Per-design commercial snapshots are document data, never rendered-image uploads.
-- Include price provenance independently from the visual version and retain it across
-- undo frames and the common room restore checkpoint. No user documents are rewritten.
create or replace function public.document_version_ids(doc jsonb) returns setof uuid
language sql immutable set search_path = '' as $$
  select distinct (value #>> '{}')::uuid from (
    select jsonb_path_query(doc, '$.**.materialVersionId') as value union all
    select jsonb_path_query(doc, '$.**.sourceVersionId')
  ) refs where value <> 'null'::jsonb
$$;

insert into public.project_material_versions(project_id, version_id)
select p.id, public.document_version_ids(p.document) from public.projects p
on conflict do nothing;

-- The authenticated API validates optional materialUsage and renderRevision in every
-- design/history/checkpoint with materialUsageSchema before the existing CAS RPC.
-- Existing private asset policies, owner/admin checks and five-design triggers remain.
