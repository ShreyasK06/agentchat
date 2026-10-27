import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { configured, supabase } from './supabase.js';
import { createDemoApi, createLiveApi } from './api.js';
import { Board, Composer, Lamp, Locks, Log, Sidebar, Tray, presence, waiting } from './parts.jsx';

const REPO_URL = import.meta.env.VITE_REPO_URL || '';
const DISMISS_KEY = 'agentchat.dismissed';

const loadDismissed = () => {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); } catch { return new Set(); }
};
const saveDismissed = (set) => {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...set].slice(-500))); } catch { /* storage unavailable */ }
};

export default function Root() {
  const wantsDemo = new URLSearchParams(window.location.search).has('demo');
  const demo = wantsDemo || !configured;
  const [session, setSession] = useState(undefined); // undefined = still checking
  const demoApi = useMemo(() => (demo ? createDemoApi() : null), [demo]);

  useEffect(() => {
    if (demo || !supabase) return undefined;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [demo]);

  if (demo) return <Dashboard api={demoApi} notice={!wantsDemo} />;
  if (session === undefined) return <div className="center"><Lamp state="live" /><span className="muted">Checking session…</span></div>;
  return session ? <LiveDashboard session={session} /> : <Login />;
}

function LiveDashboard({ session }) {
  const api = useMemo(() => createLiveApi(session), [session]);
  return <Dashboard api={api} />;
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message);
    setBusy(false);
  };
  return (
    <div className="center">
      <form className="login" onSubmit={submit}>
        <div className="brand"><Lamp state="live" />agentchat</div>
        <p className="muted">Owner sign-in. Agents never see this page.</p>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn-primary wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <a className="demo-link" href="?demo">Look around with demo data</a>
      </form>
    </div>
  );
}

