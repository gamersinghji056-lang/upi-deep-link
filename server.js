const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const Upi = require("./public/upi");
const { getProvider } = require("./lib/providers");
const { diagnose } = require("./lib/diagnostics");
const { PhonePePgClient } = require("./lib/phonepe-pg");

function makePaymentId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return "WP" + Array.from({ length: 8 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
}

function makePhonePeOrderId() {
  return "WPO" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(5).toString("hex").toUpperCase();
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
  await pool.query("alter table payment_links add column if not exists original_upi_uri text");
  await pool.query("alter table payment_links add column if not exists provider text not null default 'static_qr'");
  await pool.query("alter table payment_links add column if not exists requested_amount numeric(14,2)");
  await pool.query("create index if not exists payment_links_expires_at_idx on payment_links (expires_at)");

  await pool.query(`
    create table if not exists payment_orders (
      id text primary key,
      provider text not null,
      merchant_order_id text not null unique,
      provider_order_id text,
      provider_transaction_id text,
      amount numeric(14,2) not null,
      currency text not null default 'INR',
      status text not null default 'PENDING',
      intent_url text,
      provider_response jsonb,
      error_code text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      verified_at timestamptz
    )
  `);
  await pool.query("create index if not exists payment_orders_status_idx on payment_orders (status, updated_at)");
}

function createApp({ pool, env = process.env } = {}) {
  const app = express();
  const phonepe = new PhonePePgClient(env);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use((req, res, next) => {
    res.set("Referrer-Policy", "no-referrer");
    if (req.path.startsWith("/api/") || req.path.startsWith("/pay")) res.set("Cache-Control", "no-store");
    if (req.path.endsWith(".bak")) return res.sendStatus(404);
    next();
  });
  app.use(express.static(path.join(__dirname, "public")));
  app.use("/vendor/html5-qrcode", express.static(path.join(__dirname, "node_modules", "html5-qrcode")));

  app.get("/health", async (_req, res) => {
    try {
      if (!pool) return res.status(503).json({ ok: false, service: "upi-deep-link-checkout", database: "missing" });
      await pool.query("select 1");
      res.json({
        ok: true,
        service: "upi-deep-link-checkout",
        database: "ok",
        phonepeConfigured: phonepe.missingConfig().length === 0,
        phonepeEnvironment: phonepe.environment
      });
    } catch {
      res.status(503).json({ ok: false, service: "upi-deep-link-checkout", database: "error" });
    }
  });

  app.post("/api/orders", async (req, res, next) => {
    try {
      if (!pool) return res.status(503).json({ error: "Database is not configured" });
      const amountNumber = Number(req.body?.amount);
      if (!Number.isFinite(amountNumber) || amountNumber < 1 || amountNumber > 10000000) {
        return res.status(400).json({ error: "Enter a valid amount of at least INR 1.00" });
      }
      const amount = amountNumber.toFixed(2);
      const amountPaisa = Math.round(amountNumber * 100);
      const merchantOrderId = makePhonePeOrderId();
      const deviceOS = String(req.body?.deviceOS || "ANDROID").toUpperCase() === "IOS" ? "IOS" : "ANDROID";

      const created = await phonepe.createUpiIntent({ merchantOrderId, amountPaisa, deviceOS });
      if (!created.intentUrl || !created.orderId) {
        const error = new Error("PhonePe did not return an authorized UPI intent");
        error.status = 502;
        throw error;
      }

      await pool.query(
        `insert into payment_orders
          (id, provider, merchant_order_id, provider_order_id, amount, status, intent_url, provider_response)
         values ($1, 'phonepe_pg', $2, $3, $4, $5, $6, $7::jsonb)`,
        [merchantOrderId, merchantOrderId, created.orderId, amount, String(created.state || "PENDING").toUpperCase(), created.intentUrl, JSON.stringify(created)]
      );

      res.status(201).json({
        id: merchantOrderId,
        provider: "phonepe_pg",
        status: String(created.state || "PENDING").toUpperCase(),
        intentUrl: created.intentUrl,
        expiresAt: created.expireAt || created.expiryAt || null,
        statusVerified: false
      });
    } catch (error) { next(error); }
  });

  app.get("/api/orders/:id", async (req, res, next) => {
    try {
      if (!pool) return res.status(503).json({ error: "Database is not configured" });
      const id = String(req.params.id || "");
      if (!/^WPO[A-Z0-9]{8,60}$/.test(id)) return res.status(404).json({ error: "Order not found" });
      const result = await pool.query(
        `select id, provider, merchant_order_id, provider_order_id, provider_transaction_id,
                amount, currency, status, error_code, created_at, updated_at, verified_at
           from payment_orders where id = $1 limit 1`,
        [id]
      );
      if (!result.rowCount) return res.status(404).json({ error: "Order not found" });
      const row = result.rows[0];
      res.json({
        id: row.id,
        provider: row.provider,
        providerOrderId: row.provider_order_id,
        providerTransactionId: row.provider_transaction_id,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        errorCode: row.error_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        verifiedAt: row.verified_at,
        statusVerified: Boolean(row.verified_at)
      });
    } catch (error) { next(error); }
  });

  app.get("/api/orders/:id/status", async (req, res, next) => {
    try {
      if (!pool) return res.status(503).json({ error: "Database is not configured" });
      const id = String(req.params.id || "");
      if (!/^WPO[A-Z0-9]{8,60}$/.test(id)) return res.status(404).json({ error: "Order not found" });
      const existing = await pool.query("select * from payment_orders where id = $1 limit 1", [id]);
      if (!existing.rowCount) return res.status(404).json({ error: "Order not found" });

      const statusData = await phonepe.getOrderStatus(existing.rows[0].merchant_order_id);
      const state = String(statusData.state || "PENDING").toUpperCase();
      const terminal = ["COMPLETED", "FAILED", "EXPIRED"].includes(state);
      const latestPayment = Array.isArray(statusData.paymentDetails) && statusData.paymentDetails.length
        ? statusData.paymentDetails[statusData.paymentDetails.length - 1]
        : null;
      const transactionId = latestPayment?.transactionId || null;
      const errorCode = statusData.errorCode || latestPayment?.errorCode || null;

      await pool.query(
        `update payment_orders
            set status = $2,
                provider_order_id = coalesce($3, provider_order_id),
                provider_transaction_id = coalesce($4, provider_transaction_id),
                error_code = $5,
                provider_response = $6::jsonb,
                updated_at = now(),
                verified_at = case when $7 then now() else verified_at end
          where id = $1`,
        [id, state, statusData.orderId || null, transactionId, errorCode, JSON.stringify(statusData), terminal]
      );

      res.json({
        id,
        provider: "phonepe_pg",
        status: state,
        providerOrderId: statusData.orderId || existing.rows[0].provider_order_id,
        providerTransactionId: transactionId,
        errorCode,
        errorContext: statusData.errorContext || null,
        statusVerified: terminal,
        paymentDetails: statusData.paymentDetails || []
      });
    } catch (error) { next(error); }
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
      try { if (parsed.fields.am.length) amount = Upi.amount(parsed.fields.am[0]); } catch { }
      let requestedAmount = null;
      try { requestedAmount = Upi.amount(req.body?.amount); } catch { }
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

  app.get("/api/payments/:id/diagnostics", (req, res, next) => {
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    if (env.NODE_ENV !== "development" || env.UPI_DIAGNOSTICS !== "1" || !loopback) return res.sendStatus(404);
    next();
  }, loadPayment, (_req, res) => res.json(diagnose(res.locals.payment)));

  app.get("/pay/:id", loadPayment, (_req, res) => res.sendFile(path.join(__dirname, "public", "pay.html")));
  app.get("/pay", (_req, res) => res.sendFile(path.join(__dirname, "public", "pay.html")));
  app.use((error, _req, res, _next) => {
    const status = [400, 401, 403, 404, 409, 413, 422, 502, 503].includes(error.status) ? error.status : 500;
    if (status >= 500) console.error("Payment request failed", error.code || error.name, error.providerStatus || "");
    const message = status === 500 ? "Could not process payment request" : (error.message || "Payment request failed");
    res.status(status).json({ error: message });
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
module.exports = { createApp, initDb, makePaymentId, makePhonePeOrderId };
