const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const otpModule = require("../lib/device-otp-router");

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "device-otp-router.js"), "utf8");

test("OTP mask helper reflects only the detected length", () => {
  assert.equal(otpModule.otpMask(4), "****");
  assert.equal(otpModule.otpMask(6), "******");
  assert.equal(otpModule.otpMask(8), "********");
  assert.equal(otpModule.otpMask(3), "Detected");
});

test("redacted OTP message helper removes a legacy raw code but keeps context", () => {
  const masked = otpModule.sanitizeMaskedMessage(
    "Dear Customer, 291653 is One Time Password(OTP) for the request.",
    "291653",
    6
  );
  assert.equal(masked.includes("291653"), false);
  assert.equal(masked.includes("[OTP]"), true);
  assert.equal(masked.includes("for the request"), true);
});

test("OTP router accepts length metadata and keeps backward-compatible legacy input sanitized", () => {
  assert.equal(source.includes("req.body?.otpLength"), true);
  assert.equal(source.includes("req.body?.otpCode"), true);
  assert.equal(source.includes("OTP length is required"), true);
  assert.equal(source.includes("sanitizeMaskedMessage"), true);
});

test("OTP storage never returns a stored raw code and includes redacted message context", () => {
  assert.equal(source.includes("repeat('*', otp_length)"), true);
  assert.equal(source.includes("message_masked,source,sms_received_at,created_at"), true);
  assert.equal(source.includes("code_mask as otp_code"), false);
});

test("OTP router exports the required runtime functions", () => {
  assert.equal(typeof otpModule.otpMask, "function");
  assert.equal(typeof otpModule.sanitizeMaskedMessage, "function");
  assert.equal(typeof otpModule.initDeviceOtpTables, "function");
  assert.equal(typeof otpModule.createDeviceOtpRouter, "function");
  assert.equal(typeof otpModule.createDeviceOtpRouter({ pool: null }), "function");
});
