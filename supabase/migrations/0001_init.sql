-- agentchat: shared chat + task board + file claims for concurrent Claude sessions.
-- Agents are ephemeral rows created/deleted by the `agent` Edge Function (service role).
-- Humans (owners) sign in with normal Supabase Auth and are listed in `owners`.

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table public.owners (
  user_id uuid primary key references auth.users on delete cascade
);

create table public.settings (
  key text primary key,
  value jsonb not null
);
insert into public.settings values ('paused', 'false'::jsonb) on conflict do nothing;

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  project text not null,
  status text,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null,
  cursor_at timestamptz not null default now()
);
-- names are unique among LIVE agents only (rows are deleted on leave/expiry)
create unique index agents_name_key on public.agents (lower(name));

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table public.channel_members (
  channel_id uuid not null references public.channels on delete cascade,
  agent_id uuid not null references public.agents on delete cascade,
  primary key (channel_id, agent_id)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels on delete cascade,
  title text not null check (length(title) <= 300),
  description text,
  status text not null default 'open' check (status in ('open', 'claimed', 'done', 'blocked')),
  owner_name text,
  created_by text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels on delete cascade,
  sender_id uuid references public.agents on delete set null,
  sender_name text not null,
  recipient_name text,                       -- null = whole channel, else a DM
  kind text not null check (kind in
    ('status','done','question','blocker','info','system','approval_request','approval','command')),
  body text not null check (length(body) <= 4000),
  payload jsonb not null default '{}'::jsonb,
  task_id uuid references public.tasks on delete set null,
  reply_to uuid references public.messages on delete set null,
  needs_reply boolean not null default false,
  hop_count int not null default 0,
  from_owner boolean not null default false,
  created_at timestamptz not null default now()
);
create index messages_channel_created on public.messages (channel_id, created_at);

create table public.claims (
  channel_id uuid not null references public.channels on delete cascade,
  path text not null,
  agent_id uuid not null references public.agents on delete cascade,
  agent_name text not null,
  expires_at timestamptz not null,
  primary key (channel_id, path)
);

-- ---------- helpers ----------
create function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.owners where user_id = auth.uid())
$$;

create function public.is_member(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.channel_members where channel_id = cid and agent_id = auth.uid())
$$;

create function public.my_name() returns text
language sql stable security definer set search_path = public as $$
  select name from public.agents where id = auth.uid()
$$;

-- ---------- message guard: pause switch, rate limit, hop limit ----------
create function public.messages_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  paused boolean;
  parent record;
begin
  if new.sender_name = 'system' and new.sender_id is null and not new.from_owner then
    new.hop_count := 0;
    return new;
  end if;

  select (value)::text = 'true' into paused from public.settings where key = 'paused';
  if coalesce(paused, false) and not new.from_owner then
    raise exception 'agentchat is paused by the owner';
  end if;

  if new.sender_id is not null then
    if (select count(*) from public.messages
        where sender_id = new.sender_id and created_at > now() - interval '60 seconds') >= 20 then
      raise exception 'rate limit: max 20 messages per minute';
    end if;
  end if;

  -- hop_count is server-computed so a client can't reset it
  new.hop_count := 0;
  if new.reply_to is not null and not new.from_owner then
    select hop_count, from_owner into parent from public.messages where id = new.reply_to;
    if found and not parent.from_owner then
      new.hop_count := parent.hop_count + 1;
    end if;
  end if;
  if new.hop_count > 5 then
    raise exception 'hop limit reached (agent-to-agent reply chain too long); wait for the owner';
  end if;
  return new;
end $$;

create trigger messages_guard_trg before insert on public.messages
for each row execute function public.messages_guard();

create function public.tasks_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger tasks_touch_trg before update on public.tasks
for each row execute function public.tasks_touch();

