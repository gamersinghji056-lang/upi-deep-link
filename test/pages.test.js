// DOM/launch unit harness. This does not claim to run Chrome or a real UPI app.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const Upi = require("../public/upi");

function makeClassList() {
  const values = new Set();
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    toggle(name, force) {
      if (force === true) { values.add(name); return true; }
      if (force === false) { values.delete(name); return false; }
      if (values.has(name)) { values.delete(name); return false; }
      values.add(name); return true;
    },
    contains(name) { return values.has(name); }
  };
}

function dom() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: "",
        textContent: "",
        style: {},
        hidden: true,
        disabled: false,
        dataset: {},
        handlers: {},
        innerHTML: "",
        className: "",
        classList: makeClassList(),
        addEventListener(name, handler) { this.handlers[name] = handler; }
      });
    }
    return elements.get(id);
  };
  const buttons = ["phonepe", "paytm"].map(app => {
    const button = element(app);
    button.dataset.app = app;
    button.classList.add("method");
    if (app === "phonepe") button.classList.add("active");
    return button;
  });
  return {
    element,
    document: {
      getElementById: element,
      querySelectorAll: selector => selector.includes(".method") ? buttons : [],
      body: { appendChild() {} },
      createElement: () => ({ style: {}, click() {}, remove() {} })
    }
  };
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
    navigator: { userAgent: "Android", clipboard: { writeText: async () => {}, readText: async () => "" } },
    window: {
      dispatchEvent() {},
      scrollTo() {},
      print() {},
      history: { length: 1, back() {} }
    },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init?.detail; },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    ...extra
  };
}

test("premium checkout loads real payment data and only opens selected PhonePe or Paytm route", async () => {
  const { element, document } = dom();
  const raw = "upi://pay?pa=fixture%40bank&pn=A+B&am=1&x=%252B&x=";
  const location = { pathname: "/pay/WPfixture1", search: "", href: "" };
  const requests = [];

  await vm.runInNewContext(fs.readFileSync("public/checkout.js", "utf8"), contextBase({
    document, location,
    fetch: async url => {
      requests.push(url);
      if (url.endsWith("/verification-status")) return { ok: true, json: async () => ({ status: "awaiting_utr", verified: false }) };
      return { ok: true, json: async () => ({ upiUri: raw, expiresAt: new Date(Date.now() + 60_000).toISOString() }) };
    }
  }));

  assert.deepEqual(requests, ["/api/payments/WPfixture1", "/api/payments/WPfixture1/verification-status"]);
  assert.equal(element("amount").textContent, "₹ 1");
  assert.equal(element("name").textContent, "A+B");
  assert.equal(element("vpa").textContent, "fixture@bank");
  assert.equal(element("debug").hidden, true);

  element("paytm").handlers.click();
  element("openSelected").handlers.click();
  assert.ok(location.href.startsWith("paytmmp://cash_wallet?"));
  assert.ok(location.href.includes("pa=fixture%40bank"));

  location.href = "";
  element("phonepe").handlers.click();
  element("openSelected").handlers.click();
  assert.ok(location.href.startsWith("phonepe://native?"));
  assert.ok(location.href.includes("id=p2ppayment"));
  assert.equal(requests.length, 2); // App handoff itself never writes payment success.
});

test("12-digit UTR alone stays pending and cannot display payment success", async () => {
  const { element, document } = dom();
  const raw = "upi://pay?pa=fixture%40bank&pn=Fixture&am=5";
  const location = { pathname: "/pay/WPfixture1", search: "", href: "" };
  let submittedBody = null;

  await vm.runInNewContext(fs.readFileSync("public/checkout.js", "utf8"), contextBase({
    document, location,
    fetch: async (url, request = {}) => {
      if (url.endsWith("/verification-status")) return { ok: true, json: async () => ({ status: "awaiting_utr", verified: false }) };
      if (url.endsWith("/utr")) {
        submittedBody = JSON.parse(request.body);
        return { ok: true, status: 202, json: async () => ({ status: "pending", verified: false, message: "Waiting for credit confirmation" }) };
      }
      return { ok: true, json: async () => ({ upiUri: raw, expiresAt: new Date(Date.now() + 60_000).toISOString() }) };
    }
  }));

  element("utrInput").value = "123456789012";
  await element("submitUtr").handlers.click();

  assert.deepEqual(submittedBody, { utr: "123456789012" });
  assert.equal(element("success").hidden, true);
  assert.equal(element("success").classList.contains("show"), false);
  assert.match(element("verificationState").textContent, /Waiting for credit confirmation/i);
});

