// Kitchen Circuit "dupr" Edge Function.
// The scorekeeper's DUPR tab calls this to send finished matches to DUPR.
// Paste this whole file into Supabase > Edge Functions > dupr, then set these Edge Function secrets:
//   DUPR_CLIENT_KEY, DUPR_CLIENT_SECRET   (from DUPR partner onboarding)
//   DUPR_ENV = uat  (test)  or  prod  (live)   -- defaults to uat
// Optional: DUPR_BASE (override the API address), DUPR_VERSION (defaults to v1.0)
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://yhtlwmkktayzttwrcaqv.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_Hcm_PozoiTG1ZLhwC4F49A_MXdBKgfZ";

const ENV = (Deno.env.get("DUPR_ENV") ?? "uat").toLowerCase() === "prod" ? "prod" : "uat";
const BASE = (Deno.env.get("DUPR_BASE") ?? (ENV === "prod" ? "https://prod.mydupr.com/api" : "https://uat.mydupr.com/api")).replace(/\/+$/, "");
const VERSION = Deno.env.get("DUPR_VERSION") ?? "v1.0";
const CLIENT_KEY = Deno.env.get("DUPR_CLIENT_KEY") ?? "";
const CLIENT_SECRET = Deno.env.get("DUPR_CLIENT_SECRET") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function reply(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

/* ---------- DUPR access token (valid 1 hour; cached while this function instance is warm) ---------- */
let TOKEN = "", TOKEN_UNTIL = 0;
async function token(force = false): Promise<string> {
  if (!force && TOKEN && Date.now() < TOKEN_UNTIL) return TOKEN;
  if (!CLIENT_KEY || !CLIENT_SECRET) throw new Error("DUPR_CLIENT_KEY and DUPR_CLIENT_SECRET are not set in Edge Function secrets");
  const res = await fetch(`${BASE}/auth/${VERSION}/token`, {
    method: "POST",
    headers: { "x-authorization": btoa(`${CLIENT_KEY}:${CLIENT_SECRET}`), "Content-Type": "application/json", "Accept": "application/json" },
  });
  const body = await readBody(res);
  const t = body?.result?.token ?? body?.token ?? body?.result?.accessToken ?? "";
  if (!res.ok || !t) throw new Error(`DUPR sign-in failed (HTTP ${res.status}): ${short(body)}`);
  TOKEN = t;
  TOKEN_UNTIL = Date.now() + 50 * 60 * 1000; // refresh a little before DUPR's 1-hour expiry
  return TOKEN;
}

async function readBody(res: Response) {
  const txt = await res.text();
  try { return JSON.parse(txt); } catch (_) { return { raw: txt.slice(0, 2000) }; }
}
function short(b: unknown) { const s = typeof b === "string" ? b : JSON.stringify(b); return (s ?? "").slice(0, 500); }

/* One DUPR call, retried once with a fresh token if DUPR says the token is no good. */
async function dupr(method: string, path: string, body?: unknown) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${BASE}/${path.replace(/^\/+/, "")}`, {
      method,
      headers: { "Authorization": `Bearer ${await token(attempt > 0)}`, "Content-Type": "application/json", "Accept": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await readBody(res);
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    const ok = res.ok && String(data?.status ?? "SUCCESS").toUpperCase() !== "FAILURE";
    return { ok, http: res.status, data };
  }
  return { ok: false, http: 401, data: { message: "DUPR refused the access token" } };
}
function why(r: { http: number; data: any }) {
  const d = r.data ?? {};
  return d.message || d.error || d.errors?.[0]?.message || d.result?.message || `HTTP ${r.http}: ${short(d)}`;
}

/* ---------- request handler ---------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  // act as the signed-in scorekeeper, so the database's own rules apply
  const sb = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ed = await sb.rpc("is_editor");
  if (ed.error || ed.data !== true) return reply({ error: "Only a signed-in scorekeeper can send matches to DUPR." }, 403);

  let input: any;
  try { input = await req.json(); } catch (_) { return reply({ error: "bad request" }, 400); }
  const action = String(input?.action ?? "");

  try {
    if (action === "ping") {
      await token(true);
      return reply({ ok: true, env: ENV, base: BASE });
    }

    if (action === "upload" || action === "update") {
      const list: any[] = Array.isArray(input.matches) ? input.matches.slice(0, 100) : [];
      const out: any[] = [];
      for (const m of list) {
        const id = String(m?.identifier ?? "");
        if (!id || !m?.teamA || !m?.teamB) { out.push({ identifier: id, ok: false, error: "missing match details" }); continue; }
        const prev = await sb.from("dupr_matches").select("match_code,env").eq("identifier", id).maybeSingle();
        const code = prev.data?.match_code ?? "";
        let r;
        if (code && prev.data?.env === ENV) {
          if (action !== "update") { out.push({ identifier: id, ok: true, skipped: true, matchCode: code }); continue; }
          r = await dupr("POST", `match/${VERSION}/update`, { ...m, matchId: Number(code) });
        } else {
          r = await dupr("POST", `match/${VERSION}/create`, m);
        }
        const res = r.data?.result ?? {};
        const newCode = String(res.matchCode ?? res.matchId ?? code ?? "");
        const row = {
          identifier: id, env: ENV,
          match_code: r.ok ? newCode : (code || null),
          hashed_code: r.ok ? (res.hashedMatchCode ?? null) : null,
          payload: m, status: r.ok ? "uploaded" : "error",
          error: r.ok ? null : why(r), response: r.data, updated_at: new Date().toISOString(),
        };
        // a failed update keeps the match marked uploaded (it is still on DUPR with the old score)
        if (!r.ok && code) { row.status = "uploaded"; row.payload = undefined as any; }
        const w = await sb.from("dupr_matches").upsert(Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));
        out.push({ identifier: id, ok: r.ok, matchCode: row.match_code, error: row.error ?? (w.error ? "saved to DUPR but not recorded: " + w.error.message : null) });
      }
      return reply({ ok: true, env: ENV, results: out });
    }

    if (action === "delete") {
      const id = String(input.identifier ?? "");
      const prev = await sb.from("dupr_matches").select("match_code").eq("identifier", id).maybeSingle();
      const code = prev.data?.match_code;
      if (code) {
        const r = await dupr("DELETE", `match/${VERSION}/delete`, { matchCode: String(code), identifier: id });
        if (!r.ok) return reply({ ok: false, error: why(r) });
      }
      await sb.from("dupr_matches").delete().eq("identifier", id);
      return reply({ ok: true });
    }

    return reply({ error: "unknown action" }, 400);
  } catch (e) {
    return reply({ ok: false, error: (e as Error).message ?? String(e) }, 502);
  }
});
