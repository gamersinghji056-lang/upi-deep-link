const express = require("express");

function normalizeUtr(value) {
  const text = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{6,40}$/.test(text)) throw new Error("Enter a valid UTR/reference number");
  return text;
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid payment amount");
  return amount.toFixed(2);
}

async function initPaymentVerificationTables(pool) {
  await pool.query(`
    create table if not exists payment_claims (
      payment_id text primary key references payment_links(id) on delete cascade,
      utr_normalized text not null unique,
      utr_display text not null,
      amount numeric(14,2) not null,
      status text not null default 'pending',
      submitted_at timestamptz not null default now(),
      verified_at timestamptz,
      verified_device_id text references devices(id),
      verification_source text
    )
  `);
  await pool.query(`
    create table if not exists device_credit_events (
      id bigserial primary key,
      device_id text not null references devices(id) on delete cascade,
      utr_normalized text not null,
      amount numeric(14,2) not null,
      sender text,
      account_suffix text,
      sms_received_at timestamptz not null,
      created_at timestamptz not null default now(),
      unique(device_id, utr_normalized)
    )
  `);
  await pool.query("create index if not exists device_credit_events_match_idx on device_credit_events(utr_normalized, amount, sms_received_at desc)");
  await pool.query("create index if not exists payment_claims_status_idx on payment_claims(status, submitted_at desc)");
}

