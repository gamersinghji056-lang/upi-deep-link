"use strict";

const PHONEPE_HOSTS = {
  sandbox: {
    auth: "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token",
    api: "https://api-preprod.phonepe.com/apis/pg-sandbox"
  },
  production: {
    auth: "https://api.phonepe.com/apis/identity-manager/v1/oauth/token",
    api: "https://api.phonepe.com/apis/pg"
  }
};

class PhonePePgClient {
  constructor(env = process.env) {
    this.env = env;
    this.environment = String(env.PHONEPE_ENVIRONMENT || "sandbox").toLowerCase();
    this.clientId = env.PHONEPE_CLIENT_ID;
    this.clientSecret = env.PHONEPE_CLIENT_SECRET;
    this.clientVersion = env.PHONEPE_CLIENT_VERSION;
    this.merchantId = env.PHONEPE_MERCHANT_ID || "";
    this.token = null;
    this.expiresAt = 0;
  }

  missingConfig() {
    return [
      ["PHONEPE_CLIENT_ID", this.clientId],
      ["PHONEPE_CLIENT_SECRET", this.clientSecret],
      ["PHONEPE_CLIENT_VERSION", this.clientVersion]
    ].filter(([, value]) => !value).map(([key]) => key);
  }

  get hosts() {
    const hosts = PHONEPE_HOSTS[this.environment];
    if (!hosts) throw Object.assign(new Error("PHONEPE_ENVIRONMENT must be sandbox or production"), { status: 500 });
    return hosts;
  }

  async getAccessToken() {
    const missing = this.missingConfig();
    if (missing.length) {
      const error = new Error("PhonePe PG is not configured. Missing: " + missing.join(", "));
      error.status = 503;
      throw error;
    }
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.expiresAt > now + 60) return this.token;

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_version: this.clientVersion,
      client_secret: this.clientSecret,
      grant_type: "client_credentials"
    });
    const response = await fetch(this.hosts.auth, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      const error = new Error("PhonePe authorization failed");
      error.status = 502;
      error.providerStatus = response.status;
      throw error;
    }
    this.token = data.access_token;
    this.expiresAt = Number(data.expires_at || 0);
    return this.token;
  }

  async request(path, { method = "GET", body } = {}) {
    const token = await this.getAccessToken();
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "O-Bearer " + token
    };
    if (this.merchantId) headers["X-MERCHANT-ID"] = this.merchantId;
    const response = await fetch(this.hosts.api + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error("PhonePe API request failed");
      error.status = 502;
      error.providerStatus = response.status;
      error.providerResponse = data;
      throw error;
    }
    return data;
  }

  async createUpiIntent({ merchantOrderId, amountPaisa, deviceOS = "ANDROID" }) {
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(merchantOrderId)) throw Object.assign(new Error("Invalid merchant order id"), { status: 400 });
    if (!Number.isInteger(amountPaisa) || amountPaisa < 100) throw Object.assign(new Error("Amount must be at least INR 1.00"), { status: 400 });
    const os = String(deviceOS).toUpperCase() === "IOS" ? "IOS" : "ANDROID";
    const targetApp = os === "IOS" ? "PHONEPE" : "com.phonepe.app";
    return this.request("/payments/v2/pay", {
      method: "POST",
      body: {
        merchantOrderId,
        amount: amountPaisa,
        expireAfter: 600,
        deviceContext: { deviceOS: os },
        paymentFlow: {
          type: "PG",
          paymentMode: { type: "UPI_INTENT", targetApp }
        }
      }
    });
  }

  async getOrderStatus(merchantOrderId) {
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(merchantOrderId)) throw Object.assign(new Error("Invalid merchant order id"), { status: 400 });
    return this.request("/payments/v2/order/" + encodeURIComponent(merchantOrderId) + "/status?details=true&errorContext=true");
  }
}

module.exports = { PhonePePgClient };
