// Shared helpers for the MCP server and the watcher.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

export const HOME = process.env.AGENTCHAT_HOME || path.join(os.homedir(), '.agentchat');
export const STATE_DIR = path.join(HOME, 'state');

// Kinds that should wake a session. Everything else is read on demand via `inbox`.
export const WAKE_KINDS = new Set(['done', 'question', 'blocker', 'approval_request']);
export const AGENT_KINDS = ['status', 'done', 'question', 'blocker', 'info', 'approval_request'];

// Config comes from the environment, falling back to ~/.agentchat/.env (never committed).
export function loadConfig() {
  const file = path.join(HOME, '.env');
  const fromFile = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) fromFile[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  const get = (k) => process.env[k] || fromFile[k] || '';
  const cfg = {
    url: get('SUPABASE_URL').replace(/\/$/, ''),
    anonKey: get('SUPABASE_ANON_KEY'),
    invite: get('AGENTCHAT_INVITE'),
  };
  cfg.missing = Object.entries({
    SUPABASE_URL: cfg.url, SUPABASE_ANON_KEY: cfg.anonKey, AGENTCHAT_INVITE: cfg.invite,
  }).filter(([, v]) => !v).map(([k]) => k);
  return cfg;
}

// Project = AGENTCHAT_PROJECT, else a `.agentchat` file in the cwd, else the folder name.
export function sanitize(s, fallback) {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return out || fallback;
}

export function resolveProject(cwd = process.cwd()) {
  if (process.env.AGENTCHAT_PROJECT) return sanitize(process.env.AGENTCHAT_PROJECT, 'scratch');
  try {
    const f = path.join(cwd, '.agentchat');
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf8').trim();
      try { const j = JSON.parse(raw); if (j.project) return sanitize(j.project, 'scratch'); } catch { return sanitize(raw, 'scratch'); }
    }
  } catch { /* fall through */ }
  return sanitize(path.basename(cwd), 'scratch');
}

export function resolveName() {
  return sanitize(process.env.AGENTCHAT_NAME || 'agent', 'agent');
}

export async function callFn(cfg, action, body = {}, token) {
  const res = await fetch(`${cfg.url}/functions/v1/agent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: cfg.anonKey,
      authorization: `Bearer ${token || cfg.anonKey}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-json */ }
  if (!res.ok) throw new Error(`agent.${action} failed (${res.status}): ${data.error || res.statusText}`);
  return data;
}

// `accessToken` makes REST calls use the agent JWT. Realtime additionally needs `await client.realtime.setAuth(token)`
// before subscribing (see watcher.mjs); otherwise it joins as anon and RLS rejects every event with a 401.
export function clientFor(cfg, token) {
  return createClient(cfg.url, cfg.anonKey, { accessToken: async () => token });
}

export function stateFile(name) {
  return path.join(STATE_DIR, `${name}.json`);
}

export function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = stateFile(state.agent.name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

export function readState(fileOrName) {
  const file = fileOrName.endsWith('.json') ? fileOrName : stateFile(fileOrName);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Chat text is written by other agents; wrap it so the model treats it as data, not orders.
export function formatMessage(m, channelName) {
  const flags = [
    m.from_owner ? 'OWNER' : null,
    m.recipient_name ? `DM->${m.recipient_name}` : null,
    m.needs_reply ? 'needs_reply' : null,
    m.task_id ? `task:${String(m.task_id).slice(0, 8)}` : null,
  ].filter(Boolean).join(',');
  const payload = m.payload && Object.keys(m.payload).length ? ` payload=${JSON.stringify(m.payload)}` : '';
  return `[#${channelName || m.channel_id}] ${m.sender_name} (${m.kind}${flags ? ', ' + flags : ''}) id:${String(m.id).slice(0, 8)}: ${oneLine(m.body, 600)}${payload}`;
}

export function oneLine(s, max = 300) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Decide whether a realtime message should wake this session.
export function shouldWake(m, me) {
  if (!m || m.sender_id === me.id) return false;
  if (m.kind === 'system') return false;
  if (m.from_owner) return true;
  if (m.recipient_name && m.recipient_name.toLowerCase() === me.name.toLowerCase()) return true;
  if (WAKE_KINDS.has(m.kind)) return true;
  if (m.needs_reply) return true;
  return new RegExp(`(^|\\s)@${me.name}\\b`, 'i').test(m.body || '');
}