async function markMatched(pool, { paymentId, deviceId, utrNormalized, amount }) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const claim = await client.query(
      `select c.payment_id, c.status, c.amount, p.status as payment_status
         from payment_claims c
         join payment_links p on p.id = c.payment_id
        where c.payment_id = $1 and c.utr_normalized = $2
        for update`,
      [paymentId, utrNormalized]
    );
    if (!claim.rowCount || claim.rows[0].status === "success") {
      await client.query("commit");
      return Boolean(claim.rowCount && claim.rows[0].status === "success");
    }
    if (Number(claim.rows[0].amount).toFixed(2) !== Number(amount).toFixed(2)) {
      await client.query("rollback");
      return false;
    }
    await client.query(
      `update payment_claims
          set status='success', verified_at=now(), verified_device_id=$2,
              verification_source='paired_device_credit_sms'
        where payment_id=$1`,
      [paymentId, deviceId]
    );
    await client.query("update payment_links set status='success' where id=$1", [paymentId]);
    await client.query("commit");
    return true;
  } catch (error) {
    try { await client.query("rollback"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function matchCreditEvent(pool, { deviceId, utrNormalized, amount, receivedAt }) {
  const candidates = await pool.query(
    `select c.payment_id
       from payment_claims c
       join payment_links p on p.id = c.payment_id
      where c.status='pending'
        and c.utr_normalized=$1
        and c.amount=$2
        and p.status='pending'
        and p.created_at <= $3::timestamptz + interval '10 minutes'
        and p.expires_at >= $3::timestamptz
      order by c.submitted_at desc
      limit 1`,
    [utrNormalized, amount, receivedAt]
  );
  if (!candidates.rowCount) return null;
  const paymentId = candidates.rows[0].payment_id;
  const matched = await markMatched(pool, { paymentId, deviceId, utrNormalized, amount });
  return matched ? paymentId : null;
}

async function recordCreditSms(pool, { deviceId, utr, amount, sender, accountSuffix, receivedAt }) {
  const utrNormalized = normalizeUtr(utr);
  const normalizedAmount = normalizeAmount(amount);
  const received = receivedAt && !Number.isNaN(new Date(receivedAt).getTime()) ? new Date(receivedAt) : new Date();
  const senderSafe = String(sender || "").trim().slice(0, 80) || null;
  const suffixSafe = String(accountSuffix || "").replace(/\D/g, "").slice(-6) || null;

  await pool.query(
    `insert into device_credit_events(device_id, utr_normalized, amount, sender, account_suffix, sms_received_at)
     values($1,$2,$3,$4,$5,$6)
     on conflict(device_id, utr_normalized) do update set
       amount=excluded.amount,
       sender=coalesce(excluded.sender, device_credit_events.sender),
       account_suffix=coalesce(excluded.account_suffix, device_credit_events.account_suffix),
       sms_received_at=greatest(device_credit_events.sms_received_at, excluded.sms_received_at)`,
    [deviceId, utrNormalized, normalizedAmount, senderSafe, suffixSafe, received.toISOString()]
  );

  const matchedPaymentId = await matchCreditEvent(pool, {
    deviceId,
    utrNormalized,
    amount: normalizedAmount,
    receivedAt: received.toISOString()
  });
  return { utrNormalized, amount: normalizedAmount, matchedPaymentId };
}

function createPaymentVerificationRouter({ pool }) {
  const router = express.Router();

  router.post("/payments/:id/utr", async (req, res, next) => {
    try {
      if (!pool) return res.status(503).json({ error: "Database is not configured" });
      const paymentId = String(req.params.id || "");
      if (!/^WP[A-Za-z0-9]{8}$/.test(paymentId)) return res.status(404).json({ error: "Payment link not found" });
      const payment = await pool.query("select * from payment_links where id=$1 limit 1", [paymentId]);
      if (!payment.rowCount) return res.status(404).json({ error: "Payment link not found" });
      const row = payment.rows[0];
      if (row.status === "success") return res.json({ paymentId, status: "success", verified: true });
      if (new Date(row.expires_at).getTime() <= Date.now()) return res.status(410).json({ error: "Payment link expired" });

      const utrDisplay = String(req.body?.utr || "").trim();
      const utrNormalized = normalizeUtr(utrDisplay);
      const amount = normalizeAmount(row.amount ?? row.requested_amount);

      try {
        await pool.query(
          `insert into payment_claims(payment_id, utr_normalized, utr_display, amount, status, submitted_at)
           values($1,$2,$3,$4,'pending',now())
           on conflict(payment_id) do update set
             utr_normalized=excluded.utr_normalized,
             utr_display=excluded.utr_display,
             amount=excluded.amount,
             status=case when payment_claims.status='success' then payment_claims.status else 'pending' end,
             submitted_at=case when payment_claims.status='success' then payment_claims.submitted_at else now() end`,
          [paymentId, utrNormalized, utrDisplay.slice(0, 64), amount]
        );
      } catch (error) {
        if (error.code === "23505") return res.status(409).json({ error: "This UTR is already linked to another payment" });
        throw error;
      }

      const existingCredit = await pool.query(
        `select device_id, sms_received_at
           from device_credit_events
          where utr_normalized=$1 and amount=$2
          order by sms_received_at desc limit 1`,
        [utrNormalized, amount]
      );
      let matched = false;
      if (existingCredit.rowCount) {
        const smsTime = new Date(existingCredit.rows[0].sms_received_at).getTime();
        const created = new Date(row.created_at).getTime();
        const expires = new Date(row.expires_at).getTime();
        if (smsTime >= created - 10 * 60 * 1000 && smsTime <= expires) {
          matched = await markMatched(pool, {
            paymentId,
            deviceId: existingCredit.rows[0].device_id,
            utrNormalized,
            amount
          });
        }
      }

      res.status(matched ? 200 : 202).json({
        paymentId,
        status: matched ? "success" : "pending",
        verified: matched,
        message: matched ? "Payment verified" : "UTR submitted. Waiting for matching credit confirmation."
      });
    } catch (error) { next(error); }
  });

  router.get("/payments/:id/verification-status", async (req, res, next) => {
    try {
      if (!pool) return res.status(503).json({ error: "Database is not configured" });
      const paymentId = String(req.params.id || "");
      if (!/^WP[A-Za-z0-9]{8}$/.test(paymentId)) return res.status(404).json({ error: "Payment link not found" });
      const result = await pool.query(
        `select p.id, p.status as payment_status, p.expires_at,
                c.status as claim_status, c.utr_display, c.verified_at, c.verification_source
           from payment_links p
           left join payment_claims c on c.payment_id=p.id
          where p.id=$1 limit 1`,
        [paymentId]
      );
      if (!result.rowCount) return res.status(404).json({ error: "Payment link not found" });
      const row = result.rows[0];
      const success = row.payment_status === "success" && row.claim_status === "success";
      const utr = row.utr_display || "";
      res.json({
        paymentId,
        status: success ? "success" : (row.claim_status || "awaiting_utr"),
        verified: success,
        utrMasked: utr ? "••••" + utr.slice(-4) : null,
        verifiedAt: row.verified_at,
        verificationSource: success ? row.verification_source : null,
        expiresAt: row.expires_at
      });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = {
  normalizeUtr,
  initPaymentVerificationTables,
  createPaymentVerificationRouter,
  recordCreditSms
};
