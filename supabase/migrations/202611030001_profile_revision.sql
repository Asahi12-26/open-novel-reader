-- Upgrade existing deployments without replacing their data. Book envelopes keep their existing RPC.
alter table public.reader_profiles add column if not exists revision bigint not null default 1 check (revision > 0);

create or replace function public.save_reader_profile(p_payload jsonb, p_expected_revision bigint)
returns bigint language plpgsql security invoker set search_path = public, pg_temp as $$
declare saved_revision bigint;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'INVALID_PROFILE'; end if;
  if p_expected_revision = 0 then
    insert into public.reader_profiles(user_id, payload, revision)
    values (auth.uid(), p_payload, 1)
    on conflict (user_id) do nothing returning revision into saved_revision;
  else
    update public.reader_profiles set payload = p_payload, revision = revision + 1, updated_at = now()
    where user_id = auth.uid() and revision = p_expected_revision
    returning revision into saved_revision;
  end if;
  if saved_revision is null then raise exception 'SYNC_CONFLICT'; end if;
  return saved_revision;
end $$;
revoke all on function public.save_reader_profile(jsonb, bigint) from public, anon;
grant execute on function public.save_reader_profile(jsonb, bigint) to authenticated;
