const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const Upi = require("./public/upi");
const { getProvider } = require("./lib/providers");
const { diagnose } = require("./lib/diagnostics");

function makePaymentId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return "WP" + Array.from({ length: 8 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
}

async function initDb(pool) {
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
  // Additive migration only. Never claim an old final URI is its original QR.
  await pool.query("alter table payment_links add column if not exists original_upi_uri text");
  await pool.query("alter table payment_links add column if not exists provider text not null default 'static_qr'");
  await pool.query("alter table payment_links add column if not exists requested_amount numeric(14,2)");
  await pool.query("create index if not exists payment_links_expires_at_idx on payment_links (expires_at)");
}

function createApp({ pool, env = process.env } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use((req, res, next) => {
    res.set("Referrer-Policy", "no-referrer");
    if (req.path.startsWith("/api/") || req.path.startsWith("/pay")) res.set("Cache-Control", "no-store");
    // Historical backup pages are development artifacts.
    if (req.path.endsWith(".bak")) return res.sendStatus(404);
    next();
  });
  app.use(express.static(path.join(__dirname, "public")));
  app.use("/vendor/html5-qrcode", express.static(path.join(__dirname, "node_modules", "html5-qrcode")));

  app.get("/health", async (_req, res) => {
    try {
      if (!pool) return res.status(503).json({ ok: false, service: "upi-deep-link-checkout", database: "missing" });
      await pool.query("select 1");
      res.json({ ok: true, service: "upi-deep-link-checkout", database: "ok" });
    } catch {
      res.status(503).json({ ok: false, service: "upi-deep-link-checkout", database: "error" });
    }
  });

  app.post("/api/payments", async (req, res, next) => {
    try {
      if (!pool) return res.status(503).json({ error: "Database is not configured" });
      const raw = req.body?.upiUri;
      let profile;
      try { Upi.parse(raw); profile = Upi.mode(req.body?.profile); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      const source = req.body?.source === "manual" ? "manual" : "merchant";
      let provider;
      try { provider = getProvider(req.body?.provider, env); }
      catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
      let transaction;
      try { transaction = await provider.createTransaction({ upiUri: raw, amount: req.body?.amount, profile, source }); }
      catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
      const finalUri = provider.getIntentUri(transaction);
      const parsed = Upi.parse(finalUri);
      let amount = null;
      try { if (parsed.fields.am.length) amount = Upi.amount(parsed.fields.am[0]); } catch { /* Do not invent an amount. */ }
      let requestedAmount = null;
      try { requestedAmount = Upi.amount(req.body?.amount); } catch { /* EXACT does not require an amount. */ }
      let id;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = makePaymentId();
        const inserted = await pool.query(
          `insert into payment_links (id, upi_uri, source, profile, amount, original_upi_uri, provider, requested_amount)
           values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (id) do nothing returning id`,
          [candidate, finalUri, source, profile, amount, raw, transaction.provider, requestedAmount]
        );
        if (inserted.rowCount) { id = candidate; break; }
      }
      if (!id) throw new Error("Could not allocate payment ID");
      // Preserve the domain behind Railway TLS. Local clients resolve relative links.
      const origin = env.PUBLIC_BASE_URL || (env.NODE_ENV === "production" ? "https://pay.wtron.org" : "");
      res.status(201).json({ id, url: origin.replace(/\/$/, "") + "/pay/" + id, expiresIn: "24h", profile, provider: transaction.provider });
    } catch (error) { next(error); }
  });

  async function loadPayment(req, res, next) {
    try {
      if (!/^WP[A-Za-z0-9]{8}$/.test(req.params.id)) return res.status(404).json({ error: "Payment link not found" });
      if (!pool) return res.status(503).json({ error: "Database is not configured" });
      const result = await pool.query("select * from payment_links where id = $1 limit 1", [req.params.id]);
      if (!result.rowCount) return res.status(404).json({ error: "Payment link not found" });
      const row = result.rows[0];
      if (new Date(row.expires_at).getTime() <= Date.now()) return res.status(410).json({ error: "Payment link expired" });
      res.locals.payment = row;
      next();
    } catch (error) { next(error); }
  }

  app.get("/api/payments/:id", loadPayment, (_req, res) => {
    const row = res.locals.payment;
    res.json({ id: row.id, upiUri: row.upi_uri, source: row.source, profile: row.profile, amount: row.amount, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at, provider: row.provider, statusVerified: false });
  });

  // Explicit development opt-in AND loopback. Forwarded headers cannot enable this.
  app.get("/api/payments/:id/diagnostics", (req, res, next) => {
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    if (env.NODE_ENV !== "development" || env.UPI_DIAGNOSTICS !== "1" || !loopback) return res.sendStatus(404);
    next();
  }, loadPayment, (_req, res) => res.json(diagnose(res.locals.payment)));

  app.get("/pay/:id", loadPayment, (_req, res) => res.sendFile(path.join(__dirname, "public", "pay.html")));
  app.get("/pay", (_req, res) => res.sendFile(path.join(__dirname, "public", "pay.html")));
  app.use((error, _req, res, _next) => {
    const status = error.status === 400 || error.status === 413 ? error.status : 500;
    if (status === 500) console.error("Payment request failed", error.code || error.name);
    res.status(status).json({ error: status === 500 ? "Could not process payment link" : "Invalid request body" });
  });
  return app;
}

async function start() {
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
  try {
    await initDb(pool);
    const app = createApp({ pool });
    const host = process.env.NODE_ENV === "development" ? "127.0.0.1" : "0.0.0.0";
    return app.listen(process.env.PORT || 3000, host, () => console.log("UPI checkout listening on port " + (process.env.PORT || 3000)));
  } catch (error) {
    await pool?.end();
    console.error("Database initialization failed:", !pool ? "DATABASE_URL is missing" : (error.code || error.name));
    process.exitCode = 1;
  }
}
if (require.main === module) start();
module.exports = { createApp, initDb, makePaymentId };
