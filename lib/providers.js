const crypto = require("crypto");
const Upi = require("../public/upi");

function makeTransactionRef() {
  // Numeric, <=35 digits, unique enough for merchant-intent reconciliation.
  return String(Date.now()) + String(crypto.randomInt(100000000, 1000000000));
}

class PaymentProvider {
  async createTransaction(_input) { throw new Error("Provider createTransaction is not implemented"); }
  getIntentUri(_transaction) { throw new Error("Provider getIntentUri is not implemented"); }
  async getStatus(_transaction) { throw new Error("Provider getStatus is not implemented"); }
}

class StaticQrProvider extends PaymentProvider {
  async createTransaction(input) {
    const transactionRef = input.profile === "merchant_intent" ? makeTransactionRef() : null;
    return {
      intentUri: Upi.build(input.upiUri, input.amount, input.profile, transactionRef),
      transactionRef,
      provider: "static_qr",
      status: "pending"
    };
  }
  getIntentUri(transaction) { return transaction.intentUri; }
  async getStatus() { return { status: "unknown", verified: false, reason: "Static QR has no acquiring-bank status API." }; }
}

class PaytmProvider extends PaymentProvider {
  constructor(env = process.env) {
    super();
    this.config = Object.fromEntries(["PAYTM_MID", "PAYTM_MERCHANT_KEY", "PAYTM_WEBSITE_NAME", "PAYTM_CALLBACK_URL", "PAYTM_ENVIRONMENT"].map(key => [key, env[key]]));
  }
  async createTransaction() {
    const missing = Object.keys(this.config).filter(key => !this.config[key]);
    const error = new Error(missing.length
      ? "Paytm API adapter is unavailable. Missing server configuration: " + missing.join(", ") + ". Paytm online merchant UPI_INTENT access is also required."
      : "Paytm configuration is present, but the approved gateway client and verified status integration are not implemented. Paytm activation is blocked.");
    error.status = 503;
    throw error;
  }
  getIntentUri() { throw new Error("No provider-authorized Paytm transaction is available."); }
  async getStatus() { return { status: "unknown", verified: false, reason: "Paytm status integration is not configured." }; }
}

function getProvider(name = "static_qr", env = process.env) {
  if (name === "static_qr") return new StaticQrProvider();
  if (name === "paytm") return new PaytmProvider(env);
  const error = new Error("Unknown payment provider.");
  error.status = 400;
  throw error;
}

module.exports = { PaymentProvider, StaticQrProvider, PaytmProvider, getProvider, makeTransactionRef };
