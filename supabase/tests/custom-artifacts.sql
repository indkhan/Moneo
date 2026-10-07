do $$
declare actor uuid:=gen_random_uuid(); artifact public.artifacts%rowtype; candidate public.artifact_versions%rowtype; active uuid; initial uuid; kind text; fixture_manifest jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  foreach kind in array array['custom_planner','custom_tracker','custom_report','custom_comparison'] loop
    artifact:=public.create_trusted_artifact(kind,'Synthetic custom tool');
    initial:=artifact.active_version_id;
    if artifact.kind<>kind or jsonb_array_length(artifact.permissions)<>5 then raise exception 'Custom template permissions incorrect'; end if;
    fixture_manifest:=jsonb_build_object('kind',kind,'runtime','quickjs-calculator-v1','sdk',jsonb_build_array('spending'),'params','{}'::jsonb,'renderer','trusted');
    execute 'set local role service_role';
    candidate:=public.save_validated_generated_artifact_version(artifact.id,actor,'input => ({summary:"Exact reviewed tool",rows:[]})',fixture_manifest,'validated',null,artifact.active_version_id);
    active:=candidate.id;
    candidate:=public.save_validated_generated_artifact_version(artifact.id,actor,'input => ({summary:"Synthetic"})',fixture_manifest,'failed','Synthetic validation failure',active);
    execute 'set local role authenticated';
    if not exists(select 1 from public.artifacts where id=artifact.id and active_version_id=active) then raise exception 'Failed candidate replaced active calculator'; end if;
    artifact:=public.rename_trusted_artifact(artifact.id,'Renamed reviewed calculator',active);
    if not exists(select 1 from public.artifact_versions where id=artifact.active_version_id and source='input => ({summary:"Exact reviewed tool",rows:[]})' and manifest=fixture_manifest) then raise exception 'Rename discarded reviewed calculator'; end if;
    candidate:=public.restore_trusted_artifact_version(artifact.id,initial,artifact.active_version_id);
    if candidate.id=initial or candidate.manifest->>'runtime'<>'trusted' or candidate.version<>5 then raise exception 'Trusted initial restore must create a new immutable version'; end if;
    artifact.active_version_id:=candidate.id;
    execute 'set local role service_role';
    begin
      perform public.save_validated_generated_artifact_version(artifact.id,actor,'input => ({summary:"Synthetic"})',jsonb_set(fixture_manifest,'{sdk}','["network"]'),'validated',null,artifact.active_version_id);
      raise exception 'Unknown host SDK allowed' using errcode='ZX001';
    exception when insufficient_privilege then null; end;
    execute 'reset role';
    update public.artifacts set permissions='[]' where id=artifact.id;
    execute 'set local role service_role';
    begin
      perform public.save_validated_generated_artifact_version(artifact.id,actor,'input => ({summary:"Synthetic"})',fixture_manifest,'validated',null,artifact.active_version_id);
      raise exception 'Revoked artifact permission allowed' using errcode='ZX001';
    exception when insufficient_privilege then null; end;
    execute 'set local role authenticated';
  end loop;
  execute 'reset role';
end;
$$;

