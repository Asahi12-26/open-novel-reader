begin;
select '1..1';

do $$
begin
  if has_schema_privilege('authenticated', 'reader_private', 'USAGE')
    or has_function_privilege('anon', 'public.reader_has_private_cloud()', 'EXECUTE')
    or to_regprocedure('public.allow_reader_beta_signup(jsonb)') is not null
    or has_function_privilege('authenticated', 'public.reserve_reader_ai_request(uuid,text,uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.release_reader_ai_request(uuid,uuid)', 'EXECUTE') then
    raise exception 'Private beta operations are exposed to app clients';
  end if;
end $$;

insert into auth.users(id, email) values
  ('964f410e-6e8b-4267-96bf-07460b1e0611', 'beta-guard-a@example.invalid'),
  ('964f410e-6e8b-4267-96bf-07460b1e0612', 'beta-guard-b@example.invalid');
insert into reader_private.cloud_members(user_id) values ('964f410e-6e8b-4267-96bf-07460b1e0611');

set local role authenticated;
set local request.jwt.claims = '{"sub":"964f410e-6e8b-4267-96bf-07460b1e0611","role":"authenticated","is_anonymous":false}';
select public.save_reader_record('beta-guard-own', '{"schema":1,"book":{"id":"beta-guard-own"}}', 0);
insert into public.reader_profiles(payload) values ('{"preferences":{"theme":"dark"}}');
insert into storage.objects(bucket_id, name) values
  ('novel-files', '964f410e-6e8b-4267-96bf-07460b1e0611/beta-guard/original.txt');
do $$
begin
  if public.reader_has_private_cloud() is not true
    or not exists(select 1 from public.reader_records where id = 'beta-guard-own')
    or not exists(select 1 from public.reader_profiles)
    or not exists(select 1 from storage.objects where bucket_id = 'novel-files' and name like '%/beta-guard/%') then
    raise exception 'Approved owner cannot access their library';
  end if;
end $$;
set local request.jwt.claims = '{"sub":"964f410e-6e8b-4267-96bf-07460b1e0612","role":"authenticated","is_anonymous":false}';
do $$
begin
  if public.reader_has_private_cloud() is not false
    or exists(select 1 from public.reader_records where id = 'beta-guard-own')
    or exists(select 1 from public.reader_profiles)
    or exists(select 1 from storage.objects where bucket_id = 'novel-files' and name like '%/beta-guard/%') then
    raise exception 'Other account can read owner data';
  end if;
  begin
    perform public.save_reader_record('beta-guard-denied', '{"schema":1,"book":{"id":"beta-guard-denied"}}', 0);
    raise exception 'Other account can use storage quota';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects(bucket_id,name) values
      ('novel-files','964f410e-6e8b-4267-96bf-07460b1e0612/beta-guard/other.txt');
    raise exception 'Other account can use novel Storage quota';
  exception when insufficient_privilege then null;
  end;
end $$;
set local request.jwt.claims = '{"sub":"964f410e-6e8b-4267-96bf-07460b1e0611","role":"authenticated","is_anonymous":true}';
do $$
begin
  if exists(select 1 from public.reader_records where id = 'beta-guard-own')
    or exists(select 1 from public.reader_profiles)
    or exists(select 1 from storage.objects where bucket_id = 'novel-files' and name like '%/beta-guard/%') then
    raise exception 'Anonymous Auth identity can read private data';
  end if;
  begin
    perform public.save_reader_record('beta-guard-anon', '{"schema":1,"book":{"id":"beta-guard-anon"}}', 0);
    raise exception 'Anonymous Auth identity can write a book';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- All changes, including counters, are rolled back.
update reader_private.ai_project_usage set day = 0, requests = 0;
set local role service_role;
do $$
declare
  reader_id uuid := '964f410e-6e8b-4267-96bf-07460b1e0611';
  first_request uuid := gen_random_uuid();
  second_request uuid := gen_random_uuid();
begin
  if public.reserve_reader_ai_request(reader_id, 'analyze', first_request) <> 'ALLOWED' then
    raise exception 'First request was not admitted';
  end if;
  perform public.release_reader_ai_request(reader_id, second_request);
  if public.reserve_reader_ai_request(reader_id, 'models', second_request) <> 'REQUEST_IN_PROGRESS' then
    raise exception 'A different nonce could clear or overlap the lease';
  end if;
  if public.reserve_reader_ai_request(reader_id, 'status', second_request) <> 'ALLOWED' then
    raise exception 'Status should not reserve a provider lease';
  end if;
  perform public.release_reader_ai_request(reader_id, first_request);
  if public.reserve_reader_ai_request(reader_id, 'analyze', second_request) <> 'ALLOWED' then
    raise exception 'Completed request did not release its lease';
  end if;
  perform public.release_reader_ai_request(reader_id, second_request);
  update reader_private.ai_user_usage set day_requests = 400 where user_id = reader_id and kind = 'provider';
  if public.reserve_reader_ai_request(reader_id, 'analyze', second_request) <> 'RATE_LIMITED' then
    raise exception 'Daily account ceiling did not deny request';
  end if;
  update reader_private.ai_project_usage set requests = 1500 where kind = 'provider';
  if public.reserve_reader_ai_request(reader_id, 'analyze', second_request) <> 'PROJECT_LIMIT' then
    raise exception 'Daily project ceiling did not deny request';
  end if;
end $$;
reset role;
select 'ok 1 - owner-only records and Storage, role access and durable legacy proxy admission';
rollback;
