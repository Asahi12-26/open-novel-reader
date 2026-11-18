-- The hook only takes effect once the project owner enables it in Auth.
create schema reader_private;
revoke all on schema reader_private from public, anon, authenticated;
grant usage on schema reader_private to service_role, supabase_auth_admin;

create table reader_private.signup_allowlist (
  email text primary key check (email = lower(btrim(email)) and length(email) between 3 and 254 and position('@' in email) > 1)
);
alter table reader_private.signup_allowlist enable row level security;
grant select on reader_private.signup_allowlist to supabase_auth_admin;
create policy "Auth reads approved beta addresses" on reader_private.signup_allowlist
  for select to supabase_auth_admin using (true);

create function public.allow_reader_beta_signup(event jsonb)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select case
    when event #>> '{user,app_metadata,provider}' = 'email' and exists (
      select 1 from reader_private.signup_allowlist
      where email = lower(btrim(event #>> '{user,email}'))
    ) then '{}'::jsonb
    else '{"error":{"message":"ONR_SIGNUP_NOT_APPROVED","http_code":403}}'::jsonb
  end;
$$;
revoke all on function public.allow_reader_beta_signup(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.allow_reader_beta_signup(jsonb) to supabase_auth_admin;

-- Anonymous Supabase accounts carry the authenticated role. Keep guest
-- reading offline-only even if a project owner later changes Auth settings.
create policy "no anonymous accounts in reader records" on public.reader_records
  as restrictive for all to authenticated
  using ((select coalesce(auth.jwt()->>'is_anonymous', 'false')) = 'false')
  with check ((select coalesce(auth.jwt()->>'is_anonymous', 'false')) = 'false');
create policy "no anonymous accounts in reader profiles" on public.reader_profiles
  as restrictive for all to authenticated
  using ((select coalesce(auth.jwt()->>'is_anonymous', 'false')) = 'false')
  with check ((select coalesce(auth.jwt()->>'is_anonymous', 'false')) = 'false');
create policy "no anonymous accounts in reader buckets" on storage.objects
  as restrictive for all to authenticated
  using (bucket_id not in ('novel-files', 'character-avatars') or (select coalesce(auth.jwt()->>'is_anonymous', 'false')) = 'false')
  with check (bucket_id not in ('novel-files', 'character-avatars') or (select coalesce(auth.jwt()->>'is_anonymous', 'false')) = 'false');

-- A service-only admission counter and expiring lease. There is no novel data,
-- provider key, prompt, or response in this schema.
create table reader_private.ai_project_usage (
  kind text primary key check (kind in ('status', 'provider')),
  day bigint not null default 0,
  requests integer not null default 0
);
insert into reader_private.ai_project_usage (kind) values ('status'), ('provider');
create table reader_private.ai_user_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('status', 'provider')),
  minute bigint not null default 0,
  minute_requests integer not null default 0,
  day bigint not null default 0,
  day_requests integer not null default 0,
  lease_id uuid,
  lease_until timestamptz,
  primary key (user_id, kind)
);
alter table reader_private.ai_project_usage enable row level security;
alter table reader_private.ai_user_usage enable row level security;
create index reader_ai_active_lease on reader_private.ai_user_usage (lease_until) where lease_id is not null;
grant select, update on reader_private.ai_project_usage to service_role;
grant select, insert, update on reader_private.ai_user_usage to service_role;

create function public.reserve_reader_ai_request(p_user uuid, p_action text, p_request uuid)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  v_kind text;
  v_now timestamptz;
  v_minute bigint;
  v_day bigint;
  v_user reader_private.ai_user_usage%rowtype;
  v_project reader_private.ai_project_usage%rowtype;
  v_minute_requests int;
  v_day_requests int;
  v_project_requests int;
begin
  if p_user is null or p_request is null or p_action is null or p_action not in ('status', 'models', 'analyze') then
    raise exception 'INVALID_QUOTA_REQUEST';
  end if;
  v_kind := case when p_action = 'status' then 'status' else 'provider' end;
  select * into strict v_project from reader_private.ai_project_usage where kind = v_kind for update;
  v_now := clock_timestamp();
  v_minute := floor(extract(epoch from v_now) / 60);
  v_day := floor(extract(epoch from v_now) / 86400);
  v_project_requests := case when v_project.day = v_day then v_project.requests else 0 end;
  if v_project_requests >= (case when v_kind = 'status' then 4000 else 1500 end) then
    return 'PROJECT_LIMIT';
  end if;
  insert into reader_private.ai_user_usage (user_id, kind) values (p_user, v_kind)
    on conflict (user_id, kind) do nothing;
  select * into strict v_user from reader_private.ai_user_usage where user_id = p_user and kind = v_kind for update;
  if v_user.lease_until > v_now then return 'REQUEST_IN_PROGRESS'; end if;
  v_minute_requests := case when v_user.minute = v_minute then v_user.minute_requests else 0 end;
  v_day_requests := case when v_user.day = v_day then v_user.day_requests else 0 end;
  if v_minute_requests >= (case when v_kind = 'status' then 30 else 45 end) or
     v_day_requests >= (case when v_kind = 'status' then 300 else 400 end) then
    return 'RATE_LIMITED';
  end if;
  if v_kind = 'provider' and (
    select count(*) from reader_private.ai_user_usage where lease_id is not null and lease_until > v_now
  ) >= 16 then return 'PROJECT_BUSY'; end if;
  update reader_private.ai_project_usage set day = v_day, requests = v_project_requests + 1 where kind = v_kind;
  update reader_private.ai_user_usage
    set day = v_day, day_requests = v_day_requests + 1, minute = v_minute, minute_requests = v_minute_requests + 1,
        lease_id = case when v_kind = 'provider' then p_request end,
        lease_until = case when v_kind = 'provider' then v_now + interval '125 seconds' end
    where user_id = p_user and kind = v_kind;
  return 'ALLOWED';
end;
$$;

create function public.release_reader_ai_request(p_user uuid, p_request uuid)
returns void language sql security invoker set search_path = '' as $$
  update reader_private.ai_user_usage set lease_id = null, lease_until = null
  where user_id = p_user and kind = 'provider' and lease_id = p_request;
$$;
revoke all on function public.reserve_reader_ai_request(uuid, text, uuid) from public, anon, authenticated, supabase_auth_admin;
revoke all on function public.release_reader_ai_request(uuid, uuid) from public, anon, authenticated, supabase_auth_admin;
grant execute on function public.reserve_reader_ai_request(uuid, text, uuid) to service_role;
grant execute on function public.release_reader_ai_request(uuid, uuid) to service_role;
