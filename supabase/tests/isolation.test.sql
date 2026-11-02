begin;
create extension if not exists pgtap with schema extensions;
select plan(8);
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-000000000001', 'reader-a@example.invalid'),
  ('00000000-0000-0000-0000-000000000002', 'reader-b@example.invalid');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is(public.save_reader_record('book-a', '{"schema":1,"book":{"id":"book-a"}}', 0), 1::bigint, 'owner can create book');
select is((select count(*) from public.reader_records), 1::bigint, 'owner sees own record');
select throws_ok($$select public.save_reader_record('book-a', '{"schema":1,"book":{"id":"book-a"}}', 0)$$, 'P0001', 'SYNC_CONFLICT', 'stale insert rejected');
insert into public.reader_profiles(payload) values ('{"preferences":{"theme":"dark"}}');
insert into storage.objects(bucket_id, name) values ('novel-files', '00000000-0000-0000-0000-000000000001/book-a/original.txt');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from public.reader_records), 0::bigint, 'second account cannot read first account books');
select is((select count(*) from public.reader_profiles), 0::bigint, 'second account cannot read first account preferences');
select is((select count(*) from storage.objects where bucket_id = 'novel-files'), 0::bigint, 'second account cannot read first account files');
select throws_ok($$insert into public.reader_records(user_id,id,payload) values ('00000000-0000-0000-0000-000000000001','evil','{}')$$, '42501', 'new row violates row-level security policy for table "reader_records"', 'cannot write another account record');
reset role;
set local role anon;
select throws_ok($$select * from public.reader_records$$, '42501', 'permission denied for table reader_records', 'anonymous read is denied');
select * from finish();
rollback;
