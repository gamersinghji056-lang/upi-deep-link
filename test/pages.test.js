// DOM/launch unit harness. This does not claim to run Chrome or a real UPI app.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const Upi = require("../public/upi");
function dom() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", style: {}, hidden: true, disabled: false, dataset: {}, handlers: {}, innerHTML: "", addEventListener(name, handler) { this.handlers[name] = handler; } });
    return elements.get(id);
  };
  // Match the actual current checkout: direct buttons are PhonePe and Paytm.
  const buttons = ["phonepe", "paytm"].map(app => { const button = element(app); button.dataset.app = app; return button; });
  return { element, document: { getElementById: element, querySelectorAll: () => buttons } };
}
function contextBase(extra = {}) {
  return {
    Upi,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    atob,
    btoa,
    navigator: { userAgent: "Android" },
    window: { dispatchEvent() {} },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init?.detail; },
    setInterval: () => 1,
    clearInterval() {},
    ...extra
  };
}
test("checkout loads payment, checks verification status and only launches supported apps", async () => {
  const { element, document } = dom();
  const raw = "upi://pay?pa=fixture%40bank&pn=A+B&am=1&x=%252B&x=";
  const location = { pathname: "/pay/WPfixture1", search: "", href: "" };
  const requests = [];
  await vm.runInNewContext(fs.readFileSync("public/checkout.js", "utf8"), contextBase({
    document, location,
    fetch: async url => {
      requests.push(url);
      if (url.endsWith("/verification-status")) return { ok: true, json: async () => ({ status: "awaiting_utr", verified: false }) };
      return { ok: true, json: async () => ({ upiUri: raw, expiresAt: new Date(Date.now() + 10000).toISOString() }) };
    }
  }));
  assert.deepEqual(requests, ["/api/payments/WPfixture1", "/api/payments/WPfixture1/verification-status"]);
  assert.equal(element("debug").hidden, true);

  element("phonepe").handlers.click();
  assert.ok(location.href.startsWith("phonepe://native?"));
  assert.ok(location.href.includes("id=p2ppayment"));

  element("paytm").handlers.click();
  assert.ok(location.href.startsWith("paytmmp://cash_wallet?"));
  assert.ok(location.href.includes("pa=fixture%40bank"));
  assert.equal(requests.length, 2); // App launch itself does not write success.
});
test("checkout rejects stale expiry before direct app navigation", async () => {
  const { element, document } = dom();
  const location = { pathname: "/pay/WPfixture1", search: "", href: "" };
  await vm.runInNewContext(fs.readFileSync("public/checkout.js", "utf8"), contextBase({
    document, location,
    fetch: async url => url.endsWith("/verification-status")
      ? ({ ok: true, json: async () => ({ status: "awaiting_utr", verified: false }) })
      : ({ ok: true, json: async () => ({ upiUri: "upi://pay?pa=fixture@bank&am=1", expiresAt: new Date(0).toISOString() }) })
  }));
  element("phonepe").handlers.click();
  assert.equal(location.href, "");
  assert.ok(element("error").textContent);
});
test("legacy URI envelope decodes once and renders decoded payment data", async () => {
  const { element, document } = dom();
  const raw = "upi://pay?pa=fixture%40bank&pn=A+B%20C&am=1&x=%252F";
  const location = { pathname: "/pay", search: "?upi=" + encodeURIComponent(raw), href: "" };
  await vm.runInNewContext(fs.readFileSync("public/checkout.js", "utf8"), contextBase({ document, location }));
  assert.equal(element("vpa").textContent, "fixture@bank");
  assert.equal(element("name").textContent, "A+B C");
  assert.equal(element("amount").textContent, "INR 1.00");
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
  assert.ok(bodies[1].upiUri.includes("mode=04"));
  assert.ok(!bodies[1].upiUri.includes("sign="));
});
