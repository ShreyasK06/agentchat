// Two interchangeable backends for the dashboard:
//   createLiveApi(session)  - talks to Supabase as the signed-in owner (RLS does the gatekeeping)
//   createDemoApi()         - in-memory sample data with simulated agents; nothing is saved, no network
// Both return the same shape so the UI never branches on which one it has.
import { supabase } from './supabase.js';

const fail = (r) => (r.error ? { error: r.error.message } : {});

export function createLiveApi(session) {
  const uid = session.user.id;
  return {
    mode: 'live',
    who: session.user.email,
    userId: uid,

    async loadMeta() {
      const [own, ch, ag, st] = await Promise.all([
        supabase.from('owners').select('user_id').eq('user_id', uid).maybeSingle(),
        supabase.from('channels').select('*').order('name'),
        supabase.from('agents').select('*').order('name'),
        supabase.from('settings').select('value').eq('key', 'paused').maybeSingle(),
      ]);
      return {
        isOwner: Boolean(own.data),
        channels: ch.data ?? [],
        agents: ag.data ?? [],
        paused: st.data?.value === true,
        error: ch.error?.message || own.error?.message,
      };
    },

    async loadChannel(id) {
      const [m, t, c] = await Promise.all([
        supabase.from('messages').select('*').eq('channel_id', id).order('created_at', { ascending: false }).limit(200),
        supabase.from('tasks').select('*').eq('channel_id', id).order('created_at'),
        supabase.from('claims').select('*').eq('channel_id', id).order('path'),
      ]);
      return {
        messages: (m.data ?? []).reverse(),
        tasks: t.data ?? [],
        claims: c.data ?? [],
        error: m.error?.message || t.error?.message || c.error?.message,
      };
    },

    subscribe({ onMessage, onChange, onStatus }) {
      const sub = supabase.channel('dashboard')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => p.new && onMessage(p.new))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'agents' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'claims' }, onChange)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'settings' }, onChange)
        .subscribe((status) => onStatus(status === 'SUBSCRIBED'));
      return () => supabase.removeChannel(sub);
    },

    async send(row) {
      return fail(await supabase.from('messages').insert({ sender_name: 'owner', from_owner: true, ...row }));
    },
    async addTask(channel_id, title) {
      return fail(await supabase.from('tasks').insert({ channel_id, title, created_by: 'owner' }));
    },
    async setTaskStatus(task, status) {
      const patch = { status };
      if (status === 'open') patch.owner_name = null;
      return fail(await supabase.from('tasks').update(patch).eq('id', task.id));
    },
    async deleteTask(task) {
      return fail(await supabase.from('tasks').delete().eq('id', task.id));
    },
    async releaseClaim(claim) {
      return fail(await supabase.from('claims').delete().eq('channel_id', claim.channel_id).eq('path', claim.path));
    },
    async setPaused(paused) {
      return fail(await supabase.from('settings').update({ value: paused }).eq('key', 'paused'));
    },
    signOut: () => supabase.auth.signOut(),
  };
}

// ---------------------------------------------------------------------------------------------

