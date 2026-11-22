// Kitchen Circuit "notify" Edge Function.
// The scorekeeper's screen calls this when a match is called; it sends a lock-screen notification
// to every phone following either team. Paste this whole file into Supabase > Edge Functions > notify.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://yhtlwmkktayzttwrcaqv.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_Hcm_PozoiTG1ZLhwC4F49A_MXdBKgfZ";
const VAPID = {
  publicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? "",
  privateKey: Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
  subject: Deno.env.get("VAPID_SUBJECT") ?? "mailto:thekitchencircuit@gmail.com",
};
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function reply(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

/* Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) using only WebCrypto, so it runs in Supabase Edge Functions (Deno) and Node. */
const te = new TextEncoder();
function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(b) {
  let s = "";
  const u = new Uint8Array(b);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/* Encrypt a payload for one subscription ({endpoint, keys:{p256dh, auth}}). Returns the request body bytes. */
async function encryptPayload(sub, payload, opts) {
  opts = opts || {};
  const uaPublic = b64uToBytes(sub.keys.p256dh), authSecret = b64uToBytes(sub.keys.auth);
  const asKeys = opts.asKeys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const keyInfo = concat(te.encode("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te.encode("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te.encode("Content-Encoding: nonce"), new Uint8Array([0, 1])))).slice(0, 12);
  const plain = concat(typeof payload === "string" ? te.encode(payload) : payload, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); /* record size 4096 */
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/* Signed VAPID header for the push service that owns this endpoint. */
async function vapidAuth(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const pub = b64uToBytes(vapid.publicKey);
  const jwk = { kty: "EC", crv: "P-256", x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), d: vapid.privateKey, ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = bytesToB64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(head + "." + claims)));
  return "vapid t=" + head + "." + claims + "." + bytesToB64u(sig) + ", k=" + vapid.publicKey;
}

/* Send one notification. Returns the HTTP status (201 = delivered to the push service; 404/410 = subscription gone). */
async function sendPush(sub, payload, vapid, fetchImpl) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const res = await (fetchImpl || fetch)(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "900",
      "Urgency": "high",
      "Authorization": await vapidAuth(sub.endpoint, vapid),
    },
    body,
  });
  return res.status;
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);
  if (!VAPID.publicKey || !VAPID.privateKey) return reply({ error: "VAPID keys are not set in Edge Function secrets" }, 500);
  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let calls = [];
  try { calls = (await req.json()).calls ?? []; } catch (_) { return reply({ error: "bad request" }, 400); }
  let sent = 0, failed = 0, removed = 0, skipped = 0;
  for (const c of calls.slice(0, 40)) {
    // push_targets checks the caller is a scorekeeper, skips teams already notified in the last 10 minutes,
    // and returns the phones following the rest.
    const { data, error } = await sb.rpc("push_targets", { p_match: String(c.id), p_teams: [c.a, c.b].filter(Boolean) });
    if (error) return reply({ error: error.message }, 403);
    if (!data || !data.length) { skipped++; continue; }
    for (const r of data) {
      const opp = r.o_team === c.a ? c.bn : c.an;
      const payload = {
        title: "You're up! Court " + c.court,
        body: "Come to the scorekeeper table now. vs " + (opp || "your opponent"),
        tag: "kc-call",
        url: "/",
      };
      try {
        const st = await sendPush(r.o_sub, payload, VAPID);
        if (st === 404 || st === 410) { await sb.rpc("drop_push", { p_endpoint: r.o_endpoint }); removed++; }
        else if (st >= 200 && st < 300) sent++;
        else failed++;
      } catch (_) { failed++; }
    }
  }
  return reply({ sent, failed, removed, skipped });
});
