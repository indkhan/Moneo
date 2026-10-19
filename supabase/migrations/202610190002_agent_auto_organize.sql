-- Lets the background Categorizer apply its own proposals. It runs with the
-- service role (no auth.uid()), so this acts as the workspace owner for one
-- transaction and goes through the SAME create/apply review RPCs a person uses:
-- correction events, the batch, the saved rule and Undo are all unchanged.
create function public.auto_apply_organization_review(p_workspace uuid,p_rows jsonb,p_patch jsonb,p_merchant_name text,p_rule_key text,p_evidence jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid; review jsonb;
begin
  select owner_id into owner from public.workspaces where id=p_workspace;
  if owner is null then raise exception 'Workspace not found' using errcode='P0002'; end if;
  perform set_config('request.jwt.claim.sub',owner::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner,'role','authenticated')::text,true);
  review:=public.create_organization_review(p_rows,p_patch,p_merchant_name,p_rule_key,p_evidence,p_request_id);
  return jsonb_build_object('reviewId',review->>'id')||public.apply_organization_review((review->>'id')::uuid,p_rule_key is not null);
end;
$$;
revoke all on function public.auto_apply_organization_review(uuid,jsonb,jsonb,text,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.auto_apply_organization_review(uuid,jsonb,jsonb,text,text,jsonb,uuid) to service_role;
