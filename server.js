const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 3000;
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/vendor/html5-qrcode",
  express.static(path.join(__dirname, "node_modules", "html5-qrcode"))
);

function isUpiUri(value) {
  if (typeof value !== "string" || !/^upi:\/\/pay\?/i.test(value.trim())) return false;
  try {
    const u = new URL(value.trim());
    const pa = (u.searchParams.get("pa") || "").trim();
    return u.protocol === "upi:" && u.hostname === "pay" && /^[^\s@]+@[^\s@]+$/.test(pa);
  } catch {
    return false;
  }
}

function appendParamRaw(raw, key, value) {
  const hashIndex = raw.indexOf("#");
  const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const hash = hashIndex >= 0 ? raw.slice(hashIndex) : "";
  const sep = beforeHash.includes("?")
    ? (beforeHash.endsWith("?") || beforeHash.endsWith("&") ? "" : "&")
    : "?";
  return beforeHash + sep + encodeURIComponent(key) + "=" + encodeURIComponent(value) + hash;
}

function hasParam(raw, key) {
  try {
    const u = new URL(raw);
    return u.searchParams.has(key);
  } catch {
    return false;
  }
}

function buildFinalUpi(raw, amount, profile) {
  let finalUri = raw.trim();
  const u = new URL(finalUri);
  const signed = [...u.searchParams.keys()].some((k) => k.toLowerCase() === "sign");
  const existingAmount = Number((u.searchParams.get("am") || "").trim());

  if (profile === "exact" || signed) return finalUri;

  if (!(Number.isFinite(existingAmount) && existingAmount > 0)) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) throw new Error("A valid amount is required");
    finalUri = appendParamRaw(finalUri, "am", n.toFixed(2));
  }

  if (profile === "standard" && !hasParam(finalUri, "cu")) {
    finalUri = appendParamRaw(finalUri, "cu", "INR");
  }

  return finalUri;
}

function makePaymentId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(8);
  let out = "WP";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function initDb() {
  if (!pool) throw new Error("DATABASE_URL is missing");
  await pool.query(`
    create table if not exists payment_links (
      id text primary key,
      upi_uri text not null,
      source text not null default 'merchant',
      profile text not null default 'scan',
      amount numeric(14,2),
      status text not null default 'pending',
      created_at timestamptz not null default now(),
      expires_at timestamptz not null default (now() + interval '24 hours')
    )
  `);
  await pool.query("create index if not exists payment_links_expires_at_idx on payment_links (expires_at)");
}

app.get("/health", async (_req, res) => {
  try {
    if (!pool) return res.status(503).json({ ok: false, service: "upi-deep-link-checkout", database: "missing" });
    await pool.query("select 1");
    res.json({ ok: true, service: "upi-deep-link-checkout", database: "ok" });
  } catch (error) {
    res.status(503).json({ ok: false, service: "upi-deep-link-checkout", database: "error" });
  }
});

app.post("/api/payments", async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Database is not configured" });

    const raw = String(req.body?.upiUri || "").trim();
    const profile = ["scan", "exact", "standard"].includes(req.body?.profile) ? req.body.profile : "scan";
    const source = req.body?.source === "manual" ? "manual" : "merchant";
    const amount = req.body?.amount;

    if (!isUpiUri(raw)) return res.status(400).json({ error: "Invalid UPI payment URI" });

    const finalUri = buildFinalUpi(raw, amount, profile);
    const parsed = new URL(finalUri);
    const finalAmount = Number((parsed.searchParams.get("am") || "").trim());

    let id;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = makePaymentId();
      const exists = await pool.query("select 1 from payment_links where id = $1", [candidate]);
      if (!exists.rowCount) { id = candidate; break; }
    }
    if (!id) throw new Error("Could not allocate payment id");

    await pool.query(
      `insert into payment_links (id, upi_uri, source, profile, amount)
       values ($1, $2, $3, $4, $5)`,
      [id, finalUri, source, profile, Number.isFinite(finalAmount) && finalAmount > 0 ? finalAmount : null]
    );

    res.status(201).json({
      id,
      url: `${req.protocol}://${req.get("host")}/pay/${id}`,
      expiresIn: "24h"
    });
  } catch (error) {
    console.error("create payment link failed", error);
    res.status(500).json({ error: error.message || "Could not create payment link" });
  }
});

app.get("/api/payments/:id", async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Database is not configured" });
    const id = String(req.params.id || "");
    if (!/^WP[A-Za-z0-9]{8}$/.test(id)) return res.status(404).json({ error: "Payment link not found" });

    const result = await pool.query(
      `select id, upi_uri, source, profile, amount, status, created_at, expires_at
       from payment_links where id = $1 limit 1`,
      [id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Payment link not found" });

    const row = result.rows[0];
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: "Payment link expired" });
    }

    res.json({
      id: row.id,
      upiUri: row.upi_uri,
      source: row.source,
      profile: row.profile,
      amount: row.amount,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    });
  } catch (error) {
    console.error("fetch payment link failed", error);
    res.status(500).json({ error: "Could not load payment link" });
  }
});

app.get("/pay/:id", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "pay.html"));
});

app.get("/pay", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "pay.html"));
});

initDb()
  .then(() => {
    app.listen(port, "0.0.0.0", () => {
      console.log(`UPI checkout listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("database initialization failed", error);
    process.exit(1);
  });
