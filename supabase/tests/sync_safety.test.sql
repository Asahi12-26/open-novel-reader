begin;
create extension if not exists pgtap with schema extensions;
select plan(11);
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-000000000021', 'safety-a@example.invalid'),
  ('00000000-0000-0000-0000-000000000022', 'safety-b@example.invalid');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000021","role":"authenticated"}';
select is(public.save_reader_record('restored', '{"schema":1,"book":{"id":"restored","restoredAt":10}}', 0), 1::bigint, 'initial restored record is saved');
update public.reader_records set payload = jsonb_set(payload, '{book,title}', '"legacy edit"'), revision = 999 where id = 'restored';
select is((select revision from public.reader_records where id = 'restored'), 2::bigint, 'direct legacy update increments revision instead of accepting a supplied revision');
select throws_ok($$select public.save_reader_record('restored', '{"schema":1,"book":{"id":"restored","restoredAt":10}}', 1)$$, 'P0001', 'SYNC_CONFLICT', 'CAS notices a legacy table write');
select throws_ok($$select public.save_reader_record('restored', '{"schema":1,"book":{"id":"restored","restoredAt":10,"deletedAt":9}}', 2)$$, '23514', 'new row for relation "reader_records" violates check constraint "reader_records_restoration_order"', 'old deletion cannot override a newer explicit restore');
select is(public.save_reader_profile('{"preferences":{},"shelves":[]}', 0), 1::bigint, 'initial profile is saved');
update public.reader_profiles set payload = '{"preferences":{"theme":"dark"},"shelves":[]}', revision = 999;
select is((select revision from public.reader_profiles), 2::bigint, 'legacy profile upsert cannot bypass revision tracking');
select throws_ok($$select public.save_reader_profile('{"preferences":{},"shelves":[]}', 1)$$, 'P0001', 'SYNC_CONFLICT', 'profile CAS notices a legacy write');
insert into storage.objects(bucket_id, name) values ('novel-files', '00000000-0000-0000-0000-000000000021/restored/restored-10/original.txt');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000022","role":"authenticated"}';
select is((select count(*) from public.reader_records), 0::bigint, 'second account cannot read first records');
select is((select count(*) from public.reader_profiles), 0::bigint, 'second account cannot read first profile');
delete from storage.objects where bucket_id = 'novel-files';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000021","role":"authenticated"}';
select is((select count(*) from storage.objects where bucket_id = 'novel-files'), 1::bigint, 'another account cannot delete the restored generation file');
select is((select payload->'book'->>'restoredAt' from public.reader_records where id = 'restored'), '10', 'failed stale deletion leaves restored payload intact');
select * from finish();
rollback;
