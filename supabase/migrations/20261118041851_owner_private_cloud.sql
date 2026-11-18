-- Grant only explicitly approved Supabase Auth UIDs. The hosted owner is
-- provisioned separately. New deployments start with an empty allowlist.
create table reader_private.cloud_members (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table reader_private.cloud_members enable row level security;
revoke all on reader_private.cloud_members from public, anon, authenticated, service_role, supabase_auth_admin;

-- The SECURITY DEFINER is in a non-exposed schema, returns one boolean,
-- accepts no input, and can only check the caller's verified Auth UID.
create schema reader_access;
revoke all on schema reader_access from public, anon;
grant usage on schema reader_access to authenticated;
create function reader_access.has_private_cloud()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select coalesce(auth.jwt()->>'is_anonymous', 'false')) = 'false' and exists (
    select 1 from reader_private.cloud_members where user_id = (select auth.uid())
  );
$$;
revoke all on function reader_access.has_private_cloud() from public, anon;
grant execute on function reader_access.has_private_cloud() to authenticated;

create function public.reader_has_private_cloud()
returns boolean language sql stable security invoker set search_path = '' as $$
  select reader_access.has_private_cloud();
$$;
revoke all on function public.reader_has_private_cloud() from public, anon;
grant execute on function public.reader_has_private_cloud() to authenticated;

create policy "private cloud members only in reader records" on public.reader_records
  as restrictive for all to authenticated
  using ((select reader_access.has_private_cloud())) with check ((select reader_access.has_private_cloud()));
create policy "private cloud members only in reader profiles" on public.reader_profiles
  as restrictive for all to authenticated
  using ((select reader_access.has_private_cloud())) with check ((select reader_access.has_private_cloud()));
create policy "private cloud members only in reader buckets" on storage.objects
  as restrictive for all to authenticated
  using (bucket_id not in ('novel-files', 'character-avatars') or (select reader_access.has_private_cloud()))
  with check (bucket_id not in ('novel-files', 'character-avatars') or (select reader_access.has_private_cloud()));

-- The former registration prototype was never attached to Supabase Auth.
-- Keep the migration history and its private table, and remove the inactive hook.
drop function if exists public.allow_reader_beta_signup(jsonb);
revoke select on reader_private.signup_allowlist from supabase_auth_admin;
