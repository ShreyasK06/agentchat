-- Applied to the live project as `agentchat_tighten_function_grants`.
-- The RLS helper functions must stay callable by signed-in users (policies run as the caller),
-- but nobody anonymous needs them, and trigger functions need no direct EXECUTE at all.
revoke execute on function public.is_member(uuid), public.is_owner(), public.my_name() from public, anon;
grant execute on function public.is_member(uuid), public.is_owner(), public.my_name() to authenticated, service_role;
revoke execute on function public.messages_guard(), public.tasks_touch() from public, anon, authenticated;
alter function public.tasks_touch() set search_path = public;
