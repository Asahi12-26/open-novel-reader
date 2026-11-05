-- The platform DDL helper is an event trigger, never a client-facing RPC.
-- Keep its automatic RLS behavior while closing its unnecessary API grants.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
      and p.pronargs = 0 and p.prorettype = 'event_trigger'::regtype
  ) then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
