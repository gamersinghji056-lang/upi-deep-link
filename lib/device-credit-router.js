const express = require("express");
const crypto = require("crypto");
const { recordCreditSms } = require("./payment-verification");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function createDeviceCreditRouter({ pool }) {
  const router = express.Router();

  async function requireDevice(req, res, next) {
    try {
      if (!pool) return res.status(503).json({ error: "Database is not configured" });
      const deviceId = String(req.get("x-device-id") || "");
      const auth = String(req.get("authorization") || "");
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!deviceId || !token) return res.status(401).json({ error: "Device authentication required" });
      const result = await pool.query("select * from devices where id=$1 and status='active' limit 1", [deviceId]);
      if (!result.rowCount) return res.status(401).json({ error: "Unknown device" });
      const expected = Buffer.from(result.rows[0].credential_hash, "hex");
      const actual = Buffer.from(sha256(token), "hex");
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return res.status(401).json({ error: "Invalid device credential" });
      }
      req.device = result.rows[0];
      next();
    } catch (error) { next(error); }
  }

  router.post("/credit-sms", requireDevice, async (req, res, next) => {
    try {
      const simFingerprint = String(req.body?.simFingerprint || "");
      if (!simFingerprint || sha256(simFingerprint) !== req.device.sim_fingerprint_hash) {
        return res.status(409).json({ error: "SIM binding mismatch" });
      }

      const result = await recordCreditSms(pool, {
        deviceId: req.device.id,
        utr: req.body?.utr,
        amount: req.body?.amount,
        sender: req.body?.sender,
        accountSuffix: req.body?.accountSuffix,
        receivedAt: req.body?.receivedAt
      });

      await pool.query("update devices set last_seen_at=now() where id=$1", [req.device.id]);
      await pool.query(
        `insert into device_transactions(device_id, payment_id, utr, status, app, amount, raw_result)
         values($1,$2,$3,$4,'BANK_SMS',$5,$6::jsonb)`,
        [
          req.device.id,
          result.matchedPaymentId,
          result.utrNormalized,
          result.matchedPaymentId ? "SUCCESS" : "CREDIT_RECEIVED",
          result.amount,
          JSON.stringify({ sender: String(req.body?.sender || "").slice(0, 80), receivedAt: req.body?.receivedAt || null })
        ]
      );

      res.status(201).json({
        ok: true,
        matched: Boolean(result.matchedPaymentId),
        paymentId: result.matchedPaymentId,
        status: result.matchedPaymentId ? "success" : "unmatched_credit"
      });
    } catch (error) {
      if (/UTR|amount/i.test(error.message || "")) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  return router;
}

module.exports = { createDeviceCreditRouter };
