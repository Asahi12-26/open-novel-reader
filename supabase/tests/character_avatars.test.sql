begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

select ok(
  (select not public and file_size_limit = 307200 and allowed_mime_types = array['image/png']
   from storage.buckets where id = 'character-avatars'),
  'avatar bucket is private and limited to small PNGs'
);

insert into auth.users(id, email) values
  ('1bb0aebb-406e-428e-bb2c-01d899300001', 'avatar-a@example.invalid'),
  ('1bb0aebb-406e-428e-bb2c-01d899300002', 'avatar-b@example.invalid');
insert into reader_private.cloud_members(user_id) values
  ('1bb0aebb-406e-428e-bb2c-01d899300001'), ('1bb0aebb-406e-428e-bb2c-01d899300002');

set local role authenticated;
set local request.jwt.claims = '{"sub":"1bb0aebb-406e-428e-bb2c-01d899300001","role":"authenticated","is_anonymous":false}';
select lives_ok($$
  insert into storage.objects(bucket_id, name) values (
    'character-avatars', '1bb0aebb-406e-428e-bb2c-01d899300001/book-' || repeat('a', 32) || '/initial/' || repeat('f', 64) || '.png'
  )
$$, 'owner can insert a generation-scoped avatar');
select is((select count(*) from storage.objects where bucket_id = 'character-avatars'), 1::bigint, 'owner reads own avatar');
select throws_ok($$
  insert into storage.objects(bucket_id, name) values (
    'character-avatars', '1bb0aebb-406e-428e-bb2c-01d899300001/book-' || repeat('a', 32) || '/initial/' || repeat('f', 64) || '.svg'
  )
$$, '42501', null, 'invalid avatar path is denied');
select throws_ok($$
  insert into storage.objects(bucket_id, name) values (
    'character-avatars', '1bb0aebb-406e-428e-bb2c-01d899300002/book-' || repeat('a', 32) || '/initial/' || repeat('f', 64) || '.png'
  )
$$, '42501', null, 'cannot upload into a different account');
set local request.jwt.claims = '{"sub":"1bb0aebb-406e-428e-bb2c-01d899300002","role":"authenticated","is_anonymous":false}';
select is((select count(*) from storage.objects where bucket_id = 'character-avatars'), 0::bigint, 'different account cannot read first avatar');
set local request.jwt.claims = '{"sub":"1bb0aebb-406e-428e-bb2c-01d899300001","role":"authenticated","is_anonymous":true}';
select is((select count(*) from storage.objects where bucket_id = 'character-avatars'), 0::bigint, 'anonymous Auth user cannot read avatar');

set local request.jwt.claims = '{"sub":"1bb0aebb-406e-428e-bb2c-01d899300001","role":"authenticated","is_anonymous":false}';
insert into public.reader_records(id, payload) values ('avatar-fixture',
  '{"schema":1,"book":{"id":"avatar-fixture"},"characters":[{"id":"rain"}],"avatars":[{"characterId":"rain"}]}'
);
update public.reader_records set payload = '{"schema":1,"book":{"id":"avatar-fixture"},"characters":[{"id":"rain","name":"new"}]}'
where id = 'avatar-fixture';
select is((select payload #>> '{avatars,0,characterId}' from public.reader_records where id = 'avatar-fixture'), 'rain', 'legacy updates retain avatar manifests');
select throws_ok($$
  update public.reader_records set payload = '{"schema":1,"book":{"id":"avatar-fixture"},"characters":[]}'
  where id = 'avatar-fixture'
$$, 'P0001', 'AVATAR_CHARACTER_CONFLICT', 'legacy destructive merge is rejected without dropping avatar link');
update public.reader_records set payload = '{"schema":1,"book":{"id":"avatar-fixture","deletedAt":10},"characters":[]}'
where id = 'avatar-fixture';
select ok((select not (payload ? 'avatars') from public.reader_records where id = 'avatar-fixture'), 'tombstone drops active avatar refs');
update public.reader_records set payload = '{"schema":1,"book":{"id":"avatar-fixture","restoredAt":11},"characters":[{"id":"rain"}],"avatars":[{"characterId":"rain"}]}'
where id = 'avatar-fixture';
update public.reader_records set payload = '{"schema":1,"book":{"id":"avatar-fixture","restoredAt":12},"characters":[{"id":"rain"}]}'
where id = 'avatar-fixture';
select ok((select not (payload ? 'avatars') from public.reader_records where id = 'avatar-fixture'), 'new generation does not inherit private old refs');
insert into public.reader_profiles(payload) values ('{"preferences":{"showAvatars":false}}');
update public.reader_profiles set payload = '{"preferences":{"theme":"sepia"}}';
select is((select payload #>> '{preferences,showAvatars}' from public.reader_profiles), 'false', 'legacy clients preserve avatar display preference');

select * from finish();
rollback;
