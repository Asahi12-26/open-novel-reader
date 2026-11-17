-- Story data lives in the existing per-book, owner-isolated envelope.
-- Earlier readers may update progress without including the optional field.
create function public.reader_preserve_story_field()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if old.payload ? 'story' and not (new.payload ? 'story')
    and old.payload #>> '{book,deletedAt}' is null
    and new.payload #>> '{book,deletedAt}' is null
    and (old.payload #>> '{book,restoredAt}') is not distinct from (new.payload #>> '{book,restoredAt}') then
    -- A destructive merge by a much older client must not break stored
    -- evidence, links or correction history. Current clients retain IDs.
    if exists (
      select 1 from jsonb_array_elements(coalesce(old.payload->'characters', '[]'::jsonb)) as row_data
      where not (coalesce(new.payload->'characters', '[]'::jsonb)
        @> jsonb_build_array(jsonb_build_object('id', row_data->'id')))
    ) then
      raise exception 'STORY_CHARACTER_CONFLICT';
    end if;
    new.payload := jsonb_set(new.payload, '{story}', old.payload->'story');
  end if;
  return new;
end $$;

revoke all on function public.reader_preserve_story_field() from public, anon;
create trigger reader_records_preserve_story before update on public.reader_records
for each row execute function public.reader_preserve_story_field();
