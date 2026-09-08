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

test("OTP router ignores legacy OTP content fields", () => {
  assert.equal(source.includes("req.body?.codeMask"), false);
  assert.equal(source.includes("req.body?.messageMasked"), false);
  assert.equal(source.includes("expectedMask"), false);
  assert.equal(source.includes("dummyMask"), false);
});

test("OTP storage keeps legacy columns neutral for schema compatibility", () => {
  assert.equal(source.includes("values($1,$2,$3,'',0,'',$4,$5)"), true);
  assert.equal(source.includes("select id,sender,source,sms_received_at,created_at"), true);
});

test("OTP router exports the required runtime functions", () => {
  assert.equal(typeof otpModule.initDeviceOtpTables, "function");
  assert.equal(typeof otpModule.createDeviceOtpRouter, "function");
  assert.equal(typeof otpModule.createDeviceOtpRouter({ pool: null }), "function");
});