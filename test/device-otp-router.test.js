const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const otpModule = require("../lib/device-otp-router");

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "device-otp-router.js"), "utf8");

test("legacy dummy OTP masking helpers are removed", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(otpModule, "dummyMask"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(otpModule, "sanitizeOtpMessage"), false);
});

test("OTP router accepts only a validated OTP code", () => {
  assert.equal(source.includes("req.body?.otpCode"), true);
  assert.equal(source.includes("/^\\d{4,8}$/"), true);
  assert.equal(source.includes("expectedMask"), false);
  assert.equal(source.includes("dummyMask"), false);
});

test("OTP storage returns the validated code without SMS content", () => {
  assert.equal(source.includes("values($1,$2,$3,$4,$5,'',$6,$7)"), true);
  assert.equal(source.includes("code_mask as otp_code,otp_length,source,sms_received_at,created_at"), true);
  assert.equal(source.includes("case when device_otp_events.code_mask = '' then excluded.code_mask"), true);
});

test("OTP router exports the required runtime functions", () => {
  assert.equal(typeof otpModule.initDeviceOtpTables, "function");
  assert.equal(typeof otpModule.createDeviceOtpRouter, "function");
  assert.equal(typeof otpModule.createDeviceOtpRouter({ pool: null }), "function");
});