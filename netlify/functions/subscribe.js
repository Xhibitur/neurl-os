// netlify/functions/subscribe.js
// Stores push subscriptions so the scheduled sender knows who to notify.
// Uses Netlify Blobs — no database or extra account required.

const { getStore } = require("@netlify/blobs");

function keyFor(subscription) {
  // The endpoint uniquely identifies a browser subscription.
  const raw = subscription && subscription.endpoint ? subscription.endpoint : "";
  return Buffer.from(raw).toString("base64url").slice(0, 120);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const store = getStore("neurl-subs");
    const key = keyFor(body.subscription);
    if (!key) return { statusCode: 400, body: JSON.stringify({ error: "missing subscription" }) };

    if (body.action === "subscribe") {
      await store.setJSON(key, {
        subscription: body.subscription,
        mode: body.mode === "daily" ? "daily" : "weekly",
        hour: Number.isInteger(body.hour) ? body.hour : 18,
        timezone: body.timezone || "UTC",
        lastDaily: body.lastDaily || null,
        lastSent: null,
        createdAt: new Date().toISOString()
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, mode: body.mode }) };
    }

    if (body.action === "logged") {
      const existing = await store.get(key, { type: "json" });
      if (existing) {
        existing.lastDaily = today();
        await store.setJSON(key, existing);
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    if (body.action === "unsubscribe") {
      await store.delete(key);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: "unknown action" }) };
  } catch (error) {
    console.error("subscribe error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
