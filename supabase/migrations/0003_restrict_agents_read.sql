-- Presence rows were readable by ANY signed-in user. If email sign-ups are enabled on the project, a stranger
-- could register and read agent names and status. Restrict reads to: owners, the agent itself, and agents that
-- share a channel with the reader. (A helper is needed because channel_members is itself RLS-protected.)
create function public.shares_channel(aid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.channel_members a
    join public.channel_members b on b.channel_id = a.channel_id
    where a.agent_id = auth.uid() and b.agent_id = aid)
$$;
revoke execute on function public.shares_channel(uuid) from public, anon;
grant execute on function public.shares_channel(uuid) to authenticated, service_role;

drop policy agents_read on public.agents;
create policy agents_read on public.agents for select to authenticated
  using (public.is_owner() or id = auth.uid() or public.shares_channel(id));
