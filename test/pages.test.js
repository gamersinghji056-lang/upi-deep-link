// DOM/launch unit harness. This does not claim to run Chrome or a real UPI app.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const Upi = require("../public/upi");
function dom() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", style: {}, hidden: true, dataset: {}, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } });
    return elements.get(id);
  };
  const buttons = ["generic", "phonepe", "gpay", "paytm"].map(app => { const button = element(app); button.dataset.app = app; return button; });
  return { element, document: { getElementById: element, querySelectorAll: () => buttons } };
}
test("checkout assigns byte-identical payloads at each Android button and never marks success", async () => {
  const { element, document } = dom();
  const raw = "upi://pay?pa=fixture%40bank&pn=A+B&am=1&x=%252B&x=";
  const location = { pathname: "/pay/WPfixture1", search: "", href: "" };
  const requests = [];
  await vm.runInNewContext(fs.readFileSync("public/checkout.js", "utf8"), {
    Upi, document, location, URL, URLSearchParams, navigator: { userAgent: "Android" },
    fetch: async url => { requests.push(url); return { ok: true, json: async () => ({ upiUri: raw, expiresAt: new Date(Date.now() + 10000).toISOString() }) }; }
  });
  assert.deepEqual(requests, ["/api/payments/WPfixture1"]);
  assert.equal(element("debug").hidden, true);
  for (const app of ["generic", "phonepe", "gpay", "paytm"]) {
    element(app).handlers.click();
    assert.equal(location.href, Upi.target(raw, app, "Android"));
  }
  assert.equal(requests.length, 1); // No callback writes / success requests.
});
test("checkout rejects stale expiry and browser normalization without navigating", async () => {
  for (const data of [
    { upiUri: "upi://pay?pa=fixture@bank", expiresAt: new Date(0).toISOString() },
    { upiUri: "upi://pay?pa=fixture@bank&pn=नाम" }
  ]) {
    const { element, document } = dom();
    const location = { pathname: "/pay/WPfixture1", search: "", href: "" };
    await vm.runInNewContext(fs.readFileSync("public/checkout.js", "utf8"), { Upi, document, location, URL, URLSearchParams, navigator: { userAgent: "Android" }, fetch: async () => ({ ok: true, json: async () => data }) });
    element("generic").handlers.click();
    assert.equal(location.href, "");
    assert.ok(element("error").textContent);
  }
});
test("legacy URI envelope decodes once, preserving inner literal plus and percent escapes", async () => {
  const { element, document } = dom();
  const raw = "upi://pay?pa=fixture%40bank&pn=A+B%20C&x=%252F";
  const location = { pathname: "/pay", search: "?upi=" + encodeURIComponent(raw), href: "" };
  await vm.runInNewContext(fs.readFileSync("public/checkout.js", "utf8"), { Upi, document, location, URL, URLSearchParams, navigator: { userAgent: "Android" } });
  element("generic").handlers.click();
  assert.equal(location.href, raw);
});
test("QR decoder output reaches POST unchanged and manual VPA creation remains available", async () => {
  const { element, document } = dom();
  const raw = "upi://pay?pa=fixture%40bank&pn=A+B&x=%2b&x=&sign=fixture";
  const bodies = [];
  class Decoder { async scanFile() { return raw; } clear() {} }
  vm.runInNewContext(fs.readFileSync("public/generator.js", "utf8"), {
    Upi, document, URL, location: { origin: "https://pay.wtron.org" }, navigator: {}, Html5Qrcode: Decoder,
    fetch: async (_url, request) => { bodies.push(JSON.parse(request.body)); return { ok: true, json: async () => ({ id: "WPfixture1", url: "/pay/WPfixture1", profile: "exact", expiresIn: "24h" }) }; }
  });
  element("profile").value = "exact";
  element("qrFile").files = [{}];
  await element("qrFile").handlers.change();
  await element("form").handlers.submit({ preventDefault() {} });
  assert.equal(bodies[0].upiUri, raw);
  assert.equal(element("checkout").value, "https://pay.wtron.org/pay/WPfixture1");
  element("upiInput").value = "manual@bank";
  element("upiInput").handlers.input();
  element("am").value = "10";
  await element("form").handlers.submit({ preventDefault() {} });
  assert.equal(bodies[1].source, "manual");
  assert.ok(bodies[1].upiUri.includes("am=10.00"));
  assert.ok(!bodies[1].upiUri.includes("sign="));
});
