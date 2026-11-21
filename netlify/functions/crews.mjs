// netlify/functions/crews.mjs
// Netlify v2 function. Private friend teams ("Teams" in the app) with a weekly board,
// weekly titles, and a public "Top Teams" ranking that teams can opt out of.
//
// POST { action: "create", id, nick, name, public }      -> { code, name }
// POST { action: "join",   id, nick, code }               -> { name }
// POST { action: "leave",  id, code }                     -> { ok }
// POST { action: "report", id, code, week, tests, score, imp, streak, base } -> { ok }
// POST { action: "visibility", id, code, public }        -> { ok }  (team creator only)
// POST { action: "admin", pin }                           -> every team's standings (needs ADMIN_PIN)
// GET  ?code=abc123&id=...                                -> team board: this week and last week
// GET  ?top=1[&code=abc123]                               -> Top Teams this week, last week's top 3
//
// Stores only a random device ID, the nickname people choose, the team name, and weekly numbers
// (tests, average NEURL Score, change, streak, whether the 7-day baseline is done).
// Never emails, habit answers or alcohol answers.

import { getStore } from "@netlify/blobs";

const MAX_MEMBERS = 50;
const STALE_DAYS = 8;          // numbers older than this count as zero for the current week
const GOAL_PER_PERSON = 5;     // team goal: 5 tests per person per week
const TOP_CACHE_MS = 10 * 60 * 1000;
const TOP_LIMIT = 25;

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
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

