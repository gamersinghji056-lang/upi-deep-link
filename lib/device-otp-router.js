const express = require("express");
const crypto = require("crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function otpMask(length) {
  const safeLength = Number.isInteger(length) && length >= 4 && length <= 8 ? length : 0;
  return safeLength ? "*".repeat(safeLength) : "Detected";
}

function sanitizeMaskedMessage(value, legacyOtpCode = "", otpLength = 0) {
  let text = String(value || "").trim().slice(0, 1000);
  if (legacyOtpCode && /^\d{4,8}$/.test(legacyOtpCode)) {
    text = text.split(legacyOtpCode).join("[OTP]");
  }
  if (!text) return `OTP detected (${otpLength || "unknown"} digits)`;
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
  await pool.query(`
    update device_otp_events
       set code_mask = repeat('*', otp_length)
     where otp_length between 4 and 8
       and code_mask ~ '^\\d{4,8}$'
  `);
  await pool.query(`
    update device_otp_events
       set message_masked = case
         when otp_length between 4 and 8 then 'OTP detected (' || otp_length || ' digits)'
         else 'OTP detected'
       end
     where message_masked = ''
  `);
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

      const sender = String(req.body?.sender || "").trim().slice(0, 160) || null;
      const legacyOtpCode = String(req.body?.otpCode || "").trim();
      if (legacyOtpCode && !/^\d{4,8}$/.test(legacyOtpCode)) {
        return res.status(400).json({ error: "OTP metadata is invalid" });
      }
      const requestedLength = Number(req.body?.otpLength);
      const otpLength = /^\d{4,8}$/.test(legacyOtpCode)
        ? legacyOtpCode.length
        : (Number.isInteger(requestedLength) && requestedLength >= 4 && requestedLength <= 8 ? requestedLength : 0);
      if (!otpLength) return res.status(422).json({ error: "OTP length is required" });

      const codeMask = otpMask(otpLength);
      const messageMasked = sanitizeMaskedMessage(req.body?.messageMasked, legacyOtpCode, otpLength);
      const source = String(req.body?.source || "sms").trim().toLowerCase() === "sms" ? "sms" : "sms";
      const received = req.body?.receivedAt && !Number.isNaN(new Date(req.body.receivedAt).getTime())
        ? new Date(req.body.receivedAt)
        : new Date();

      const eventHash = sha256([
        req.device.id,
        sender || "",
        received.toISOString(),
        source
      ].join("\u0000"));

      const inserted = await pool.query(
        `insert into device_otp_events(event_hash,device_id,sender,code_mask,otp_length,message_masked,source,sms_received_at)
         values($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict(event_hash) do update set
           code_mask = excluded.code_mask,
           otp_length = excluded.otp_length,
           message_masked = case
             when device_otp_events.message_masked = '' or device_otp_events.message_masked like 'OTP detected%'
             then excluded.message_masked
             else device_otp_events.message_masked
           end
         returning id`,
        [eventHash, req.device.id, sender, codeMask, otpLength, messageMasked, source, received.toISOString()]
      );

      await pool.query("update devices set last_seen_at=now() where id=$1", [req.device.id]);
      res.status(201).json({ ok: true, status: "received", duplicate: !inserted.rowCount });
    } catch (error) {
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
        `select id,sender,
                case when otp_length between 4 and 8 then repeat('*', otp_length) else 'Detected' end as otp_code,
                otp_length,message_masked,source,sms_received_at,created_at
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
  otpMask,
  sanitizeMaskedMessage,
  initDeviceOtpTables,
  createDeviceOtpRouter
};
