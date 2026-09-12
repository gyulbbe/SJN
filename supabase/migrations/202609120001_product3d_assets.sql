begin;
-- Internal 3D meshes are private, validated binary uploads. Existing image files remain unchanged.
update storage.buckets
set allowed_mime_types = array['image/jpeg','image/png','image/webp','application/x-sjn-product-mesh'],
    file_size_limit = 26214400
where id = 'scene-assets';

create or replace function public.material_asset_ids(doc jsonb) returns setof uuid
language sql immutable set search_path = '' as $$
  select distinct (value #>> '{}')::uuid from (
    select doc -> 'coverAssetId' as value union all
    select jsonb_array_elements(coalesce(doc -> 'imageAssetIds','[]'::jsonb)) union all
    select jsonb_array_elements(coalesce(doc -> 'textureAssetIds','[]'::jsonb)) union all
    select jsonb_path_query(doc,'$.views[*].assetId') union all
    select jsonb_path_query(doc,'$.views[*].product3d.meshAssetId') union all
    select jsonb_path_query(doc,'$.views[*].product3d.inputAssetId')
  ) refs where value is not null and value <> 'null'::jsonb
$$;

-- Also protect references in any already-stored compatible version.
insert into public.asset_references(asset_id,material_version_id)
select refs.asset_id, versions.id
from public.material_versions versions
cross join lateral public.material_asset_ids(versions.payload) refs(asset_id)
on conflict do nothing;

commit;
