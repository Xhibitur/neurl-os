// netlify/functions/partners.js
// Stores co-branded partner pages. Reads are public (the partner page needs
// them); writes require the admin PIN, which is checked HERE on the server so
// it never ships inside index.html.

const { getStore } = require("@netlify/blobs");

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj)
});

function cleanSlug(s) {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 40);
}

exports.handler = async (event) => {
  const store = getStore("neurl-partners");

  // ---- public read ----
  if (event.httpMethod === "GET") {
    const slug = cleanSlug((event.queryStringParameters || {}).p);
    if (slug) {
      const rec = await store.get(slug, { type: "json" });
      if (!rec) return json(404, { error: "not found" });
      return json(200, rec);
    }
    return json(400, { error: "missing p" });
  }

  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "bad json" }); }

  // ---- everything below requires the PIN ----
  const pin = process.env.ADMIN_PIN;
  if (!pin) return json(500, { error: "ADMIN_PIN not configured" });
  if (String(body.pin || "") !== String(pin)) return json(401, { error: "bad pin" });

  if (body.action === "list") {
    const { blobs } = await store.list();
    const out = [];
    for (const b of blobs) {
      const rec = await store.get(b.key, { type: "json" });
      if (rec) out.push(rec);
    }
    out.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return json(200, { partners: out });
  }

  if (body.action === "save") {
    const slug = cleanSlug(body.slug || body.name);
    if (!slug) return json(400, { error: "slug required" });
    const rec = {
      slug: slug,
      name: String(body.name || "").slice(0, 80),
      kind: String(body.kind || "gym").slice(0, 40),
      headline: String(body.headline || "").slice(0, 140),
      blurb: String(body.blurb || "").slice(0, 300),
      logoUrl: String(body.logoUrl || "").slice(0, 400),
      accent: /^#[0-9a-fA-F]{6}$/.test(body.accent || "") ? body.accent : "#38EE66",
      active: body.active !== false,
      updatedAt: new Date().toISOString()
    };
    if (!rec.name) return json(400, { error: "name required" });
    await store.setJSON(slug, rec);
    return json(200, { ok: true, partner: rec, url: "https://neurl-os.com/?p=" + slug });
  }

  if (body.action === "delete") {
    const slug = cleanSlug(body.slug);
    if (!slug) return json(400, { error: "slug required" });
    await store.delete(slug);
    return json(200, { ok: true });
  }

  return json(400, { error: "unknown action" });
};
