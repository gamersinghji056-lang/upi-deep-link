const test = require("node:test");
const assert = require("node:assert/strict");
const { dummyMask, sanitizeOtpMessage } = require("../lib/device-otp-router");

test("dummy OTP mask preserves requested length", () => {
  assert.equal(dummyMask(4), "1234");
  assert.equal(dummyMask(5), "12345");
  assert.equal(dummyMask(6), "123456");
  assert.equal(dummyMask(8), "12345678");
});

test("server sanitizer removes real OTP but preserves other banking numbers", () => {
  const source = "Dear Customer,991499 is OTP to approve IMPS Fund trf of Rs.11.00 from A/c ending 05057 to Vishvajeet.";
  const masked = sanitizeOtpMessage(source);
  assert.equal(masked.includes("991499"), false);
  assert.equal(masked.includes("123456 is OTP"), true);
  assert.equal(masked.includes("Rs.11.00"), true);
  assert.equal(masked.includes("05057"), true);
});

test("server sanitizer handles OTP after label", () => {
  const masked = sanitizeOtpMessage("Your verification code is 84726190. Valid for 5 minutes.");
  assert.equal(masked, "Your verification code is 12345678. Valid for 5 minutes.");
});
