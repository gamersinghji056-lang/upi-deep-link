const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const { createApp, initDb } = require("./server");
const { initDeviceTables, createDeviceRouter, sha256 } = require("./lib/device-pairing");
const { initDeviceCreditTables, createDeviceCreditRouter } = require("./lib/device-credit-router");
const { initPaymentVerificationTables, createPaymentVerificationRouter } = require("./lib/payment-verification");
const { initDeviceOtpTables, createDeviceOtpRouter } = require("./lib/device-otp-router");
const { initStatementTables, createStatementMatchRouter } = require("./lib/statement-match-router");
const { requireDashboard, loginHandler, logoutHandler } = require("./lib/dashboard-auth");

async function start() {
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
  try {
    await initDb(pool);
    await initDeviceTables(pool);
    await initPaymentVerificationTables(pool);
    await initDeviceCreditTables(pool);
    await initDeviceOtpTables(pool);
    await initStatementTables(pool);

    const coreApp = createApp({ pool, env: process.env });
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "2mb" }));

    app.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
    app.post("/api/dashboard/login", loginHandler(process.env));
    app.post("/api/dashboard/logout", logoutHandler(process.env));

    const dashboardAuth = requireDashboard(process.env);
    app.use((req, res, next) => {
      const dashboardPage = req.method === "GET" && (req.path === "/" || req.path === "/index.html");
      const deviceAdminApi = req.path.startsWith("/api/devices/admin/");
      const statementApi = req.path.startsWith("/api/statements/");
      const createPayment = req.method === "POST" && req.path === "/api/payments";
      const createOrder = req.method === "POST" && req.path === "/api/orders";
      if (dashboardPage || deviceAdminApi || statementApi || createPayment || createOrder) return dashboardAuth(req, res, next);
      next();
    });

    app.post("/api/devices/pairing-token/validate", async (req, res, next) => {
      try {
        if (!pool) return res.status(503).json({ error: "Database is not configured" });
        const code = String(req.body?.pairingCode || "").trim().toUpperCase();
        if (!/^[A-Z2-9]{8}$/.test(code)) return res.status(400).json({ error: "Enter a valid 8-character pairing code" });
        const result = await pool.query(
          `select expires_at from device_pairings where token_hash=$1 and status='pending' and expires_at>now() limit 1`,
          [sha256(code)]
        );
        if (!result.rowCount) return res.status(410).json({ error: "Pairing code is invalid or expired" });
        const expiresInSeconds = Math.max(0, Math.floor((new Date(result.rows[0].expires_at).getTime() - Date.now()) / 1000));
        res.json({ ok: true, status: "pending", expiresInSeconds });
      } catch (error) { next(error); }
    });

    app.use("/api/devices", createDeviceRouter({ pool, env: process.env }));
    app.use("/api/devices", createDeviceCreditRouter({ pool }));
    app.use("/api/devices", createDeviceOtpRouter({ pool }));
    app.use("/api/statements", createStatementMatchRouter({ pool }));
    app.use("/api", createPaymentVerificationRouter({ pool }));
    app.use(coreApp);

    app.use((error, _req, res, _next) => {
      const status = [400, 401, 403, 404, 409, 410, 413, 422, 502, 503].includes(error.status) ? error.status : 500;
      if (status >= 500) console.error("Runtime API request failed", error.code || error.name || "Error", error.message || "");
      res.status(status).json({ error: status === 500 ? "Could not process request" : (error.message || "Request failed") });
    });

    const host = process.env.NODE_ENV === "development" ? "127.0.0.1" : "0.0.0.0";
    const port = process.env.PORT || 3000;
    return app.listen(port, host, () => console.log("UPI checkout + secured device verification API listening on port " + port));
  } catch (error) {
    await pool?.end();
    console.error("Startup failed:", !pool ? "DATABASE_URL is missing" : (error.code || error.name), error.message || "");
    process.exitCode = 1;
  }
}

if (require.main === module) start();
module.exports = { start };
