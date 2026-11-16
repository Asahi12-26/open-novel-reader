-- Compressed avatar binaries stay outside the novel's JSON envelope.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('character-avatars', 'character-avatars', false, 307200, array['image/png'])
on conflict (id) do update set
  public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "owners read character avatars" on storage.objects for select to authenticated
using (
  bucket_id = 'character-avatars'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (select coalesce(auth.jwt()->>'is_anonymous', 'false')) = 'false'
  and name ~ '^[0-9a-f-]{36}/book-[0-9a-f]{32}/(initial|restored-[1-9][0-9]{0,15})/[0-9a-f]{64}[.]png$'
);

create policy "owners upload character avatars" on storage.objects for insert to authenticated
with check (
  bucket_id = 'character-avatars'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (select coalesce(auth.jwt()->>'is_anonymous', 'false')) = 'false'
  and name ~ '^[0-9a-f-]{36}/book-[0-9a-f]{32}/(initial|restored-[1-9][0-9]{0,15})/[0-9a-f]{64}[.]png$'
);
-- Immutable objects: the client writes a new digest when changing a photo.
-- Earlier versions remain private so an in-flight compare-and-swap cannot reference a deleted object.

create function public.reader_preserve_avatar_fields()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'reader_records' then
    -- A legacy client saves its current annotations without the avatar manifest.
    if old.payload ? 'avatars' and not (new.payload ? 'avatars')
      and old.payload #>> '{book,deletedAt}' is null
      and new.payload #>> '{book,deletedAt}' is null
      and (old.payload #>> '{book,restoredAt}') is not distinct from (new.payload #>> '{book,restoredAt}') then
      -- Avoid leaving saved avatar references to characters an old client merged destructively.
      if exists (
        select 1 from jsonb_array_elements(old.payload -> 'avatars') as entry
        where not (coalesce(new.payload -> 'characters', '[]'::jsonb)
                   @> jsonb_build_array(jsonb_build_object('id', entry -> 'characterId')))
      ) then
        raise exception 'AVATAR_CHARACTER_CONFLICT';
      end if;
      new.payload := jsonb_set(new.payload, '{avatars}', old.payload -> 'avatars');
    end if;
  elsif jsonb_typeof(new.payload -> 'preferences') = 'object'
    and old.payload #> '{preferences,showAvatars}' is not null
    and new.payload #> '{preferences,showAvatars}' is null then
    new.payload := jsonb_set(new.payload, '{preferences,showAvatars}', old.payload #> '{preferences,showAvatars}');
  end if;
  return new;
end $$;
revoke all on function public.reader_preserve_avatar_fields() from public, anon;

create trigger reader_records_preserve_avatars before update on public.reader_records
for each row execute function public.reader_preserve_avatar_fields();
create trigger reader_profiles_preserve_avatars before update on public.reader_profiles
for each row execute function public.reader_preserve_avatar_fields();