export function createDemoApi() {
  const mins = (n) => new Date(Date.now() - n * 60000).toISOString();
  const later = (n) => new Date(Date.now() + n * 60000).toISOString();
  const id = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

  const MILL = 'c-milling';
  const SITE = 'c-site';
  const channels = [
    { id: 'c-global', name: 'global' },
    { id: MILL, name: 'milling-research' },
    { id: SITE, name: 'portfolio-site' },
  ];
  const agents = [
    { id: 'a1', name: 'researcher', project: 'milling-research', status: 'running seed 3 of 5', last_seen: mins(0.3) },
    { id: 'a2', name: 'builder', project: 'milling-research', status: 'editing train.py', last_seen: mins(0.6) },
    { id: 'a3', name: 'reviewer', project: 'portfolio-site', status: 'reviewing PR 12', last_seen: mins(2) },
    { id: 'a4', name: 'scout', project: 'portfolio-site', status: null, last_seen: mins(14) },
  ];
  let paused = false;

  const messages = [];
  const add = (m) => {
    const row = {
      id: id(), payload: {}, needs_reply: false, reply_to: null, recipient_name: null,
      from_owner: false, hop_count: 0, task_id: null, ...m,
    };
    messages.push(row);
    return row;
  };
  const sys = (channel_id, body, ago) => add({ channel_id, sender_name: 'system', kind: 'system', body, created_at: mins(ago) });
  const say = (channel_id, sender_name, kind, body, ago, extra = {}) =>
    add({ channel_id, sender_name, kind, body, created_at: mins(ago), ...extra });

  sys(MILL, 'researcher joined', 42);
  sys(MILL, 'builder joined', 41);
  say(MILL, 'builder', 'status', 'Claimed train.py and started the data pipeline refactor.', 38);
  say(MILL, 'researcher', 'status', 'Seed 1 of 5 finished, CV accuracy 0.79.', 33);
  say(MILL, 'researcher', 'done', 'Baseline CNN finished: 5-fold CV 0.81, held-out 0.77.', 27,
    { payload: { files: ['results/baseline.json'], next: 'builder: review the CV split' } });
  say(MILL, 'builder', 'question', 'Final numbers: leave-one-cut-out CV or keep 5-fold? It changes the headline claim.', 22, { needs_reply: true });
  say(MILL, 'researcher', 'info', 'Held-out gap is 4 points. Checking for cut-level leakage between folds.', 14);
  say(MILL, 'researcher', 'blocker', 'GPU queue is full, so seed 4 cannot start until a slot frees up.', 9);
  say(MILL, 'researcher', 'approval_request', 'Delete 14 old checkpoints in /runs/old to free 6.2 GB?', 5);
  say(MILL, 'builder', 'status', 'train.py refactor 60% done.', 1);
  sys(SITE, 'reviewer joined', 30);
  say(SITE, 'reviewer', 'done', 'PR #12 reviewed: two contrast fixes requested.', 12,
    { payload: { files: ['src/Hero.jsx', 'src/theme.css'], next: 'owner: merge once fixed', artifact_url: 'https://example.com/pr/12' } });
  say(SITE, 'reviewer', 'question', 'Ship the hero animation or cut it for load time?', 4, { needs_reply: true });

  let tasks = [
    { id: 't1', channel_id: MILL, title: 'Train baseline CNN', status: 'done', owner_name: 'researcher', created_by: 'builder', result: { next: 'review CV split' } },
    { id: 't2', channel_id: MILL, title: 'Run 5 seeds of leave-one-cut-out CV', status: 'claimed', owner_name: 'researcher', created_by: 'owner' },
    { id: 't3', channel_id: MILL, title: 'Refactor the data pipeline', status: 'claimed', owner_name: 'builder', created_by: 'owner' },
    { id: 't4', channel_id: MILL, title: 'Fix cut-level leakage in the split', status: 'blocked', owner_name: 'builder', created_by: 'researcher' },
    { id: 't5', channel_id: MILL, title: 'Write evaluation report (CV and held-out)', status: 'open', owner_name: null, created_by: 'owner' },
    { id: 't6', channel_id: SITE, title: 'Audit colour contrast', status: 'claimed', owner_name: 'reviewer', created_by: 'owner' },
    { id: 't7', channel_id: SITE, title: 'Write the case study', status: 'open', owner_name: null, created_by: 'owner' },
  ];
  let claims = [
    { channel_id: MILL, path: 'train.py', agent_name: 'builder', expires_at: later(18) },
    { channel_id: MILL, path: 'data/pipeline.py', agent_name: 'builder', expires_at: later(18) },
    { channel_id: MILL, path: 'results/', agent_name: 'researcher', expires_at: later(6) },
    { channel_id: SITE, path: 'src/Hero.jsx', agent_name: 'reviewer', expires_at: later(11) },
  ];

  const listeners = new Set();
  const emit = (fn, ...a) => listeners.forEach((l) => l[fn]?.(...a));
  const post = (m) => { const row = add(m); emit('onMessage', row); return row; };

  const script = [
    ['builder', 'status', 'train.py refactor 80% done.', null],
    ['researcher', 'status', 'Seed 3 finished, held-out accuracy 0.78.', null],
    ['researcher', 'done', 'Seeds 3 and 4 complete. Aggregated results written.', { files: ['results/seeds_3_4.json'], next: 'builder: merge into the report' }],
    ['builder', 'status', 'Opened a PR for the pipeline refactor.', null],
  ];
  let step = 0;
  let timer = null;
  const startActivity = () => {
    if (timer) return;
    timer = setInterval(() => {
      for (const a of agents) if (a.name !== 'scout') a.last_seen = new Date().toISOString();
      emit('onChange');
      if (paused) return;
      const [who, kind, body, payload] = script[step++ % script.length];
      post({ channel_id: MILL, sender_name: who, kind, body, payload: payload || {}, created_at: new Date().toISOString() });
    }, 20000);
  };
  const stopActivity = () => { clearInterval(timer); timer = null; };

  const respond = (row) => {
    if (paused) return;
    const target = agents.find((a) => a.name === row.recipient_name);
    const who = row.kind === 'approval'
      ? (row.recipient_name || 'researcher')
      : (target ? target.name : (channels.find((c) => c.id === row.channel_id)?.name === 'portfolio-site' ? 'reviewer' : 'researcher'));
    setTimeout(() => {
      const body = row.kind === 'approval'
        ? (row.payload?.approved ? 'Approved, deleting the old checkpoints now.' : 'Denied, keeping the checkpoints.')
        : `Got your ${row.kind === 'info' ? 'note' : row.kind}: "${String(row.body).slice(0, 90)}". On it.`;
      post({ channel_id: row.channel_id, sender_name: who, kind: row.kind === 'approval' ? 'status' : 'info', body, reply_to: row.id, created_at: new Date().toISOString() });
    }, 900);
  };

  return {
    mode: 'demo',
    who: 'demo data',
    userId: 'demo',

    async loadMeta() {
      return { isOwner: true, channels: [...channels], agents: agents.map((a) => ({ ...a })), paused };
    },
    async loadChannel(cid) {
      return {
        messages: messages.filter((m) => m.channel_id === cid).slice(-200).map((m) => ({ ...m })),
        tasks: tasks.filter((t) => t.channel_id === cid).map((t) => ({ ...t })),
        claims: claims.filter((c) => c.channel_id === cid).map((c) => ({ ...c })),
      };
    },
    subscribe(l) {
      listeners.add(l);
      l.onStatus?.(true);
      startActivity();
      return () => { listeners.delete(l); if (!listeners.size) stopActivity(); };
    },
    async send(row) {
      if (paused) return { error: 'agentchat is paused by the owner' };
      const m = post({ sender_name: 'owner', from_owner: true, created_at: new Date().toISOString(), ...row });
      respond(m);
      return {};
    },
    async addTask(channel_id, title) {
      tasks = [...tasks, { id: id(), channel_id, title, status: 'open', owner_name: null, created_by: 'owner' }];
      emit('onChange');
      return {};
    },
    async setTaskStatus(task, status) {
      tasks = tasks.map((t) => (t.id === task.id ? { ...t, status, owner_name: status === 'open' ? null : t.owner_name } : t));
      emit('onChange');
      return {};
    },
    async deleteTask(task) { tasks = tasks.filter((t) => t.id !== task.id); emit('onChange'); return {}; },
    async releaseClaim(claim) {
      claims = claims.filter((c) => !(c.channel_id === claim.channel_id && c.path === claim.path));
      emit('onChange');
      return {};
    },
    async setPaused(p) { paused = p; emit('onChange'); return {}; },
    signOut: async () => {},
  };
}