-- ---------- RPCs used by agents ----------
create function public.claim_task(p_task uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.tasks set status = 'claimed', owner_name = public.my_name()
  where id = p_task and status = 'open' and public.is_member(channel_id);
  get diagnostics n = row_count;
  return n > 0;
end $$;

create function public.complete_task(
  p_channel uuid, p_task uuid, p_summary text, p_payload jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  if not public.is_member(p_channel) then raise exception 'not a member of this channel'; end if;
  if p_task is not null then
    update public.tasks set status = 'done', result = p_payload
    where id = p_task and channel_id = p_channel
      and (owner_name is null or lower(owner_name) = lower(public.my_name()));
  end if;
  insert into public.messages (channel_id, sender_id, sender_name, kind, body, payload, task_id)
  values (p_channel, auth.uid(), public.my_name(), 'done', p_summary, coalesce(p_payload, '{}'::jsonb), p_task)
  returning id into mid;
  return mid;
end $$;

create function public.claim_path(p_channel uuid, p_path text, p_ttl_seconds int default 900)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare holder text;
begin
  if not public.is_member(p_channel) then raise exception 'not a member of this channel'; end if;
  delete from public.claims where expires_at < now();
  insert into public.claims (channel_id, path, agent_id, agent_name, expires_at)
  values (p_channel, p_path, auth.uid(), public.my_name(),
          now() + make_interval(secs => least(greatest(p_ttl_seconds, 30), 3600)))
  on conflict (channel_id, path) do update set expires_at = excluded.expires_at
  where public.claims.agent_id = excluded.agent_id;
  select agent_name into holder from public.claims where channel_id = p_channel and path = p_path;
  return jsonb_build_object('ok', lower(holder) = lower(public.my_name()), 'holder', holder);
end $$;

create function public.release_path(p_channel uuid, p_path text) returns void
language sql security definer set search_path = public as $$
  delete from public.claims where channel_id = p_channel and path = p_path and agent_id = auth.uid()
$$;

create function public.set_cursor(p_ts timestamptz) returns void
language sql security definer set search_path = public as $$
  update public.agents set cursor_at = p_ts where id = auth.uid() and p_ts > cursor_at
$$;

create function public.set_status(p_status text) returns void
language sql security definer set search_path = public as $$
  update public.agents set status = left(p_status, 200) where id = auth.uid()
$$;

-- ---------- lifecycle (service role / cron only) ----------
create function public.remove_agent(aid uuid, reason text default 'left') returns void
language plpgsql security definer set search_path = public as $$
declare a record; c record;
begin
  select * into a from public.agents where id = aid;
  if not found then return; end if;
  for c in select channel_id from public.channel_members where agent_id = aid loop
    insert into public.messages (channel_id, sender_name, kind, body)
    values (c.channel_id, 'system', 'system', a.name || ' left (' || reason || ')');
    update public.tasks set status = 'open', owner_name = null
    where channel_id = c.channel_id and status = 'claimed' and lower(owner_name) = lower(a.name);
  end loop;
  delete from public.agents where id = aid;   -- cascades members + claims; messages.sender_id -> null
end $$;

create function public.reap_agents() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id from public.agents where expires_at < now() loop
    perform public.remove_agent(r.id, 'expired');
    n := n + 1;
  end loop;
  delete from public.claims where expires_at < now();
  return n;
end $$;

revoke all on function public.remove_agent(uuid, text) from public, anon, authenticated;
revoke all on function public.reap_agents() from public, anon, authenticated;
revoke execute on function public.claim_task(uuid) from public, anon;
revoke execute on function public.complete_task(uuid, uuid, text, jsonb) from public, anon;
revoke execute on function public.claim_path(uuid, text, int) from public, anon;
revoke execute on function public.release_path(uuid, text) from public, anon;
revoke execute on function public.set_cursor(timestamptz) from public, anon;
revoke execute on function public.set_status(text) from public, anon;

-- ---------- row level security ----------
alter table public.owners enable row level security;
alter table public.settings enable row level security;
alter table public.agents enable row level security;
alter table public.channels enable row level security;
alter table public.channel_members enable row level security;
alter table public.tasks enable row level security;
alter table public.messages enable row level security;
alter table public.claims enable row level security;

revoke all on all tables in schema public from anon;

create policy owners_self on public.owners for select to authenticated using (user_id = auth.uid());

create policy settings_read on public.settings for select to authenticated using (public.is_owner() or key = 'paused');
create policy settings_owner_write on public.settings for update to authenticated
  using (public.is_owner()) with check (public.is_owner());

-- presence is visible to anyone signed in (names + status only; no secrets live here)
create policy agents_read on public.agents for select to authenticated using (true);

create policy channels_read on public.channels for select to authenticated
  using (public.is_owner() or public.is_member(id));
create policy channels_owner_write on public.channels for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

create policy members_read on public.channel_members for select to authenticated
  using (public.is_owner() or agent_id = auth.uid());

create policy messages_read on public.messages for select to authenticated using (
  public.is_owner()
  or (public.is_member(channel_id)
      and (recipient_name is null
           or lower(recipient_name) = lower(public.my_name())
           or sender_id = auth.uid()))
);
create policy messages_insert_owner on public.messages for insert to authenticated
  with check (public.is_owner() and from_owner and sender_id is null and sender_name = 'owner');
create policy messages_insert_agent on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and not from_owner and public.is_member(channel_id)
              and sender_name = public.my_name() and kind not in ('system','command','approval'));

create policy tasks_read on public.tasks for select to authenticated
  using (public.is_owner() or public.is_member(channel_id));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.is_owner() or (public.is_member(channel_id) and created_by = public.my_name() and status = 'open'));
create policy tasks_owner_update on public.tasks for update to authenticated
  using (public.is_owner()) with check (public.is_owner());
create policy tasks_owner_delete on public.tasks for delete to authenticated using (public.is_owner());

create policy claims_read on public.claims for select to authenticated
  using (public.is_owner() or public.is_member(channel_id));
create policy claims_owner_delete on public.claims for delete to authenticated using (public.is_owner());

-- ---------- realtime ----------
alter publication supabase_realtime add table public.messages, public.tasks, public.agents, public.claims;

-- ---------- reaper (needs pg_cron: enable under Database > Extensions, then re-run this block) ----------
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('agentchat-reap', '* * * * *', 'select public.reap_agents()');
exception when others then
  raise notice 'pg_cron not available (%). Enable it in the dashboard and run: select cron.schedule(''agentchat-reap'', ''* * * * *'', ''select public.reap_agents()'');', sqlerrm;
end $$;
