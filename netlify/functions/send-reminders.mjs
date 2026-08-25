// netlify/functions/send-reminders.mjs
// Netlify v2 scheduled function — runs hourly. Sends each subscriber a reminder
// at their chosen local hour: the weekly reading prompt on Sundays, a daily
// nudge otherwise. The schedule is declared in the config export below.

import { getStore } from "@netlify/blobs";
import webpush from "web-push";

export const config = { schedule: "0 * * * *" };

// What hour and weekday is it for this subscriber right now?
function localParts(timezone) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      hour: "numeric",
      hour12: false,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const parts = {};
    fmt.formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
    return {
      hour: parseInt(parts.hour, 10) % 24,
      weekday: parts.weekday,
      date: `${parts.year}-${parts.month}-${parts.day}`
    };
  } catch {
    const d = new Date();
    return {
      hour: d.getUTCHours(),
      weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()],
      date: d.toISOString().slice(0, 10)
    };
  }
}

const WEEKLY = {
  title: "Your NEURL Score is ready",
  body: "Two minutes. See what changed this week.",
  url: "https://neurl-os.com/?src=push_weekly"
};

const DAILY = {
  title: "15-second check-in",
  body: "Three sliders. Keeps Sunday's reading accurate.",
  url: "https://neurl-os.com/?src=push_daily"
};

export default async () => {
  if (!process.env.PUSH_PRIVATE_KEY || !process.env.PUSH_PUBLIC_KEY) {
    return new Response(JSON.stringify({ error: "VAPID keys not set" }), { status: 500 });
  }

  webpush.setVapidDetails(
    "mailto:hello@neurl-os.com",
    process.env.PUSH_PUBLIC_KEY,
    process.env.PUSH_PRIVATE_KEY
  );

  let store;
  try {
    store = getStore("neurl-subs");
  } catch (e) {
    console.error("blobs unavailable:", e.message);
    return new Response(JSON.stringify({ error: "blobs unavailable", detail: e.message }), { status: 500 });
  }

  let sent = 0, skipped = 0, removed = 0, failed = 0;

  const { blobs } = await store.list();

  for (const blob of blobs) {
    const rec = await store.get(blob.key, { type: "json" });
    if (!rec || !rec.subscription) { skipped++; continue; }

    const now = localParts(rec.timezone);
    const targetHour = Number.isInteger(rec.hour) ? rec.hour : 19;

    if (now.hour !== targetHour) { skipped++; continue; }   // wrong hour for them
    if (rec.lastSent === now.date) { skipped++; continue; } // already sent today

    let payload = null;
    if (now.weekday === "Sun") {
      payload = WEEKLY;                                     // Sunday is always the reading
    } else if (rec.mode === "daily") {
      if (rec.lastDaily === now.date) { skipped++; continue; } // already logged today
      payload = DAILY;
    } else {
      skipped++;
      continue;
    }

    try {
      await webpush.sendNotification(rec.subscription, JSON.stringify(payload));
      rec.lastSent = now.date;
      await store.setJSON(blob.key, rec);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await store.delete(blob.key);   // dead subscription, clean it up
        removed++;
      } else {
        failed++;
        console.error("send failed:", err.statusCode, err.body);
      }
    }
  }

  console.log(JSON.stringify({ sent, skipped, removed, failed }));
  return new Response(JSON.stringify({ sent, skipped, removed, failed }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
