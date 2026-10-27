import React, { useEffect, useMemo, useRef, useState } from 'react';

// ---------- vocabulary ----------
export const KIND = {
  status: { label: 'status', tone: 'dim' },
  info: { label: 'note', tone: 'dim' },
  done: { label: 'done', tone: 'go' },
  question: { label: 'question', tone: 'amber' },
  blocker: { label: 'blocker', tone: 'stop' },
  approval_request: { label: 'approval', tone: 'amber' },
  approval: { label: 'decision', tone: 'amber' },
  command: { label: 'command', tone: 'amber' },
  system: { label: 'system', tone: 'dim' },
};

export const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

export const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

export const timeLeft = (iso) => {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
};

// Agents heartbeat every ~4 min: live < 5.5 min, stale < 30 min, else gone.
export const presence = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  return s < 330 ? 'live' : s < 1800 ? 'stale' : 'gone';
};

// Agent-supplied URLs are untrusted: only ever render http(s) links.
export const safeUrl = (u) => {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : null;
  } catch { return null; }
};

// What is waiting on the owner: unanswered approvals, blockers, questions, and anything flagged needs_reply.
export function waiting(messages, dismissed) {
  const answered = new Set(messages.filter((m) => m.from_owner && m.reply_to).map((m) => m.reply_to));
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return messages.filter((m) =>
    !m.from_owner && m.kind !== 'system' && m.kind !== 'approval'
    && (!m.recipient_name || m.recipient_name === 'owner')
    && new Date(m.created_at).getTime() > cutoff
    && (['approval_request', 'blocker', 'question'].includes(m.kind) || m.needs_reply)
    && !answered.has(m.id) && !dismissed.has(m.id));
}

// ---------- atoms ----------
export function Lamp({ state = 'gone' }) {
  return <span className={`lamp lamp-${state}`} aria-hidden="true" />;
}

export function Tag({ kind }) {
  const k = KIND[kind] || KIND.info;
  return <span className={`tag tone-${k.tone}`}>{k.label}</span>;
}

function Empty({ title, hint }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  );
}

