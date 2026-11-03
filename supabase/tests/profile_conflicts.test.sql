begin;
create extension if not exists pgtap with schema extensions;
select plan(7);
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-000000000011', 'profile-a@example.invalid'),
  ('00000000-0000-0000-0000-000000000012', 'profile-b@example.invalid');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000011","role":"authenticated"}';
select is(public.save_reader_profile('{"preferences":{"theme":"dark"},"shelves":[]}', 0), 1::bigint, 'owner creates initial profile');
select throws_ok($$select public.save_reader_profile('{"shelves":[]}', 0)$$, 'P0001', 'SYNC_CONFLICT', 'concurrent first writer cannot replace an existing profile');
select is(public.save_reader_profile('{"preferences":{"theme":"sepia"},"shelves":[]}', 1), 2::bigint, 'matching revision updates profile');
select throws_ok($$select public.save_reader_profile('{"preferences":{"theme":"light"},"shelves":[]}', 1)$$, 'P0001', 'SYNC_CONFLICT', 'stale device write is rejected');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000012","role":"authenticated"}';
select is((select count(*) from public.reader_profiles), 0::bigint, 'second account cannot read first profile');
select is(public.save_reader_profile('{"preferences":{"theme":"light"},"shelves":[]}', 0), 1::bigint, 'second account creates its own independent revision');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000011","role":"authenticated"}';
select is((select payload->'preferences'->>'theme' from public.reader_profiles), 'sepia', 'other account update cannot replace original profile');
select * from finish();
rollback;