function Dashboard({ api, notice }) {
  const [meta, setMeta] = useState(null);
  const [channelId, setChannelId] = useState(null);
  const [data, setData] = useState({ messages: [], tasks: [], claims: [] });
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('log');
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [dismissed, setDismissed] = useState(loadDismissed);
  const [now, setNow] = useState(Date.now());
  const channelRef = useRef(null);
  channelRef.current = channelId;

  const loadMeta = useCallback(async () => {
    const m = await api.loadMeta();
    if (m.error) setError(m.error);
    setMeta(m);
    setChannelId((cur) => cur ?? m.channels.find((c) => c.name !== 'global')?.id ?? m.channels[0]?.id ?? null);
  }, [api]);

  const loadChannel = useCallback(async (id) => {
    if (!id) { setLoading(false); return; }
    const d = await api.loadChannel(id);
    if (id !== channelRef.current) return; // user switched channels mid-request
    if (d.error) setError(d.error);
    setData({ messages: d.messages, tasks: d.tasks, claims: d.claims });
    setLoading(false);
  }, [api]);

  useEffect(() => { loadMeta(); }, [loadMeta]);
  useEffect(() => { setLoading(true); setReplyTo(null); loadChannel(channelId); }, [channelId, loadChannel]);
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 20000); return () => clearInterval(i); }, []);

  useEffect(() => {
    let timer = null;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { loadMeta(); loadChannel(channelRef.current); }, 250);
    };
    const off = api.subscribe({
      onStatus: setLive,
      onChange: refresh,
      onMessage: (m) => {
        if (m.channel_id !== channelRef.current) return;
        setData((d) => (d.messages.some((x) => x.id === m.id) ? d : { ...d, messages: [...d.messages, { ...m, _enter: true }] }));
      },
    });
    return () => { clearTimeout(timer); off(); };
  }, [api, loadMeta, loadChannel]);

  const channel = meta?.channels.find((c) => c.id === channelId);
  const roster = useMemo(() => {
    if (!meta) return [];
    const list = channel && channel.name !== 'global' ? meta.agents.filter((a) => a.project === channel.name) : meta.agents;
    const rank = { live: 0, stale: 1, gone: 2 };
    return list.map((a) => ({ ...a, state: presence(a.last_seen) })).sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, channel, now]);

  const needs = useMemo(() => waiting(data.messages, dismissed), [data.messages, dismissed]);
  const boardOpen = data.tasks.filter((t) => t.status !== 'done').length;

  useEffect(() => { document.title = needs.length ? `(${needs.length}) agentchat` : 'agentchat'; }, [needs.length]);

  const run = async (p) => { const r = await p; if (r?.error) setError(r.error); return r; };
  const onSend = (row) => run(api.send(row));
  const onDecide = (m, approved) => run(api.send({
    channel_id: m.channel_id, kind: 'approval', body: approved ? 'approved' : 'denied',
    recipient_name: m.sender_name, reply_to: m.id, payload: { approved },
  }));
  const onDismiss = (m) => {
    const next = new Set(dismissed); next.add(m.id);
    setDismissed(next); saveDismissed(next);
  };
  const onPause = async () => {
    const next = !meta.paused;
    const r = await run(api.setPaused(next));
    if (!r?.error) setMeta((cur) => ({ ...cur, paused: next }));
  };
  const reloadChannel = () => loadChannel(channelRef.current);

  if (meta && !meta.isOwner) {
    return (
      <div className="center">
        <div className="login">
          <div className="brand"><Lamp state="gone" />Not an owner</div>
          <p className="muted">You are signed in, but this account is not in the <code>owners</code> table. Run this in the Supabase SQL editor, then refresh:</p>
          <pre>{`insert into owners (user_id) values ('${api.userId}');`}</pre>
          <button className="btn wide" onClick={api.signOut}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar mode={api.mode} who={api.who} channels={meta?.channels ?? []} channelId={channelId} onChannel={setChannelId}
        roster={roster} paused={Boolean(meta?.paused)} onPause={onPause} live={live} onSignOut={api.signOut} />

      <main className="main">
        {api.mode === 'demo' && (
          <div className="banner banner-demo">
            <strong>Demo mode.</strong> {notice ? 'No backend is configured, so this is sample data. ' : 'Sample data; nothing is saved. '}
            Agents here are simulated.
            {REPO_URL && <> <a href={REPO_URL} target="_blank" rel="noreferrer noopener">Source on GitHub</a></>}
          </div>
        )}
        {meta?.paused && <div className="banner banner-stop" role="status">Agents are paused. They cannot post until you resume.</div>}
        {error && <button className="banner banner-error" role="alert" onClick={() => setError('')}>{error} <span>Dismiss</span></button>}

        <header className="topbar">
          <h1><span className="hash">#</span>{channel?.name ?? 'agentchat'}</h1>
          <span className={live ? 'conn conn-live' : 'conn'} role="status"><Lamp state={live ? 'live' : 'gone'} />{live ? 'live' : 'offline'}</span>
          <nav className="tabs" role="tablist" aria-label="View">
            {[['log', 'Log', null], ['board', 'Board', boardOpen], ['locks', 'Locks', data.claims.length]].map(([k, label, n]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>
                {label}{n != null && <span className="mono count">{n}</span>}
              </button>
            ))}
          </nav>
        </header>

        {tab === 'log' && (
          <>
            <Tray items={needs} onReply={setReplyTo} onDecide={onDecide} onDismiss={onDismiss} />
            <Log messages={data.messages} channelKey={channelId} loading={loading} onReply={setReplyTo} onDecide={onDecide} />
            <Composer channel={channel} roster={roster} replyTo={replyTo} onClearReply={() => setReplyTo(null)} onSend={onSend} />
          </>
        )}
        {tab === 'board' && (
          <Board tasks={data.tasks}
            onAdd={async (title) => { const r = await run(api.addTask(channelId, title)); reloadChannel(); return r; }}
            onStatus={async (t, s) => { await run(api.setTaskStatus(t, s)); reloadChannel(); }}
            onDelete={async (t) => { await run(api.deleteTask(t)); reloadChannel(); }} />
        )}
        {tab === 'locks' && (
          <div className="scroll"><Locks claims={data.claims} onRelease={async (c) => { await run(api.releaseClaim(c)); reloadChannel(); }} /></div>
        )}
      </main>
    </div>
  );
}
