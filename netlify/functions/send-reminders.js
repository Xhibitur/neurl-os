// netlify/functions/send-reminders.js
// Runs hourly. Sends each subscriber a reminder when it hits their chosen
// local hour: the weekly reading prompt on Sundays, a daily nudge otherwise.

const webpush = require("web-push");
const { getStore } = require("@netlify/blobs");

webpush.setVapidDetails(
  "mailto:hello@neurl-os.com",
  process.env.PUSH_PUBLIC_KEY,
  process.env.PUSH_PRIVATE_KEY
);

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
      date: parts.year + "-" + parts.month + "-" + parts.day
    };
  } catch (e) {
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

exports.handler = async () => {
  if (!process.env.PUSH_PRIVATE_KEY || !process.env.PUSH_PUBLIC_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "VAPID keys not set in environment" }) };
  }

  const store = getStore("neurl-subs");
  let sent = 0, skipped = 0, removed = 0, failed = 0;

  try {
    const { blobs } = await store.list();

    for (const blob of blobs) {
      const rec = await store.get(blob.key, { type: "json" });
      if (!rec || !rec.subscription) { skipped++; continue; }

      const now = localParts(rec.timezone);
      const targetHour = Number.isInteger(rec.hour) ? rec.hour : 18;

      // only fire in the subscriber's chosen hour
      if (now.hour !== targetHour) { skipped++; continue; }

      // never send twice on the same local day
      if (rec.lastSent === now.date) { skipped++; continue; }

      const isSunday = now.weekday === "Sun";
      let payload = null;

      if (isSunday) {
        // Sunday is always the weekly reading prompt, for both modes.
        payload = WEEKLY;
      } else if (rec.mode === "daily") {
        // Skip the nudge if they already logged today.
        if (rec.lastDaily === now.date) { skipped++; continue; }
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
        // 404/410 mean the subscription is dead — clean it up.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await store.delete(blob.key);
          removed++;
        } else {
          failed++;
          console.error("send failed:", err.statusCode, err.body);
        }
      }
    }

    console.log(JSON.stringify({ sent, skipped, removed, failed }));
    return { statusCode: 200, body: JSON.stringify({ sent, skipped, removed, failed }) };
  } catch (error) {
    console.error("reminder job error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
