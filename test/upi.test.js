const { test } = require("node:test");
const assert = require("node:assert/strict");
const Upi = require("../public/upi");
const { diagnose, compare } = require("../lib/diagnostics");
const { StaticQrProvider, PaytmProvider, getProvider } = require("../lib/providers");

// Synthetic fixtures only: not a real merchant account, payment or signature.
const raw = "upi://pay?pa=fixture%40bank&pn=A+B%20C&mc=1234&tr=issuer%2fref&tid=t&mode=02&orgid=issuer&purpose=00&url=https%3A%2F%2Fexample.invalid%2F%3Fx%3D%252B&extra=&extra=two%2b&tn=note&";
test("EXACT preserves every character, order, duplicates, plus, casing, empty and unknown values", () => {
  assert.equal(Upi.build(raw, "10", "exact"), raw);
  assert.equal(Upi.build(raw, undefined, undefined), raw);
  assert.equal(JSON.parse(JSON.stringify({ raw })).raw, raw);
  assert.equal(Upi.parse(raw).fields.pn[0], "A+B C");
  assert.equal(Upi.parse(raw).entries[1].formValue, "A B C");
  assert.equal(Upi.parse(raw).unknown.filter(e => e.key === "extra").length, 2);
});
test("B and C only append missing fields, including legacy scan alias", () => {
  assert.equal(Upi.build(raw, "10", "amount_only"), raw + "am=10.00");
  assert.equal(Upi.build(raw, "10", "scan"), raw + "am=10.00");
  assert.equal(Upi.build(raw, "10", "standard"), raw + "am=10.00&cu=INR");
  assert.equal(Upi.build(raw + "am=001.20&cu=INR", "20", "standard"), raw + "am=001.20&cu=INR");
  for (const value of ["", "0", "invalid", "1&am=2"]) {
    const existing = raw + "am=" + value;
    assert.equal(Upi.build(existing, "20", "amount_only"), existing);
  }
  assert.throws(() => Upi.build(raw, "0", "amount_only"));
  assert.throws(() => Upi.build(raw, "1.001", "standard"));
  assert.throws(() => Upi.build(raw, "10", "typo"));
});
test("signed QR is never edited, even when sign is empty or encoded", () => {
  for (const sign of ["sign=fixture%2Bsignature", "%73ign=", "SIGN=test"]) {
    const signed = raw + sign;
    assert.equal(Upi.build(signed, "10", "exact"), signed);
    assert.throws(() => Upi.build(signed, "10", "standard"), /Signed QR/);
    assert.equal(Upi.build(signed + "&am=2&cu=INR", "10", "standard"), signed + "&am=2&cu=INR");
  }
});
test("Android targets round-trip the entire UPI URI without touching the query", () => {
  const targets = Upi.targets(raw);
  assert.equal(targets.generic, raw);
  for (const [app, pkg] of Object.entries(Upi.packages)) {
    const intent = targets.android[app];
    assert.ok(intent.includes(";package=" + pkg + ";"));
    assert.equal("upi:" + intent.slice(7, intent.indexOf("#Intent;")), raw);
    assert.equal(new URL(intent).href, intent);
    assert.equal(Upi.target(raw, app, "Android"), intent);
  }
  assert.equal(Upi.target(raw, "generic", "Android"), raw);
  assert.equal(targets.ios.gpay, "gpay://upi/pay?" + raw.slice(10));
});
test("fragment and unusual scheme casing use unchanged generic fallback", () => {
  for (const uri of [raw + "#original", raw.replace("upi", "UPI")]) {
    assert.equal(Upi.targets(uri).android.paytm, null);
    assert.equal(Upi.target(uri, "paytm", "Android"), uri);
  }
  assert.throws(() => Upi.parse(" " + raw));
  assert.throws(() => Upi.parse(raw + "\n"));
  assert.throws(() => Upi.parse("https://example.invalid?pa=fixture@bank"));
});
test("manual VPA mode uses percent encoding and marks the app-handoff intent channel", () => {
  const uri = Upi.manual("fixture@bank", "A + B", "10", "a&b");
  assert.equal(uri, "upi://pay?pa=fixture%40bank&pn=A%20%2B%20B&am=10.00&cu=INR&mode=04&tn=a%26b");
});
test("diagnostics hashes, character differences, original unknown and browser normalization", () => {
  const report = diagnose({ original_upi_uri: raw, upi_uri: raw, source: "merchant", profile: "exact", requested_amount: "10" });
  assert.equal(report.comparisons.originalToStored.equal, true);
  assert.equal(report.comparisons.storedToGeneric.equal, true);
  assert.equal(report.comparisons.androidToGeneric.phonepe.equal, true);
  assert.equal(report.hashes.original.sha256, report.hashes.generic.sha256);
  assert.equal(report.variants.amount_only.uri, raw + "am=10.00");
  assert.equal(compare("a+b", "a b").differences[0].characterIndex, 1);
  assert.equal(diagnose({ upi_uri: raw }).comparisons.originalToStored.available, false);
  assert.ok(diagnose({ upi_uri: raw + "&pn=नाम" }).warnings.some(w => w.includes("serialization")));
});
test("providers never claim payment success or fake a configured Paytm integration", async () => {
  const provider = new StaticQrProvider();
  const tx = await provider.createTransaction({ upiUri: raw, profile: "exact" });
  assert.equal(provider.getIntentUri(tx), raw);
  assert.deepEqual((await provider.getStatus()).verified, false);
  await assert.rejects(() => new PaytmProvider({}).createTransaction(), /PAYTM_MID/);
  const env = Object.fromEntries(["PAYTM_MID", "PAYTM_MERCHANT_KEY", "PAYTM_WEBSITE_NAME", "PAYTM_CALLBACK_URL", "PAYTM_ENVIRONMENT"].map(k => [k, "fixture"]));
  await assert.rejects(() => new PaytmProvider(env).createTransaction(), /not implemented/);
  assert.throws(() => getProvider("untrusted"), /Unknown/);
});
