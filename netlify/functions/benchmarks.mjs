// netlify/functions/benchmarks.mjs
// Netlify v2 function. Anonymous age-group comparisons for reaction time.
//
// POST { action: "submit", id, age, device, median }  -> stores one record per random ID
// POST { action: "delete", id }                        -> removes that record
// GET  ?age=25-34&device=phone                         -> group size and percentiles
//
// Records hold only a random ID, an age range, a device type and a typical
// reaction time. No names, emails, scores or habit answers ever reach this store.

import { getStore } from "@netlify/blobs";

const AGES = ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"];
const DEVICES = ["phone", "tablet", "desktop"];
const MIN_GROUP = 30;          // never show a comparison drawn from fewer people
const ACTIVE_DAYS = 30;        // only recent results count
const DELETE_AFTER_DAYS = 90;  // stale records are removed
const CACHE_MS = 15 * 60 * 1000;

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });

function quantiles(sorted) {
  const q = [];
  for (let i = 0; i <= 10; i++) {
    const pos = (sorted.length - 1) * (i / 10);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    q.push(Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)));
  }
  return q;
}

async function summary(store) {
  const cached = await store.get("summary", { type: "json" });
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;

  const { blobs } = await store.list({ prefix: "u:" });
  const now = Date.now(), groups = {};
  for (const b of blobs) {
    const r = await store.get(b.key, { type: "json" });
    if (!r) continue;
    const age = now - Date.parse(r.updatedAt);
    if (age > DELETE_AFTER_DAYS * 864e5) { await store.delete(b.key); continue; }
    if (age > ACTIVE_DAYS * 864e5) continue;
    (groups[r.age + "|" + r.device] ||= []).push(r.median);
  }
  const buckets = {};
  for (const [k, v] of Object.entries(groups)) {
    v.sort((a, b) => a - b);
    buckets[k] = { n: v.length, q: quantiles(v) };
  }
  const out = { at: now, buckets };
  await store.setJSON("summary", out);
  return out;
}

export default async (req) => {
  let store;
  try {
    store = getStore("neurl-benchmarks");
  } catch (e) {
    return json(500, { error: "blobs unavailable" });
  }

  if (req.method === "GET") {
    const url = new URL(req.url);
    const age = url.searchParams.get("age"), device = url.searchParams.get("device");
    if (!AGES.includes(age) || !DEVICES.includes(device)) return json(400, { error: "bad params" });
    const s = await summary(store);
    const b = s.buckets[age + "|" + device] || { n: 0 };
    if (b.n < MIN_GROUP) return json(200, { n: b.n, min: MIN_GROUP });
    return json(200, { n: b.n, min: MIN_GROUP, median: b.q[5], q: b.q });
  }

  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad json" });
  }

  const id = String(body.id || "");
  if (!/^[a-z0-9]{10,32}$/.test(id)) return json(400, { error: "bad id" });

  if (body.action === "delete") {
    await store.delete("u:" + id);
    return json(200, { ok: true });
  }

  if (body.action === "submit") {
    const median = Number(body.median);
    if (!AGES.includes(body.age) || !DEVICES.includes(body.device)) return json(400, { error: "bad params" });
    if (!Number.isInteger(median) || median < 120 || median > 1000) return json(400, { error: "bad median" });
    await store.setJSON("u:" + id, {
      age: body.age,
      device: body.device,
      median,
      updatedAt: new Date().toISOString()
    });
    return json(200, { ok: true });
  }

  return json(400, { error: "unknown action" });
};
