-- Local-first book envelopes, versioned for compare-and-swap synchronization.
create table if not exists public.reader_records (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  id text not null check (length(id) between 1 and 200),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 40000000),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create table if not exists public.reader_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 2000000),
  updated_at timestamptz not null default now()
);
alter table public.reader_records enable row level security;
alter table public.reader_profiles enable row level security;
revoke all on public.reader_records, public.reader_profiles from anon;
grant select, insert, update, delete on public.reader_records, public.reader_profiles to authenticated;
create policy "owners select records" on public.reader_records for select to authenticated using ((select auth.uid()) = user_id);
create policy "owners insert records" on public.reader_records for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owners update records" on public.reader_records for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owners delete records" on public.reader_records for delete to authenticated using ((select auth.uid()) = user_id);
create policy "owners select profiles" on public.reader_profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy "owners insert profiles" on public.reader_profiles for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owners update profiles" on public.reader_profiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owners delete profiles" on public.reader_profiles for delete to authenticated using ((select auth.uid()) = user_id);

-- SECURITY INVOKER preserves row policies. CAS rejects stale writes instead of silently losing changes.
create or replace function public.save_reader_record(p_id text, p_payload jsonb, p_expected_revision bigint)
returns bigint language plpgsql security invoker set search_path = public, pg_temp as $$
declare saved_revision bigint;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_payload->>'schema' is distinct from '1' or p_payload->'book'->>'id' is distinct from p_id then raise exception 'INVALID_ENVELOPE'; end if;
  if p_expected_revision = 0 then
    insert into public.reader_records(user_id, id, payload, revision)
    values (auth.uid(), p_id, p_payload, 1)
    on conflict (user_id, id) do nothing returning revision into saved_revision;
  else
    update public.reader_records set payload = p_payload, revision = revision + 1, updated_at = now()
    where user_id = auth.uid() and id = p_id and revision = p_expected_revision
    returning revision into saved_revision;
  end if;
  if saved_revision is null then raise exception 'SYNC_CONFLICT'; end if;
  return saved_revision;
end $$;
revoke all on function public.save_reader_record(text, jsonb, bigint) from public, anon;
grant execute on function public.save_reader_record(text, jsonb, bigint) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('novel-files', 'novel-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
create policy "owners read novel files" on storage.objects for select to authenticated
using (bucket_id = 'novel-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "owners upload novel files" on storage.objects for insert to authenticated
with check (bucket_id = 'novel-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "owners replace novel files" on storage.objects for update to authenticated
using (bucket_id = 'novel-files' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'novel-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "owners delete novel files" on storage.objects for delete to authenticated
using (bucket_id = 'novel-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
