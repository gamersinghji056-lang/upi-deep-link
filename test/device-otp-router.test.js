const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const otpModule = require("../lib/device-otp-router");

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "device-otp-router.js"), "utf8");

test("OTP mask helper can expose only the last two digits", () => {
  assert.equal(otpModule.otpMask(4), "****");
  assert.equal(otpModule.otpMask(6), "******");
  assert.equal(otpModule.otpMask(8), "********");
  assert.equal(otpModule.otpMask(6, "78"), "****78");
  assert.equal(otpModule.otpMask(4, "42"), "**42");
  assert.equal(otpModule.otpMask(3), "Detected");
});

test("partial mask sanitizer accepts only the expected safe shape", () => {
  assert.equal(otpModule.sanitizeCodeMask("****78", 6), "****78");
  assert.equal(otpModule.sanitizeCodeMask("123478", 6), "******");
  assert.equal(otpModule.sanitizeCodeMask("**78", 6), "******");
  assert.equal(otpModule.sanitizeCodeMask("", 6, "123478"), "****78");
});

test("OTP message helper keeps full context while masking a legacy raw code", () => {
  const masked = otpModule.sanitizeMaskedMessage(
    "Dear Customer, 291653 is One Time Password(OTP) for the request.",
    "291653",
    6
  );
  assert.equal(masked.includes("291653"), false);
  assert.equal(masked.includes("****53"), true);
  assert.equal(masked.includes("for the request"), true);
});

test("OTP router accepts length metadata and safe partial code mask", () => {
  assert.equal(source.includes("req.body?.otpLength"), true);
  assert.equal(source.includes("req.body?.codeMask"), true);
  assert.equal(source.includes("req.body?.otpCode"), true);
  assert.equal(source.includes("OTP length is required"), true);
  assert.equal(source.includes("sanitizeMaskedMessage"), true);
});

test("OTP dashboard returns only the stored masked code and message context", () => {
  assert.equal(source.includes("code_mask as otp_code"), true);
  assert.equal(source.includes("message_masked,source,sms_received_at,created_at"), true);
  assert.equal(source.includes("select id,sender,code_mask as otp_code"), true);
});

test("OTP router exports the required runtime functions", () => {
  assert.equal(typeof otpModule.otpMask, "function");
  assert.equal(typeof otpModule.sanitizeCodeMask, "function");
  assert.equal(typeof otpModule.sanitizeMaskedMessage, "function");
  assert.equal(typeof otpModule.initDeviceOtpTables, "function");
  assert.equal(typeof otpModule.createDeviceOtpRouter, "function");
  assert.equal(typeof otpModule.createDeviceOtpRouter({ pool: null }), "function");
});
