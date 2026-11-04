-- Keep revision monotonic even when an older client uses direct table upsert.
create or replace function public.reader_bump_revision()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.reader_bump_revision() from public, anon;
drop trigger if exists reader_records_revision on public.reader_records;
create trigger reader_records_revision before update on public.reader_records
for each row execute function public.reader_bump_revision();
drop trigger if exists reader_profiles_revision on public.reader_profiles;
create trigger reader_profiles_revision before update on public.reader_profiles
for each row execute function public.reader_bump_revision();

-- An old delete cannot override a newer explicit restore. NOT VALID preserves any
-- legacy corrupt record for manual recovery; all future writes are constrained.
alter table public.reader_records add constraint reader_records_restoration_order
check (
  payload #>> '{book,deletedAt}' is null or (
    jsonb_typeof(payload #> '{book,deletedAt}') = 'number'
    and (payload #>> '{book,deletedAt}')::numeric >= 0
    and (payload #>> '{book,restoredAt}' is null or (
      jsonb_typeof(payload #> '{book,restoredAt}') = 'number'
      and (payload #>> '{book,restoredAt}')::numeric <= (payload #>> '{book,deletedAt}')::numeric
    ))
  )
) not valid;
