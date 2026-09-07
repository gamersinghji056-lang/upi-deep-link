// Isolated real PostgreSQL; never reads DATABASE_URL or uses Railway.
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function run(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, stdio: "inherit", ...options });
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code)); });
  return { child, done };
}
async function main() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const tempRoot = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(tempRoot, "upi-checkout-test-"));
  const pgPort = await freePort();
  const password = crypto.randomBytes(16).toString("hex");
  const database = new EmbeddedPostgres({ databaseDir: directory, port: pgPort, user: "postgres", password, persistent: true, createPostgresUser: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-h", "127.0.0.1", "-c", "io_method=sync"], onLog: () => {}, onError: () => {} });
  let service;
  try {
    await database.initialise();
    await database.start();
    const url = "postgresql://postgres:" + password + "@127.0.0.1:" + pgPort + "/postgres";
    const client = database.getPgClient();
    await client.connect();
    console.log("Test database:", (await client.query("select version() as version")).rows[0].version);
    await client.end();
    const env = { ...process.env, TEST_DATABASE_URL: url, DATABASE_URL: url, NODE_ENV: "development", UPI_DIAGNOSTICS: "1" };
    const testFiles = require("node:fs").readdirSync("test").filter(file => file.endsWith(".test.js")).map(file => "test/" + file);
    const result = await run(process.execPath, ["--test", ...testFiles], { env }).done;
    assert.equal(result, 0, "Automated tests failed");

    const port = await freePort();
    // Exercise the literal package start script through npm, with a disposable DB.
    assert.ok(process.env.npm_execpath, "Run through npm test so npm start can be verified.");
    service = run(process.execPath, [process.env.npm_execpath, "start"], { env: { ...env, PORT: String(port) }, detached: process.platform !== "win32" });
    const base = "http://127.0.0.1:" + port;
    let healthy = false;
    for (let i = 0; i < 100; i++) {
      try { healthy = (await fetch(base + "/health")).ok; if (healthy) break; } catch { /* Starting. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(healthy, "npm start failed to become healthy");
    const created = await fetch(base + "/api/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ upiUri: "upi://pay?pa=fixture%40bank&pn=Fixture%20Merchant", profile: "exact" }) });
    assert.equal(created.status, 201);
    const record = await created.json();
    assert.equal((await fetch(base + "/api/payments/" + record.id)).status, 200);
    assert.equal((await fetch(base + "/pay/" + record.id)).status, 200);
    console.log("npm start smoke: health, POST, GET, /pay/WPxxxxxxxx passed on real local PostgreSQL");
  } finally {
    if (service?.child.pid) {
      if (process.platform === "win32") await run("taskkill", ["/PID", String(service.child.pid), "/T", "/F"], { stdio: "ignore" }).done;
      else process.kill(-service.child.pid, "SIGTERM");
      await service.done;
    }
    await database.stop();
    // Validate the exact generated target before recursive cleanup on Windows.
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("upi-checkout-test-")) throw new Error("Unsafe test cleanup target");
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exit(1); });