function sameString(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function newCode() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

// A member's numbers for a given week (this week or last week), or null if they didn't report.
function weekRow(r, week) {
  if (!r) return null;
  if (r.week === week) return r;
  if (r.prev && r.prev.week === week) return r.prev;
  return null;
}

// Team standing for one week: how full the team bar is, and the average score of people past baseline.
function standing(crew, rows, week) {
  const ids = Object.keys(crew.members || {});
  const size = ids.length;
  const wk = ids.map((mid) => weekRow(rows[mid], week)).filter(Boolean);
  const tests = wk.reduce((a, r) => a + (r.tests || 0), 0);
  const fill = size ? Math.min(100, Math.round((tests / (size * GOAL_PER_PERSON)) * 100)) : 0;
  const scored = wk.filter((r) => r.base && r.tests >= 3 && r.score != null).map((r) => r.score);
  return { name: crew.name, size, tests, goal: size * GOAL_PER_PERSON, fill, avg: avg(scored), public: crew.public !== false };
}
const rankSort = (a, b) => b.fill - a.fill || (b.avg ?? -1) - (a.avg ?? -1) || b.size - a.size;

async function allTeams(store) {
  const { blobs } = await store.list({ prefix: "c:" });
  const teams = [];
  let curWeek = 0;
  for (const b of blobs) {
    const crew = await store.get(b.key, { type: "json" });
    if (!crew) continue;
    const rows = {};
    for (const mid of Object.keys(crew.members || {})) {
      const r = await store.get("m:" + crew.code + ":" + mid, { type: "json" });
      if (r) {
        rows[mid] = r;
        if (Date.now() - Date.parse(r.updatedAt) < STALE_DAYS * 864e5) curWeek = Math.max(curWeek, r.week || 0);
      }
    }
    teams.push({ crew, rows });
  }
  return { teams, curWeek };
}

async function topTeams(store) {
  const cached = await store.get("top:summary", { type: "json" });
  if (cached && Date.now() - cached.at < TOP_CACHE_MS) return cached;
  const { teams, curWeek } = await allTeams(store);
  const lastWeek = curWeek - 7;
  const eligible = teams.filter((t) => t.crew.public !== false && Object.keys(t.crew.members || {}).length >= 2);
  const last = eligible
    .map((t) => ({ code: t.crew.code, ...standing(t.crew, t.rows, lastWeek) }))
    .filter((s) => s.tests > 0)
    .sort(rankSort)
    .slice(0, 3);
  const crowns = Object.fromEntries(last.map((s, i) => [s.code, i + 1]));
  const now = eligible
    .map((t) => ({ code: t.crew.code, ...standing(t.crew, t.rows, curWeek), crown: crowns[t.crew.code] || null }))
    .filter((s) => s.tests > 0)
    .sort(rankSort);
  const out = {
    at: Date.now(),
    week: curWeek,
    count: now.length,
    // codes stay on the server: they're the join key. The client is told only which row is its own.
    teams: now.slice(0, TOP_LIMIT),
    last: last.map((s) => ({ name: s.name, fill: s.fill, avg: s.avg, code: s.code }))
  };
  await store.setJSON("top:summary", out);
  return out;
}
const strip = ({ code, ...rest }) => rest;

export default async (req) => {
  let store;
  try {
    store = getStore("neurl-crews");
  } catch (e) {
    return json(500, { error: "blobs unavailable" });
  }

  if (req.method === "GET") {
    const url = new URL(req.url);

    if (url.searchParams.get("top")) {
      const t = await topTeams(store);
      const mine = url.searchParams.get("code");
      const meI = okCode(mine) ? t.teams.findIndex((s) => s.code === mine) : -1;
      return json(200, {
        week: t.week,
        count: t.count,
        teams: t.teams.map(strip),
        mine: meI,
        last: t.last.map(strip)
      });
    }

    const code = url.searchParams.get("code"), id = url.searchParams.get("id");
    if (!okCode(code)) return json(400, { error: "bad code" });
    const crew = await store.get("c:" + code, { type: "json" });
    if (!crew) return json(404, { error: "not found" });
    const ids = Object.keys(crew.members || {});
    const now = Date.now();
    const rows = await Promise.all(ids.map((mid) => store.get("m:" + code + ":" + mid, { type: "json" })));
    const weeks = rows.filter((r) => r && now - Date.parse(r.updatedAt) < STALE_DAYS * 864e5).map((r) => r.week || 0);
    const curWeek = weeks.length ? Math.max(...weeks) : 0;
    const out = [];
    let me = null;
    ids.forEach((mid, i) => {
      const r = rows[i], cur = weekRow(r, curWeek), prev = weekRow(r, curWeek - 7);
      const row = {
        name: crew.members[mid].nick,
        tests: cur ? cur.tests : 0,
        score: cur ? cur.score : null,
        imp: cur ? cur.imp : null,
        streak: r && now - Date.parse(r.updatedAt) < 2 * 864e5 ? r.streak : 0,
        base: !!(r && r.base),
        prev: prev ? { tests: prev.tests, score: prev.score, imp: prev.imp, base: !!prev.base } : null
      };
      if (mid === id) me = row;
      else out.push(row);
    });
    let crown = null;
    try {
      const t = await store.get("top:summary", { type: "json" });
      if (t) { const i = (t.last || []).findIndex((s) => s.code === code); crown = i >= 0 ? i + 1 : null; }
    } catch {}
    return json(200, {
      code, name: crew.name, public: crew.public !== false, owner: crew.owner === id,
      week: curWeek, members: out, me, crown
    });
  }

  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad json" });
  }

  if (body.action === "admin") {
    const pin = process.env.ADMIN_PIN;
    if (!pin) return json(500, { error: "ADMIN_PIN not configured" });
    if (!sameString(String(body.pin || ""), String(pin))) {
      await new Promise((r) => setTimeout(r, 1500));
      return json(401, { error: "bad pin" });
    }
    const { teams, curWeek } = await allTeams(store);
    const list = teams.map((t) => ({
      ...standing(t.crew, t.rows, curWeek),
      lastWeek: standing(t.crew, t.rows, curWeek - 7),
      createdAt: t.crew.createdAt,
      members: Object.values(t.crew.members || {}).map((m) => m.nick)
    })).sort(rankSort);
    return json(200, { week: curWeek, teams: list });
  }

  const id = String(body.id || "");
  if (!okId(id)) return json(400, { error: "bad id" });

  if (body.action === "create") {
    const name = cleanText(body.name, 30), nick = cleanText(body.nick, 20);
    if (!name || !nick) return json(400, { error: "name and nickname required" });
    let code = newCode();
    for (let i = 0; i < 5 && (await store.get("c:" + code)); i++) code = newCode();
    await store.setJSON("c:" + code, {
      code, name, owner: id, public: body.public !== false, createdAt: new Date().toISOString(),
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
    if (!crew.members[id] && Object.keys(crew.members).length >= MAX_MEMBERS) return json(409, { error: "team full" });
    crew.members[id] = { nick, joinedAt: (crew.members[id] || {}).joinedAt || new Date().toISOString() };
    await store.setJSON("c:" + code, crew);
    return json(200, { ok: true, name: crew.name });
  }

  if (body.action === "leave") {
    delete crew.members[id];
    await store.delete("m:" + code + ":" + id);
    if (!Object.keys(crew.members).length) await store.delete("c:" + code);
    else {
      if (crew.owner === id) crew.owner = Object.keys(crew.members)[0];
      await store.setJSON("c:" + code, crew);
    }
    return json(200, { ok: true });
  }

  if (body.action === "visibility") {
    if (crew.owner !== id) return json(403, { error: "only the team creator can change this" });
    crew.public = body.public !== false;
    await store.setJSON("c:" + code, crew);
    await store.delete("top:summary");
    return json(200, { ok: true, public: crew.public });
  }

  if (body.action === "report") {
    if (!crew.members[id]) return json(403, { error: "not a member" });
    const key = "m:" + code + ":" + id;
    const old = await store.get(key, { type: "json" });
    const week = num(body.week, 0, 9e15) || 0;
    let prev = old && old.prev ? old.prev : null;
    if (old && old.week !== week) {
      // a new week: keep the old week's numbers as "last week" if it was the week right before
      prev = old.week === week - 7 ? { week: old.week, tests: old.tests, score: old.score, imp: old.imp, base: !!old.base } : null;
    }
    await store.setJSON(key, {
      week,
      tests: num(body.tests, 0, 14) || 0,
      score: num(body.score, 0, 100),
      imp: num(body.imp, -100, 100),
      streak: num(body.streak, 0, 3650) || 0,
      base: body.base === true,
      prev,
      updatedAt: new Date().toISOString()
    });
    return json(200, { ok: true });
  }

  return json(400, { error: "unknown action" });
};