// ---------- sidebar ----------
export function Sidebar({ mode, who, channels, channelId, onChannel, roster, paused, onPause, live, onSignOut }) {
  const [open, setOpen] = useState(false);
  const liveCount = roster.filter((a) => a.state === 'live').length;
  return (
    <aside className={open ? 'sidebar open' : 'sidebar'}>
      <div className="brand-row">
        <span className="brand"><Lamp state={live ? 'live' : 'gone'} />agentchat</span>
        <select className="mobile-only" aria-label="Channel" value={channelId ?? ''} onChange={(e) => onChannel(e.target.value)}>
          {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select>
        <button className="btn mobile-only" aria-expanded={open} onClick={() => setOpen(!open)}>
          Agents <span className="mono">{liveCount}</span>
        </button>
      </div>

      <div className="sidebar-body">
        <nav className="section channels" aria-label="Channels">
          <h2>Channels</h2>
          <ul>
            {channels.map((c) => (
              <li key={c.id}>
                <button className={c.id === channelId ? 'nav active' : 'nav'} aria-current={c.id === channelId ? 'true' : undefined} onClick={() => onChannel(c.id)}>
                  <span className="hash">#</span>{c.name}
                </button>
              </li>
            ))}
            {!channels.length && <li className="muted pad">A channel appears when the first session joins a project.</li>}
          </ul>
        </nav>

        <section className="section" aria-label="Agents on shift">
          <h2>On shift <span className="mono count">{liveCount}/{roster.length}</span></h2>
          <ul>
            {roster.map((a) => (
              <li key={a.id} className="agent">
                <Lamp state={a.state} />
                <div className="agent-main">
                  <span className="agent-name">{a.name}</span>
                  <span className="agent-status">{a.status || a.project}</span>
                </div>
                <span className="agent-seen mono" title={`last heartbeat ${ago(a.last_seen)} ago`}>{ago(a.last_seen)}</span>
              </li>
            ))}
            {!roster.length && <li className="muted pad">Nobody on this channel.</li>}
          </ul>
        </section>

        <div className="sidebar-foot">
          <button className={paused ? 'btn btn-danger wide' : 'btn wide'} aria-pressed={paused} onClick={onPause}
            title="Pausing blocks every agent from posting until you resume">
            {paused ? 'Agents paused · resume' : 'Pause all agents'}
          </button>
          <div className="whoami">
            <span className="muted">{mode === 'demo' ? 'Demo data' : who}</span>
            {mode !== 'demo' && <button className="btn btn-quiet" onClick={onSignOut}>Sign out</button>}
          </div>
        </div>
      </div>
    </aside>
  );
}

// ---------- "Needs you" tray (the focal point of the log view) ----------
export function Tray({ items, onReply, onDecide, onDismiss }) {
  if (!items.length) {
    return <div className="tray tray-empty"><Lamp state="live" />Nothing is waiting on you.</div>;
  }
  return (
    <section className="tray" aria-label="Needs you">
      <header>
        <Lamp state="amber" />
        <h2>Needs you</h2>
        <span className="mono count">{items.length}</span>
      </header>
      <ul>
        {items.map((m) => (
          <li key={m.id}>
            <div className="tray-main">
              <span className="tray-who">{m.sender_name}</span>
              <Tag kind={m.kind} />
              <span className="tray-body">{m.body}</span>
            </div>
            <div className="tray-actions">
              {m.kind === 'approval_request' && (
                <>
                  <button className="btn btn-primary" onClick={() => onDecide(m, true)}>Approve</button>
                  <button className="btn btn-danger" onClick={() => onDecide(m, false)}>Deny</button>
                </>
              )}
              <button className="btn" onClick={() => onReply(m)}>Reply</button>
              <button className="btn btn-quiet" onClick={() => onDismiss(m)} aria-label={`Dismiss ${m.sender_name}'s ${KIND[m.kind]?.label ?? 'message'}`}>Dismiss</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- log ----------
function Row({ m, answered, onReply, onDecide }) {
  if (m.kind === 'system') {
    return (
      <div className={m._enter ? 'sysline enter' : 'sysline'}>
        <time className="mono" dateTime={m.created_at}>{clock(m.created_at)}</time>
        <span>{m.body}</span>
      </div>
    );
  }
  const mine = m.from_owner;
  const payload = m.payload && typeof m.payload === 'object' ? m.payload : {};
  const files = Array.isArray(payload.files) ? payload.files : [];
  const link = payload.artifact_url ? safeUrl(payload.artifact_url) : null;
  const hasFacts = files.length > 0 || payload.next || link;
  return (
    <article className={`row k-${m.kind}${mine ? ' mine' : ''}${m.needs_reply && !answered ? ' needs' : ''}${m._enter ? ' enter' : ''}`}>
      <time className="t mono" dateTime={m.created_at}>{clock(m.created_at)}</time>
      <div className="who" title={m.sender_name}>{mine ? 'you' : m.sender_name}</div>
      <div className="what">
        <div className="meta">
          <Tag kind={m.kind} />
          {m.recipient_name && <span className="chip chip-dm">to {m.recipient_name}</span>}
          {m.needs_reply && !answered && <span className="chip chip-amber">needs reply</span>}
          {m.kind === 'approval_request' && answered && <span className="chip">decided</span>}
          {m.hop_count > 0 && <span className="hop mono">hop {m.hop_count}</span>}
        </div>
        <p className="body">{m.body}</p>
        {hasFacts && (
          <dl className="facts">
            {files.length > 0 && (<><dt>files</dt><dd>{files.map((f) => <code key={f}>{String(f)}</code>)}</dd></>)}
            {payload.next && (<><dt>next</dt><dd>{String(payload.next)}</dd></>)}
            {link && (<><dt>link</dt><dd><a href={link} target="_blank" rel="noreferrer noopener">{link}</a></dd></>)}
          </dl>
        )}
        {!mine && (m.kind === 'approval_request' && !answered ? (
          <div className="row-actions">
            <button className="btn btn-primary" onClick={() => onDecide(m, true)}>Approve</button>
            <button className="btn btn-danger" onClick={() => onDecide(m, false)}>Deny</button>
            <button className="btn btn-quiet" onClick={() => onReply(m)}>Reply</button>
          </div>
        ) : (
          <div className="row-actions reveal"><button className="btn btn-quiet" onClick={() => onReply(m)}>Reply</button></div>
        ))}
      </div>
    </article>
  );
}

export function Log({ messages, channelKey, loading, onReply, onDecide }) {
  const ref = useRef(null);
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const answered = useMemo(() => new Set(messages.filter((m) => m.from_owner && m.reply_to).map((m) => m.reply_to)), [messages]);

  useEffect(() => { stick.current = true; setUnseen(0); }, [channelKey]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stick.current) { el.scrollTop = el.scrollHeight; setUnseen(0); } else { setUnseen((n) => n + 1); }
  }, [messages.length]);

  const onScroll = () => {
    const el = ref.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (stick.current) setUnseen(0);
  };
  const jump = () => { const el = ref.current; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); };

  return (
    <div className="log-wrap">
      <div className="log" ref={ref} onScroll={onScroll} role="log" aria-live="polite" aria-label="Channel log">
        {loading && <Empty title="Loading the log…" />}
        {!loading && !messages.length && <Empty title="No messages yet." hint="When a session posts here it shows up instantly." />}
        {messages.map((m) => <Row key={m.id} m={m} answered={answered.has(m.id)} onReply={onReply} onDecide={onDecide} />)}
      </div>
      {unseen > 0 && <button className="btn jump" onClick={jump}>{unseen} new ↓</button>}
    </div>
  );
}

// ---------- composer ----------
const OWNER_KINDS = [['info', 'Note'], ['question', 'Question'], ['command', 'Command']];
const SEND_HINT = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘↵' : 'Ctrl ↵';

export function Composer({ channel, roster, replyTo, onClearReply, onSend }) {
  const [body, setBody] = useState('');
  const [kind, setKind] = useState('info');
  const [to, setTo] = useState('');
  const [needsReply, setNeedsReply] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (replyTo) { setTo(replyTo.sender_name); box.current?.focus(); }
  }, [replyTo]);
  useEffect(() => { setTo(''); }, [channel?.id]);

  const submit = async (e) => {
    e?.preventDefault();
    const text = body.trim();
    if (!text || !channel) return;
    const res = await onSend({
      channel_id: channel.id, kind, body: text, recipient_name: to || null,
      needs_reply: needsReply, reply_to: replyTo?.id ?? null,
    });
    if (!res?.error) { setBody(''); setNeedsReply(false); onClearReply(); }
  };

  return (
    <form className="composer" onSubmit={submit}>
      {replyTo && (
        <div className="replying">
          <span>Replying to <strong>{replyTo.sender_name}</strong>: <em>{String(replyTo.body).slice(0, 80)}</em></span>
          <button type="button" className="btn btn-quiet" onClick={onClearReply}>Cancel</button>
        </div>
      )}
      <div className="composer-row">
        <select aria-label="Recipient" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Everyone in #{channel?.name ?? '…'}</option>
          {roster.map((a) => <option key={a.id} value={a.name}>Only {a.name}</option>)}
        </select>
        <select aria-label="Message type" value={kind} onChange={(e) => setKind(e.target.value)}>
          {OWNER_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={needsReply} onChange={(e) => setNeedsReply(e.target.checked)} />Needs reply</label>
      </div>
      <div className="composer-row">
        <textarea ref={box} aria-label="Message" value={body} rows={2} placeholder={channel ? `Message #${channel.name} as you` : 'Pick a channel'}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e); }} />
        <button className="btn btn-primary send" disabled={!body.trim() || !channel}>Send<span className="hint mono">{SEND_HINT}</span></button>
      </div>
    </form>
  );
}

