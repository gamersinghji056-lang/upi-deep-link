const { Pool } = require("pg");
const { createApp, initDb } = require("./server");
const { initDeviceTables, createDeviceRouter } = require("./lib/device-pairing");
const { createDeviceCreditRouter } = require("./lib/device-credit-router");
const { initPaymentVerificationTables, createPaymentVerificationRouter } = require("./lib/payment-verification");

async function start() {
  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
  try {
    await initDb(pool);
    await initDeviceTables(pool);
    await initPaymentVerificationTables(pool);

    const app = createApp({ pool, env: process.env });
    app.use("/api/devices", createDeviceRouter({ pool, env: process.env }));
    app.use("/api/devices", createDeviceCreditRouter({ pool }));
    app.use("/api", createPaymentVerificationRouter({ pool }));
    app.use((error, _req, res, _next) => {
      const status = [400, 401, 403, 404, 409, 410, 413, 422, 502, 503].includes(error.status) ? error.status : 500;
      if (status >= 500) console.error("Runtime API request failed", error.code || error.name || "Error", error.message || "");
      res.status(status).json({ error: status === 500 ? "Could not process request" : (error.message || "Request failed") });
    });

    const host = process.env.NODE_ENV === "development" ? "127.0.0.1" : "0.0.0.0";
    const port = process.env.PORT || 3000;
    return app.listen(port, host, () => console.log("UPI checkout + device verification API listening on port " + port));
  } catch (error) {
    await pool?.end();
    console.error("Startup failed:", !pool ? "DATABASE_URL is missing" : (error.code || error.name), error.message || "");
    process.exitCode = 1;
  }
}

if (require.main === module) start();
module.exports = { start };