test("success screen appears only when backend independently returns verified success", async () => {
  const { element, document } = dom();
  const raw = "upi://pay?pa=fixture%40bank&pn=Fixture&am=5";
  const location = { pathname: "/pay/WPfixture1", search: "", href: "" };

  await vm.runInNewContext(fs.readFileSync("public/checkout.js", "utf8"), contextBase({
    document, location,
    fetch: async (url) => {
      if (url.endsWith("/verification-status")) return { ok: true, json: async () => ({ status: "awaiting_utr", verified: false }) };
      if (url.endsWith("/utr")) return { ok: true, status: 200, json: async () => ({ status: "success", verified: true }) };
      return { ok: true, json: async () => ({ upiUri: raw, expiresAt: new Date(Date.now() + 60_000).toISOString() }) };
    }
  }));

  element("utrInput").value = "123456789012";
  await element("submitUtr").handlers.click();

  assert.equal(element("checkout").hidden, true);
  assert.equal(element("success").hidden, false);
  assert.equal(element("success").classList.contains("show"), true);
  assert.equal(element("successUtr").textContent, "123456789012");
  assert.equal(element("successAmount").textContent, "₹ 5");
});

test("checkout rejects stale expiry before app navigation or UTR verification", async () => {
  const { element, document } = dom();
  const location = { pathname: "/pay/WPfixture1", search: "", href: "" };
  await vm.runInNewContext(fs.readFileSync("public/checkout.js", "utf8"), contextBase({
    document, location,
    fetch: async url => url.endsWith("/verification-status")
      ? ({ ok: true, json: async () => ({ status: "awaiting_utr", verified: false }) })
      : ({ ok: true, json: async () => ({ upiUri: "upi://pay?pa=fixture@bank&am=1", expiresAt: new Date(0).toISOString() }) })
  }));

  element("openSelected").handlers.click();
  assert.equal(location.href, "");
  assert.equal(element("utrInput").disabled, true);
  assert.match(element("verificationState").textContent, /expired/i);
});

test("legacy URI envelope still decodes once and renders the premium checkout", async () => {
  const { element, document } = dom();
  const raw = "upi://pay?pa=fixture%40bank&pn=A+B%20C&am=1&x=%252F";
  const location = { pathname: "/pay", search: "?upi=" + encodeURIComponent(raw), href: "" };
  await vm.runInNewContext(fs.readFileSync("public/checkout.js", "utf8"), contextBase({ document, location }));
  assert.equal(element("vpa").textContent, "fixture@bank");
  assert.equal(element("name").textContent, "A+B C");
  assert.equal(element("amount").textContent, "₹ 1");
});

test("checkout HTML preserves the supplied dark 3D structure while wiring dynamic production IDs", () => {
  const html = fs.readFileSync("public/pay.html", "utf8");
  assert.match(html, /Payments<br>Made <span>Simple<\/span>/);
  assert.match(html, /Choose Payment Method/);
  assert.match(html, /Scan QR Code & Pay/);
  assert.match(html, /Enter UTR & Verify/);
  assert.match(html, /id="success"/);
  assert.match(html, /id="openSelected"/);
  assert.match(html, /id="verificationState"/);
  assert.match(html, /id="debug" class="debug" hidden/);
});

test("QR decoder output reaches POST unchanged and manual VPA creation remains available", async () => {
  const { element, document } = dom();
  const raw = "upi://pay?pa=fixture%40bank&pn=A+B&x=%2b&x=&sign=fixture";
  const bodies = [];
  class Decoder { async scanFile() { return raw; } clear() {} }
  vm.runInNewContext(fs.readFileSync("public/generator.js", "utf8"), {
    Upi, document, URL, location: { origin: "https://pay.wtron.org" }, navigator: {}, Html5Qrcode: Decoder,
    fetch: async (_url, request) => {
      bodies.push(JSON.parse(request.body));
      return { ok: true, json: async () => ({ id: "WPfixture1", url: "/pay/WPfixture1", profile: "exact", expiresIn: "24h" }) };
    }
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
