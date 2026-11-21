// netlify/functions/crews.mjs
// Netlify v2 function. Private friend crews with a weekly leaderboard.
//
// POST { action: "create", id, nick, name }            -> { code }
// POST { action: "join",   id, nick, code }            -> { ok }
// POST { action: "leave",  id, code }                  -> { ok }
// POST { action: "report", id, code, week, tests, score, imp, streak } -> { ok }
// GET  ?code=abc123&id=...                              -> crew name, members' weekly numbers, and "me"
//
// Stores only a random device ID, the nickname people choose, and weekly numbers
// (tests, NEURL Score, change, streak). Never emails, habit answers or alcohol.

import { getStore } from "@netlify/blobs";

const MAX_MEMBERS = 50;
const STALE_DAYS = 8; // numbers older than this count as zero for the current week

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });

const cleanText = (v, max) =>
  String(v || "")
    .replace(/[^\p{L}\p{N} .'&-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const okId = (id) => /^[a-z0-9]{10,32}$/.test(String(id || ""));
const okCode = (c) => /^[a-z0-9]{6}$/.test(String(c || ""));
const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : null;
};

function newCode() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

export default async (req) => {
  let store;
  try {
    store = getStore("neurl-crews");
  } catch (e) {
    return json(500, { error: "blobs unavailable" });
  }

  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code"), id = url.searchParams.get("id");
    if (!okCode(code)) return json(400, { error: "bad code" });
    const crew = await store.get("c:" + code, { type: "json" });
    if (!crew) return json(404, { error: "not found" });
    const ids = Object.keys(crew.members || {});
    const now = Date.now();
    const rows = await Promise.all(ids.map((mid) => store.get("m:" + code + ":" + mid, { type: "json" })));
    const weeks = rows.filter(Boolean).map((r) => r.week || 0);
    const curWeek = weeks.length ? Math.max(...weeks) : 0;
    const out = [];
    let me = null;
    ids.forEach((mid, i) => {
      const r = rows[i];
      const fresh = r && r.week === curWeek && now - Date.parse(r.updatedAt) < STALE_DAYS * 864e5;
      const row = {
        name: crew.members[mid].nick,
        tests: fresh ? r.tests : 0,
        score: fresh ? r.score : null,
        imp: fresh ? r.imp : null,
        streak: r && now - Date.parse(r.updatedAt) < 2 * 864e5 ? r.streak : 0
      };
      if (mid === id) me = row;
      else out.push(row);
    });
    return json(200, { code, name: crew.name, members: out, me });
  }

  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad json" });
  }
  const id = String(body.id || "");
  if (!okId(id)) return json(400, { error: "bad id" });

  if (body.action === "create") {
    const name = cleanText(body.name, 30), nick = cleanText(body.nick, 20);
    if (!name || !nick) return json(400, { error: "name and nickname required" });
    let code = newCode();
    for (let i = 0; i < 5 && (await store.get("c:" + code)); i++) code = newCode();
    await store.setJSON("c:" + code, {
      code, name, createdAt: new Date().toISOString(),
      members: { [id]: { nick, joinedAt: new Date().toISOString() } }
    });
    return json(200, { ok: true, code, name });
  }

  const code = String(body.code || "");
  if (!okCode(code)) return json(400, { error: "bad code" });
  const crew = await store.get("c:" + code, { type: "json" });
  if (!crew) return json(404, { error: "not found" });

  if (body.action === "join") {
    const nick = cleanText(body.nick, 20);
    if (!nick) return json(400, { error: "nickname required" });
    if (!crew.members[id] && Object.keys(crew.members).length >= MAX_MEMBERS) return json(409, { error: "crew full" });
    crew.members[id] = { nick, joinedAt: (crew.members[id] || {}).joinedAt || new Date().toISOString() };
    await store.setJSON("c:" + code, crew);
    return json(200, { ok: true, name: crew.name });
  }

  if (body.action === "leave") {
    delete crew.members[id];
    await store.delete("m:" + code + ":" + id);
    if (!Object.keys(crew.members).length) await store.delete("c:" + code);
    else await store.setJSON("c:" + code, crew);
    return json(200, { ok: true });
  }

  if (body.action === "report") {
    if (!crew.members[id]) return json(403, { error: "not a member" });
    await store.setJSON("m:" + code + ":" + id, {
      week: num(body.week, 0, 9e15) || 0,
      tests: num(body.tests, 0, 14) || 0,
      score: num(body.score, 0, 100),
      imp: num(body.imp, -100, 100),
      streak: num(body.streak, 0, 3650) || 0,
      updatedAt: new Date().toISOString()
    });
    return json(200, { ok: true });
  }

  return json(400, { error: "unknown action" });
};
