const crypto = require("crypto");

const COOKIE_NAME = "wpay_dashboard_session";
const SESSION_MS = 12 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function credentials(env = process.env) {
  const username = String(env.DASHBOARD_USERNAME || "admin");
  const password = String(env.DASHBOARD_PASSWORD || env.DASHBOARD_DEVICE_KEY || "");
  const secret = String(env.DASHBOARD_SESSION_SECRET || password || "wpay-local-dev-secret");
  return { username, password, secret };
}

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("base64url");
}

function makeSession(env = process.env) {
  const { secret } = credentials(env);
  const expiresAt = Date.now() + SESSION_MS;
  const payload = String(expiresAt);
  return payload + "." + sign(payload, secret);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers?.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function validSession(req, env = process.env) {
  const { password, secret } = credentials(env);
  if (!password) return false;
  const raw = parseCookies(req)[COOKIE_NAME] || "";
  const [expiresRaw, signature] = raw.split(".");
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || !signature) return false;
  return safeEqual(signature, sign(expiresRaw, secret));
}

function requireDashboard(env = process.env) {
  return (req, res, next) => {
    const { password } = credentials(env);
    if (!password && env.NODE_ENV !== "production") return next();
    if (!password) return res.status(503).json({ error: "Dashboard password is not configured" });
    if (validSession(req, env)) return next();
    if (req.path.startsWith("/api/") || req.originalUrl.startsWith("/api/")) {
      return res.status(401).json({ error: "Dashboard login required" });
    }
    res.redirect("/login");
  };
}

function loginHandler(env = process.env) {
  return (req, res) => {
    const { username, password } = credentials(env);
    if (!password) return res.status(503).json({ error: "Dashboard password is not configured" });
    const suppliedUser = String(req.body?.username || "");
    const suppliedPassword = String(req.body?.password || "");
    if (!safeEqual(suppliedUser, username) || !safeEqual(suppliedPassword, password)) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const secure = env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(makeSession(env))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`);
    res.json({ ok: true });
  };
}

function logoutHandler(_env = process.env) {
  return (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  };
}

module.exports = { COOKIE_NAME, credentials, validSession, requireDashboard, loginHandler, logoutHandler };
