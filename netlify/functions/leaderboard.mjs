// netlify/functions/leaderboard.mjs
// Group leaderboards. A group is just a random code — no accounts on the server.
// Members are identified by a device-generated id, de-duplicated by an email
// hash so one person on two devices is one row. Raw emails are never stored and
// never returned.

import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });

const MAX_MEMBERS = 200;          // keeps one group from growing unbounded
const NAME_MAX = 24;

const cleanId = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
const cleanName = (s) => String(s || "").replace(/[<>]/g, "").trim().slice(0, NAME_MAX);
const hashEmail = (e) =>
  createHash("sha256").update(String(e || "").trim().toLowerCase()).digest("hex").slice(0, 32);

function publicView(group) {
  // Never expose emailHash. Sort high to low.
  const members = (group.members || [])
    .map((m) => ({
      memberId: m.memberId,
      name: m.name,
      score: m.score,
      lastUpdated: m.lastUpdated
    }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  return {
    groupId: group.groupId,
    name: group.name || null,
    members,
    count: members.length,
    snapshots: group.snapshots || []
  };
}

export default async (req) => {
  let store;
  try {
    store = getStore("neurl-groups");
  } catch (e) {
    return json(500, { error: "blobs unavailable", detail: e.message || String(e) });
  }

  // ---- read a group ----
  if (req.method === "GET") {
    const url = new URL(req.url);
    const groupId = cleanId(url.searchParams.get("g"));
    if (!groupId) return json(400, { error: "missing g" });
    const group = await store.get(groupId, { type: "json" });
    if (!group) return json(404, { error: "not found" });
    return json(200, publicView(group));
  }

  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad json" });
  }

  const groupId = cleanId(body.groupId);
  const memberId = cleanId(body.memberId);
  if (!groupId || !memberId) return json(400, { error: "groupId and memberId required" });

  // ---- leave ----
  if (body.action === "leave") {
    const group = await store.get(groupId, { type: "json" });
    if (!group) return json(404, { error: "not found" });
    group.members = (group.members || []).filter((m) => m.memberId !== memberId);
    await store.setJSON(groupId, group);
    return json(200, { ok: true });
  }

  // ---- join / update score ----
  if (body.action !== "submit") return json(400, { error: "unknown action" });

  const name = cleanName(body.name);
  if (!name) return json(400, { error: "name required" });

  const score = Number(body.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return json(400, { error: "score must be 0-100" });
  }

  const emailHash = body.email ? hashEmail(body.email) : null;

  // Six-dimension breakdown, used only for team-level averages.
  const DIMS = ["Sleep", "Workload", "Movement", "Stress", "Attention", "Fuel"];
  let subscores = null;
  if (body.subscores && typeof body.subscores === "object") {
    subscores = {};
    for (const d of DIMS) {
      const v = Number(body.subscores[d]);
      if (Number.isFinite(v) && v >= 0 && v <= 100) subscores[d] = Math.round(v);
    }
    if (Object.keys(subscores).length === 0) subscores = null;
  }

  let group = await store.get(groupId, { type: "json" });
  if (!group) {
    group = {
      groupId,
      name: cleanName(body.groupName) || null,
      createdAt: new Date().toISOString(),
      members: []
    };
  }

  const now = new Date().toISOString();
  const members = group.members || [];

  // Same person on another device: match on email hash first, then member id.
  let idx = -1;
  if (emailHash) idx = members.findIndex((m) => m.emailHash && m.emailHash === emailHash);
  if (idx === -1) idx = members.findIndex((m) => m.memberId === memberId);

  if (idx >= 0) {
    members[idx] = { ...members[idx], memberId, name, score, emailHash, subscores, lastUpdated: now };
  } else {
    if (members.length >= MAX_MEMBERS) return json(409, { error: "group is full" });
    members.push({ memberId, name, score, emailHash, subscores, joinedAt: now, lastUpdated: now });
  }

  group.members = members;

  // Weekly snapshot of team averages, so trends survive even though each
  // member record only ever holds their current score.
  const MIN_FOR_AVERAGE = 5;   // below this, an average can identify someone
  const active = members.filter((m) => (Date.now() - new Date(m.lastUpdated).getTime()) / 86400000 <= 14);
  if (active.length >= MIN_FOR_AVERAGE) {
    const wk = (() => {
      const d = new Date();
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // Monday of this week
      return d.toISOString().slice(0, 10);
    })();
    const avg = (arr) => Math.round(arr.reduce((s2, v) => s2 + v, 0) / arr.length);
    const snap = { week: wk, members: active.length, score: avg(active.map((m) => m.score)) };
    const dims = {};
    for (const d of DIMS) {
      const vals = active.map((m) => m.subscores && m.subscores[d]).filter((v) => Number.isFinite(v));
      if (vals.length >= MIN_FOR_AVERAGE) dims[d] = avg(vals);
    }
    if (Object.keys(dims).length) snap.dimensions = dims;

    group.snapshots = (group.snapshots || []).filter((s3) => s3.week !== wk);
    group.snapshots.push(snap);
    group.snapshots = group.snapshots.slice(-26);   // half a year
  }
  await store.setJSON(groupId, group);
  return json(200, publicView(group));
};
