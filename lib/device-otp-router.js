const express = require("express");
const crypto = require("crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function dummyMask(length) {
  const size = Number(length);
  if (!Number.isInteger(size) || size < 4 || size > 8) throw new Error("OTP length must be 4-8 digits");
  return "12345678".slice(0, size);
}

function sanitizeOtpMessage(value) {
  let text = String(value || "").slice(0, 3000);
  const otpLabel = "(?:OTP|one[\\s-]*time\\s+password|verification\\s+code|security\\s+code|passcode)";
  const afterCode = new RegExp(`\\b([0-9]{4,8})\\b(\\s+is\\s+(?:your\\s+)?(?:[A-Za-z][A-Za-z0-9._-]*\\s+){0,5}${otpLabel}\\b)`, "ig");
  const afterLabel = new RegExp(`(\\b${otpLabel}\\b(?:\\s*\\([^)]*\\))?\\s*(?:is|:|=|-)?\\s*)([0-9]{4,8})\\b`, "ig");
  const useAs = new RegExp(`(\\b(?:use|enter)\\s+)([0-9]{4,8})(\\s+(?:as|for)\\s+(?:your\\s+)?${otpLabel}\\b)`, "ig");

  text = text.replace(afterCode, (_all, code, suffix) => dummyMask(String(code).length) + suffix);
  text = text.replace(afterLabel, (_all, prefix, code) => prefix + dummyMask(String(code).length));
  text = text.replace(useAs, (_all, prefix, code, suffix) => prefix + dummyMask(String(code).length) + suffix);
  return text;
}

async function initDeviceOtpTables(pool) {
  if (!pool) return;
  await pool.query(`
    create table if not exists device_otp_events (
      id bigserial primary key,
      event_hash text not null unique,
      device_id text not null references devices(id) on delete cascade,
      sender text,
      code_mask text not null,
      otp_length integer not null,
      message_masked text not null,
      source text not null default 'sms',
      sms_received_at timestamptz not null,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query("create index if not exists device_otp_events_device_time_idx on device_otp_events(device_id,sms_received_at desc)");
}

function createDeviceOtpRouter({ pool }) {
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
    } catch (error) {
      next(error);
    }
  }

  function requireSimBinding(req, res) {
    const simFingerprint = String(req.body?.simFingerprint || "");
    if (!simFingerprint || sha256(simFingerprint) !== req.device.sim_fingerprint_hash) {
      res.status(409).json({ error: "SIM binding mismatch" });
      return false;
    }
    return true;
  }

  router.post("/otp-event", requireDevice, async (req, res, next) => {
    try {
      if (!requireSimBinding(req, res)) return;
      const otpLength = Number(req.body?.otpLength);
      const expectedMask = dummyMask(otpLength);
      const codeMask = String(req.body?.codeMask || "").trim();
      if (codeMask !== expectedMask) {
        return res.status(400).json({ error: "OTP must be masked before upload" });
      }

      const sender = String(req.body?.sender || "").trim().slice(0, 160) || null;
      const source = String(req.body?.source || "sms").trim().toLowerCase() === "sms" ? "sms" : "sms";
      const received = req.body?.receivedAt && !Number.isNaN(new Date(req.body.receivedAt).getTime())
        ? new Date(req.body.receivedAt)
        : new Date();
      const messageMasked = sanitizeOtpMessage(req.body?.messageMasked || "").trim().slice(0, 3000);
      if (!messageMasked || !messageMasked.includes(expectedMask)) {
        return res.status(400).json({ error: "Masked OTP message is required" });
      }

      const eventHash = sha256(`${req.device.id}\u0000${sender || ""}\u0000${received.toISOString()}\u0000${messageMasked}`);
      const inserted = await pool.query(
        `insert into device_otp_events(event_hash,device_id,sender,code_mask,otp_length,message_masked,source,sms_received_at)
         values($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict(event_hash) do nothing returning id`,
        [eventHash, req.device.id, sender, expectedMask, otpLength, messageMasked, source, received.toISOString()]
      );
      await pool.query("update devices set last_seen_at=now() where id=$1", [req.device.id]);
      res.status(201).json({ ok: true, status: "received", duplicate: !inserted.rowCount });
    } catch (error) {
      if (/OTP|masked/i.test(error.message || "")) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  router.get("/admin/device/:deviceId/otp-events", async (req, res, next) => {
    try {
      if (!pool) return res.status(503).json({ error: "Database is not configured" });
      const deviceId = String(req.params.deviceId || "");
      const device = await pool.query(
        "select id,phone_e164,manufacturer,model,last_seen_at from devices where id=$1 limit 1",
        [deviceId]
      );
      if (!device.rowCount) return res.status(404).json({ error: "Device not found" });
      const events = await pool.query(
        `select id,sender,code_mask,otp_length,message_masked,source,sms_received_at,created_at
           from device_otp_events
          where device_id=$1
          order by sms_received_at desc,id desc
          limit 200`,
        [deviceId]
      );
      res.json({
        deviceId,
        phoneE164: device.rows[0].phone_e164 || null,
        device: device.rows[0],
        events: events.rows
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  dummyMask,
  sanitizeOtpMessage,
  initDeviceOtpTables,
  createDeviceOtpRouter
};
