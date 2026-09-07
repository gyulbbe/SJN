-- Comparison v2 keeps the source photograph separate from the generated room image.
-- Existing recursive scene/version scanning already includes Before and history scenes.
create or replace function public.document_asset_ids(doc jsonb) returns setof uuid
language sql immutable set search_path = '' as $$
  select distinct (value #>> '{}')::uuid from (
    select jsonb_path_query(doc,'$.**.originalAssetId') as value union all
    select jsonb_path_query(doc,'$.**.previewAssetId') union all
    select jsonb_path_query(doc,'$.**.backgroundAssetId') union all
    select jsonb_path_query(doc,'$.**.referenceOriginalAssetId') union all
    select jsonb_path_query(doc,'$.**.referencePreviewAssetId') union all
    select jsonb_path_query(doc,'$.**.appearanceAssetId') union all
    select jsonb_path_query(doc,'$.thumbnailAssetId')
  ) refs where value <> 'null'::jsonb
$$;

-- Recompute only reference rows; ownership, conditional revisions and document contents stay intact.
insert into public.asset_references(asset_id, project_id)
select public.document_asset_ids(p.document), p.id from public.projects p
on conflict do nothing;
