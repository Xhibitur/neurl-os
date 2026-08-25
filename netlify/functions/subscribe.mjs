// netlify/functions/subscribe.mjs
// Netlify v2 function. Stores push subscriptions so the scheduled sender
// knows who to notify. Uses Netlify Blobs — no database required.

import { getStore } from "@netlify/blobs";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });

function keyFor(subscription) {
  const raw = subscription && subscription.endpoint ? subscription.endpoint : "";
  if (!raw) return "";
  return Buffer.from(raw).toString("base64url").slice(0, 120);
}

const today = () => new Date().toISOString().slice(0, 10);

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad json" });
  }

  let store;
  try {
    store = getStore("neurl-subs");
  } catch (e) {
    return json(500, { error: "blobs unavailable", detail: e.message || String(e) });
  }

  const key = keyFor(body.subscription);
  if (!key) return json(400, { error: "missing subscription" });

  if (body.action === "subscribe") {
    await store.setJSON(key, {
      subscription: body.subscription,
      mode: body.mode === "daily" ? "daily" : "weekly",
      hour: Number.isInteger(body.hour) ? body.hour : 19,
      timezone: body.timezone || "UTC",
      lastDaily: body.lastDaily || null,
      lastSent: null,
      createdAt: new Date().toISOString()
    });
    return json(200, { ok: true, mode: body.mode });
  }

  if (body.action === "logged") {
    const existing = await store.get(key, { type: "json" });
    if (existing) {
      existing.lastDaily = today();
      await store.setJSON(key, existing);
    }
    return json(200, { ok: true });
  }

  if (body.action === "unsubscribe") {
    await store.delete(key);
    return json(200, { ok: true });
  }

  return json(400, { error: "unknown action" });
};
