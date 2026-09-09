const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const otpModule = require("../lib/device-otp-router");

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "device-otp-router.js"), "utf8");

test("OTP message helper keeps context while replacing the raw code", () => {
  const masked = otpModule.sanitizeMaskedMessage(
    "Dear Customer, 291653 is One Time Password(OTP) for the request.",
    "291653",
    6
  );
  assert.equal(masked.includes("291653"), false);
  assert.equal(masked.includes("[OTP]"), true);
  assert.equal(masked.includes("for the request"), true);
});

test("OTP router accepts the full validated code and redacted message", () => {
  assert.equal(source.includes("req.body?.otpLength"), true);
  assert.equal(source.includes("req.body?.otpCode"), true);
  assert.equal(source.includes("OTP length is required"), true);
  assert.equal(source.includes("sanitizeMaskedMessage"), true);
  assert.equal(source.includes("const codeMask = legacyOtpCode || \"\""), true);
});

test("OTP dashboard returns the stored full code and redacted message context", () => {
  assert.equal(source.includes("code_mask as otp_code"), true);
  assert.equal(source.includes("message_masked,source,sms_received_at,created_at"), true);
  assert.equal(source.includes("select id,sender,code_mask as otp_code"), true);
});

test("OTP router exports the required runtime functions", () => {
  assert.equal(typeof otpModule.sanitizeMaskedMessage, "function");
  assert.equal(typeof otpModule.initDeviceOtpTables, "function");
  assert.equal(typeof otpModule.createDeviceOtpRouter, "function");
  assert.equal(typeof otpModule.createDeviceOtpRouter({ pool: null }), "function");
});
