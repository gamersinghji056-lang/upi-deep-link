const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { createApp, initDb } = require("../server");
const raw = "upi://pay?pa=fixture%40bank&pn=A+B&unknown=x%252f&unknown=&mc=1234";

async function exercise(t, pool) {
  // Start with the deployed schema and a legacy record, then apply migration twice.
  await pool.query(`create table payment_links (id text primary key, upi_uri text not null, source text not null default 'merchant', profile text not null default 'scan', amount numeric(14,2), status text not null default 'pending', created_at timestamptz not null default now(), expires_at timestamptz not null default (now() + interval '24 hours'))`);
  await pool.query("insert into payment_links (id, upi_uri) values ($1, $2)", ["WPlegacy01", raw]);
  await initDb(pool);
  await initDb(pool);
  const app = createApp({ pool, env: { NODE_ENV: "development", UPI_DIAGNOSTICS: "1" } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const get = async path => { const r = await fetch(base + path); return { status: r.status, body: await r.json(), headers: r.headers }; };
  const post = async body => { const r = await fetch(base + "/api/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  assert.equal((await get("/health")).status, 200);
  assert.equal((await get("/api/payments/WPlegacy01")).body.upiUri, raw);
  assert.equal((await get("/api/payments/WPlegacy01/diagnostics")).body.originalQr, null);
  for (const [profile, expected] of [[undefined, raw], ["exact", raw], ["amount_only", raw + "&am=10.00"], ["scan", raw + "&am=10.00"], ["standard", raw + "&am=10.00&cu=INR"]]) {
    const created = await post({ upiUri: raw, profile, amount: "10" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.id, /^WP[A-Za-z0-9]{8}$/);
    assert.equal(created.body.url, "/pay/" + created.body.id);
    const loaded = await get("/api/payments/" + created.body.id);
    assert.equal(loaded.body.upiUri, expected);
    assert.equal(loaded.body.status, "pending");
    assert.equal(loaded.body.statusVerified, false);
    assert.equal(loaded.body.originalQr, undefined);
    assert.equal(loaded.headers.get("cache-control"), "no-store");
    const page = await fetch(base + created.body.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="debug" class="debug" hidden/);
    const diagnostic = await get("/api/payments/" + created.body.id + "/diagnostics");
    assert.equal(diagnostic.body.originalQr, raw);
    assert.equal(diagnostic.body.storedUri, expected);
    assert.equal(diagnostic.body.comparisons.androidToGeneric.paytm.equal, true);
  }
  const manual = await post({ upiUri: "upi://pay?pa=fixture%40bank&pn=Manual&am=10.00&cu=INR", source: "manual" });
  assert.equal(manual.status, 201);
  assert.equal((await get("/api/payments/" + manual.body.id)).body.source, "manual");
  await pool.query("update payment_links set expires_at = $1 where id = $2", [new Date(Date.now() - 1000), manual.body.id]);
  assert.equal((await get("/api/payments/" + manual.body.id)).status, 410);
  assert.equal((await fetch(base + "/pay/" + manual.body.id)).status, 410);
  for (const id of ["invalid", "WPmissing1"]) {
    assert.equal((await get("/api/payments/" + id)).status, 404);
    assert.equal((await fetch(base + "/pay/" + id)).status, 404);
  }
  for (const body of [{ upiUri: "https://invalid" }, { upiUri: raw, profile: "typo" }, { upiUri: raw, profile: "amount_only", amount: 0 }, { upiUri: raw + "&sign=test", profile: "standard", amount: 1 }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post({ upiUri: raw, provider: "paytm" })).status, 503);
  assert.equal((await post({ upiUri: raw, provider: "bogus" })).status, 400);
  assert.equal((await fetch(base + "/pay?upi=" + encodeURIComponent(raw))).status, 200);
  assert.equal((await fetch(base + "/vendor/html5-qrcode/html5-qrcode.min.js")).status, 200);
  assert.equal((await fetch(base + "/pay.html.bak")).status, 404);
}

test("real PostgreSQL integration in an isolated test schema", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "upi_test_" + require("node:crypto").randomBytes(8).toString("hex");
  await admin.query('create schema "' + schema + '"');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c search_path=" + schema });
  t.after(async () => { await pool.end(); await admin.query('drop schema "' + schema + '" cascade'); await admin.end(); });
  await exercise(t, pool);
});

test("diagnostics remain off in production, default development and missing DB returns 503", async t => {
  for (const env of [{ NODE_ENV: "production", UPI_DIAGNOSTICS: "1" }, { NODE_ENV: "development" }, {}]) {
    const server = createApp({ env }).listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = "http://127.0.0.1:" + server.address().port;
    assert.equal((await fetch(base + "/api/payments/WPlegacy01/diagnostics?diagnostics=1")).status, 404);
    assert.equal((await fetch(base + "/health")).status, 503);
    assert.equal((await fetch(base + "/api/payments/WPlegacy01")).status, 503);
  }
});
