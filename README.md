# UPI checkout with PostgreSQL short links

QR upload/decoding, manual VPA entry, persistent `WPxxxxxxxx` payment links, legacy checkout links, and generic/PhonePe/Google Pay/Paytm launch buttons. Railway, PostgreSQL and `https://pay.wtron.org` remain the production architecture.

This app does not verify payment success. Returning from a UPI app never changes payment status. The Paytm provider is a **disabled scaffold**, not a working gateway integration. See [the investigation](docs/upi-investigation.md) for evidence, payload traces, official sources and remaining API requirements.

## Run

```powershell
npm install
$env:DATABASE_URL = '<your local PostgreSQL connection URL>'
$env:NODE_ENV = 'development'
npm start
```

Open `http://127.0.0.1:3000`. `/health` checks the database. Startup requires DATABASE_URL; no in-memory production fallback is used. Environment variables must be set in the shell or Railway; `.env` is not auto-loaded. See [.env.example](.env.example). Keep production `PUBLIC_BASE_URL=https://pay.wtron.org` and start command `npm start`.

Startup adds `original_upi_uri`, `requested_amount` and `provider` columns if absent. It never deletes, backfills or rebuilds existing payment links. Legacy rows cannot prove original QR equality because that data was not recorded.

## A/B modes

| API profile | Behavior for merchant QR |
| --- | --- |
| `exact` (default) | Return the raw string unchanged, including when no amount is present. |
| `amount_only` | Append `am` only if absent. Existing values, including empty values, remain. |
| `standard` | Append only missing `am` and `cu=INR`. |
| `scan` | Backward-compatible alias for `amount_only`; does not promise scan context. |

No mode creates merchant metadata. A mode which would change a signed QR returns 400 and directs the operator to EXACT or a provider-issued intent. Merchant name/note edits do not rewrite QR fields. Manual VPA mode constructs pa/pn/am/cu and optional tn using percent encoding.

`POST /api/payments` accepts `{ upiUri, amount, profile, source }` and returns `{ id, url, expiresIn, profile, provider }`. `source` is `merchant` or `manual`. Production links use the configured base URL; local development links are relative and the generator resolves them against its origin. `GET /api/payments/:id` returns the stored final URI. Missing/invalid links return 404; expired links return 410. Existing links expire after 24 hours.

## Local diagnostics

```powershell
$env:NODE_ENV = 'development'
$env:UPI_DIAGNOSTICS = '1'
npm start
```

Create a new link, then open `/pay/WPxxxxxxxx?diagnostics=1` on `127.0.0.1`. The raw JSON report is also available at `GET /api/payments/WPxxxxxxxx/diagnostics`. It includes all requested URIs/fields, unknown parameters, hashes, character differences, mode previews and browser serialization. No token is needed because both server environment gates and a loopback connection are required. Production always returns 404, even with the flag. Normal checkout never renders this panel.

The comparison proves application-side string preservation, not the payload received inside Android/UPI or bank authorization. If the browser would serialize a string differently, checkout refuses that launch instead of silently changing it. For signed QRs use the original issuer string; do not add or forge signed fields.

## Tests

```powershell
npm run check
npm test
```

`npm test` starts portable PostgreSQL on a random loopback port with a random temporary password, creates an isolated schema, runs migrations/API/URI/DOM-handler tests, and runs the literal `npm start` command plus HTTP smoke checks. It ignores your DATABASE_URL and removes its own temporary cluster afterward. Portable PostgreSQL is a development dependency only; install scripts may need approval under your npm policy. No system user, Railway resource or production record is created.

To test against a dedicated external test PostgreSQL instance instead, set `TEST_DATABASE_URL` and run `node --test test/*.test.js`. This creates and drops a uniquely named test schema in that database. Never use a production connection for this command.

No automated test launches a real UPI app or makes a payment. QR scan-image recognition and post-PIN processing require a device/browser acceptance test; the existing html5-qrcode decoder dependency is retained.

## Paytm configuration boundary

The adapter reads PAYTM_MID, PAYTM_MERCHANT_KEY, PAYTM_WEBSITE_NAME, PAYTM_CALLBACK_URL and PAYTM_ENVIRONMENT server-side. None is configured here. Also required: Paytm online merchant onboarding/UPI_INTENT access and a reviewed implementation of Initiate Transaction, Process Transaction, and signed Transaction Status verification. Setting credentials alone deliberately does not activate the adapter. `provider: "paytm"` returns 503 rather than generating an unauthorized substitute URI.
