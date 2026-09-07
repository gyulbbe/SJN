-- New workspaces are limited to five designs. Keep the prior ten-design structural
-- ceiling so existing documents and room checkpoints can be retained without data loss.
-- Updates above five may only retain IDs from one of that row's prior workspaces.
create function public.enforce_five_design_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare workspace jsonb; prior jsonb; old_workspaces jsonb := '[]'::jsonb; allowed boolean;
begin
  if new.document ->> 'schemaVersion' <> '3' then return new; end if;
  if tg_op = 'UPDATE' and old.document ->> 'schemaVersion' = '3' then
    old_workspaces := jsonb_build_array(old.document)
      || jsonb_path_query_array(old.document, '$.roomHistory.*');
  end if;
  for workspace in select jsonb_array_elements(
    jsonb_build_array(new.document) || jsonb_path_query_array(new.document, '$.roomHistory.*')
  ) loop
    if jsonb_array_length(workspace -> 'designs') <= 5 then continue; end if;
    allowed := false;
    for prior in select jsonb_array_elements(old_workspaces) loop
      if not exists (
        select 1 from jsonb_array_elements(workspace -> 'designs') candidate
        where not exists (
          select 1 from jsonb_array_elements(prior -> 'designs') existing
          where candidate ->> 'id' = existing ->> 'id'
        )
      ) then allowed := true; exit; end if;
    end loop;
    if not allowed then
      raise exception using errcode = '23514',
        message = '프로젝트당 시안은 최대 5개까지 만들 수 있습니다. 기존 시안을 삭제한 뒤 다시 시도해 주세요.';
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.enforce_five_design_limit() from public, anon, authenticated;
grant execute on function public.enforce_five_design_limit() to service_role;
create trigger projects_five_design_limit
before insert or update of document on public.projects
for each row execute function public.enforce_five_design_limit();
