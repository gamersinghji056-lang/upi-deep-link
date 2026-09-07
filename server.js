const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/vendor/html5-qrcode",
  express.static(path.join(__dirname, "node_modules", "html5-qrcode"))
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "upi-deep-link-checkout" });
});

app.get("/pay", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "pay.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`UPI deep-link checkout listening on port ${port}`);
});
