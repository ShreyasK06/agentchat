// Edge Function: ephemeral agent identities.
//   join      { invite, name, project }  -> creates agent row + membership, returns short-lived JWT
//   heartbeat { status? }  (Bearer agent token) -> extends expiry, returns fresh JWT
//   leave     (Bearer agent token) -> removes the agent immediately
// The service-role key only ever lives inside this function.
import { createClient } from "npm:@supabase/supabase-js@2";
import { jwtVerify, SignJWT } from "npm:jose@5";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const secret = new TextEncoder().encode(Deno.env.get("AGENT_JWT_SECRET")!);
// Accept either secret name for the join password (AGENT_INVITE was set in the dashboard).
const invite = Deno.env.get("AGENTCHAT_INVITE") ?? Deno.env.get("AGENT_INVITE") ?? "";
// Report missing secrets by NAME (never value) so misconfiguration is obvious instead of a TypeError.
const missingSecrets = [
  ...(invite ? [] : ["AGENTCHAT_INVITE"]),
  ...(Deno.env.get("AGENT_JWT_SECRET") ? [] : ["AGENT_JWT_SECRET"]),
];

const TOKEN_TTL_S = 15 * 60; // JWT lifetime; refreshed by heartbeat
const AGENT_TTL_S = 30 * 60; // agent row lifetime without a heartbeat
const NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function mint(id: string, name: string) {
  return await new SignJWT({ role: "authenticated", agent_id: id, name })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setAudience("authenticated")
    .setIssuer("agentchat")
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_S}s`)
    .sign(secret);
}

async function agentFromRequest(req: Request, tolerance = 0) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { payload } = await jwtVerify(token, secret, { issuer: "agentchat", clockTolerance: tolerance });
  return String(payload.agent_id);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (missingSecrets.length) return json({ error: `server misconfigured: missing secret(s) ${missingSecrets.join(", ")}` }, 500);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine for leave/heartbeat */ }

  try {
    if (body.action === "join") {
      if (!safeEqual(String(body.invite ?? ""), invite)) return json({ error: "bad invite" }, 403);
      const base = String(body.name ?? "agent").toLowerCase();
      const project = String(body.project ?? "").toLowerCase();
      if (!NAME_RE.test(base)) return json({ error: "name must match " + NAME_RE }, 400);
      if (!PROJECT_RE.test(project)) return json({ error: "project must match " + PROJECT_RE }, 400);

      let agent: { id: string; name: string } | null = null;
      for (let i = 1; i <= 20 && !agent; i++) {
        const name = i === 1 ? base : `${base}-${i}`;
        const { data, error } = await db.from("agents")
          .insert({ name, project, expires_at: new Date(Date.now() + AGENT_TTL_S * 1000).toISOString() })
          .select("id,name").single();
        if (!error) agent = data;
        else if (error.code !== "23505") throw error; // anything but "name taken"
      }
      if (!agent) return json({ error: "no free name" }, 409);

      const { data: chans, error: cerr } = await db.from("channels")
        .upsert([{ name: "global" }, { name: project }], { onConflict: "name" }).select("id,name");
      if (cerr) throw cerr;
      const { error: merr } = await db.from("channel_members")
        .insert(chans!.map((c) => ({ channel_id: c.id, agent_id: agent!.id })));
      if (merr) throw merr;
      await db.from("messages").insert(
        chans!.filter((c) => c.name === project).map((c) => ({
          channel_id: c.id, sender_name: "system", kind: "system", body: `${agent!.name} joined`,
        })),
      );
      return json({
        token: await mint(agent.id, agent.name),
        agent: { id: agent.id, name: agent.name, project },
        channels: chans,
        token_ttl_s: TOKEN_TTL_S,
      });
    }

    if (body.action === "heartbeat") {
      const id = await agentFromRequest(req);
      const patch: Record<string, unknown> = {
        last_seen: new Date().toISOString(),
        expires_at: new Date(Date.now() + AGENT_TTL_S * 1000).toISOString(),
      };
      if (typeof body.status === "string") patch.status = body.status.slice(0, 200);
      const { data, error } = await db.from("agents").update(patch).eq("id", id).select("id,name").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "agent expired" }, 401);
      return json({ token: await mint(data.id, data.name) });
    }

    if (body.action === "leave") {
      const id = await agentFromRequest(req, 3600);
      const { error } = await db.rpc("remove_agent", { aid: id, reason: "left" });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
    const auth = /JWT|jwt|signature|expired|claim/i.test(msg);
    return json({ error: msg }, auth ? 401 : 500);
  }
});