// ---------- board ----------
const LANES = [['open', 'Open'], ['claimed', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];

export function Board({ tasks, onAdd, onStatus, onDelete }) {
  const [title, setTitle] = useState('');
  const add = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    const res = await onAdd(title.trim());
    if (!res?.error) setTitle('');
  };
  return (
    <div className="board-wrap">
      <form className="addtask" onSubmit={add}>
        <input aria-label="New task" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task any agent can claim…" maxLength={300} />
        <button className="btn btn-primary" disabled={!title.trim()}>Add task</button>
      </form>
      <div className="lanes">
        {LANES.map(([s, label]) => {
          const list = tasks.filter((t) => t.status === s);
          return (
            <section key={s} className={`lane lane-${s}`} aria-label={label}>
              <h3>{label}<span className="mono count">{list.length}</span></h3>
              {list.map((t) => (
                <div className="task" key={t.id}>
                  <p className="task-title">{t.title}</p>
                  <p className="task-meta mono">{t.owner_name ? `@${t.owner_name}` : 'unclaimed'} · by {t.created_by}</p>
                  {t.result?.next && <p className="task-next">next: {t.result.next}</p>}
                  <div className="task-actions">
                    <select aria-label={`Status of ${t.title}`} value={t.status} onChange={(e) => onStatus(t, e.target.value)}>
                      {LANES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <button className="btn btn-quiet" onClick={() => onDelete(t)} aria-label={`Delete ${t.title}`}>Delete</button>
                  </div>
                </div>
              ))}
              {!list.length && <p className="lane-empty">Nothing here</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ---------- locks ----------
export function Locks({ claims, onRelease }) {
  if (!claims.length) {
    return <Empty title="No files are locked." hint="Agents reserve a file before editing so two sessions never collide." />;
  }
  return (
    <ul className="locks">
      {claims.map((c) => (
        <li key={`${c.channel_id}:${c.path}`}>
          <code className="lock-path">{c.path}</code>
          <span className="lock-holder">held by <strong>{c.agent_name}</strong></span>
          <span className="lock-time mono">frees in {timeLeft(c.expires_at)}</span>
          <button className="btn btn-quiet" onClick={() => onRelease(c)}>Force release</button>
        </li>
      ))}
    </ul>
  );
}
