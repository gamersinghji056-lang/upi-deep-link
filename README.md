# UPI Deep Link Checkout — Test Build

A lightweight test app for:

1. Uploading a UPI QR or entering a UPI ID / `upi://pay?...` URI
2. Entering an amount
3. Generating a shareable checkout URL
4. Showing PhonePe, Paytm, Google Pay, and generic UPI buttons
5. Opening the selected UPI app/deep link

## Important

This build intentionally does **not** verify payment success or failure.

App-specific deep-link handling can vary by OS/browser/app version. The generic `upi://pay?...` button is kept as the fallback.

## Run locally

```powershell
npm install
npm start
```

Open:

```text
http://localhost:3000
```

Health check:

```text
http://localhost:3000/health
```

## Railway

Railway can detect Node.js automatically.

Start command:

```text
npm start
```

No environment variables are required for this test build.
