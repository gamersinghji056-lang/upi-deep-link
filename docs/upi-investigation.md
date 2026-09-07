# UPI investigation — 8 September 2026

## Evidence and scope

The workspace initially contained commit `8d7ef67`, which had no database/short-link code and rebuilt QR data with only pa/pn/am/cu/tn. It was fast-forwarded to remote `6f1e0f029d4a9635029d2a19fedf43ad2441cbbb` before changes. That version contains the deployed-style PostgreSQL `payment_links` implementation. Its behavior, not the obsolete local build, is the relevant baseline. No production database was accessed or changed.

No actual merchant QR, failed WP link, bank/PSP response code, or Android app capture was supplied during this investigation. Therefore **the particular post-PIN failure is not proven**. QR-scan success combined with intent failure is consistent with channel-specific merchant eligibility, transaction context or PSP risk enforcement, but does not identify which institution declined it. Reaching PIN proves app launch, not merchant authorization, successful debit or settlement.

## Before-change payload trace

Let `R` be the decoded QR and `Q` the query of the final stored URI before any literal `#`.

| Boundary | Remote baseline behavior |
| --- | --- |
| Original QR | `scanFile(...).trim()` discarded boundary whitespace; the original was not stored separately. |
| POST body | `upiInput.value.trim()`, JSON string; no extra URI encoding around the body. |
| Stored `upi_uri` | Server trimmed again. EXACT or any sign key: return trimmed URI. Default `scan`: append amount unless first am parsed as a positive number. `standard`: also append missing cu. |
| Generic Android/desktop | Stored URI assigned directly to `location.href`. No package. |
| PhonePe Android | `intent://pay?Q#Intent;scheme=upi;package=com.phonepe.app;S.browser_fallback_url=ENCODED_PLAY_STORE_URL;end` |
| Google Pay Android | Same wrapper, package `com.google.android.apps.nbu.paisa.user`. |
| Paytm Android | Same wrapper, package `net.one97.paytm`. |
| iOS app-specific | `phonepe://pay?Q`, `gpay://upi/pay?Q`, `paytmmp://pay?Q`. |

The Android wrapper encoded the Play Store fallback URL, not the payment query. Query parameter order, duplicates, percent-escape case and literal plus signs were otherwise preserved in the remote QR flow. `URLSearchParams` was used to inspect fields and interpreted `+` as space for display/validation; it did not reserialize the remote QR query. Manual VPA generation intentionally constructed a new query, so there is no original merchant payload to preserve in that mode.

Proven defects: trimming; amount append based on validity instead of presence (can duplicate `am`); dropping fragments in app-specific wrappers; no original capture for comparisons; publicly visible raw debug panel; misleading “scan-equivalent” label; request protocol/Host used for link generation behind a TLS proxy; SELECT-before-INSERT ID race. These do not establish why an unchanged real merchant payload failed after PIN.

## Official findings

Google requires verified merchants, bank payment/status integration and a unique transaction ID for its merchant intent integration. Its Android documentation confirms `com.google.android.apps.nbu.paisa.user`. These requirements do not authorize inventing fields in an existing QR. [Google Pay Android overview](https://developers.google.com/pay/india/api/android/overview).

Paytm documents a server-side order flow: Initiate Transaction returns a token; Process Transaction obtains a deep link after its UPI Switch interaction; the merchant launches the returned link. A server-side status check must validate the order and amount. Possessing a Paytm static QR or VPA alone is not the documented equivalent of that online flow. [Paytm integration steps](https://www.paytmpayments.com/docs/integration-steps-for-android/).

Paytm's Process Transaction API supports `UPI_INTENT` and returns provider-generated deep-link information. Forward its authorized result, rather than reconstructing issuer fields. The necessary fields depend on the provisioned merchant/API contract; there is no evidence here for a universal set that can be appended to every QR. [Process Transaction API](https://www.paytmpayments.com/docs/api/process-transaction-api/).

“Smart Intent” primarily describes selection of installed, UPI-payment-ready apps. It is not a magic signature parameter and does not itself establish why this merchant's QR fails via a browser. The reviewed public documentation does **not** prove that every static Paytm merchant QR is categorically forbidden in all browser intents. Confirm online intent enablement and the decline code with the acquiring PSP. [Paytm Smart Intent](https://www.paytmpayments.com/docs/upi-smart-intent/).

PhonePe's documented web checkout creates a provider checkout session through an authenticated payment API. It does not document arbitrary QR conversion as a substitute for that integration. [PhonePe Create Payment](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/create-payment). Package IDs were checked against official store listings: [PhonePe](https://play.google.com/store/apps/details?id=com.phonepe.app), [Paytm](https://play.google.com/store/apps/details?id=net.one97.paytm).

Chrome supports `intent:` wrappers with package and scheme, requires an eligible user gesture, and removes the fallback URL extra before delivery. These rules concern launch; they cannot explain a downstream bank decline by themselves. [Chrome Android intents](https://developer.chrome.com/docs/android/intents).

NPCI's indexed FAQ distinguishes merchant QR, Intent and other integration modes and assigns acquiring/onboarding responsibilities to banks. The live FAQ returned a JavaScript shell, limiting direct verification. No new NPCI rule banning this specific VPA or browser origin was established. [NPCI FAQ](https://www.npci.org.in/what-we-do/upi/faqs).

## Public comparison link

A read-only HTTPS GET to the supplied [comparison checkout](https://www.wpayportal.com/pay/WP02zqt2bn) returned HTTP 200 directly with Vercel headers and a Next.js checkout/loading shell. There was no HTTP redirect or final UPI payload in that response. No browser session was available, so subsequent transaction fetches, provider calls, button targets and final payment outcome could not be observed. A server-rendered `data-pay-flow` attribute is not evidence of the actual payment/acquirer flow. No branding or application bundle code was copied, and no competitor transaction was initiated.

## Implemented behavior

Original QR input is passed as raw JSON and stored separately from final `upi_uri`. The same shared builder drives diagnostics and launch. It never uses URLSearchParams to reconstruct QR data. Existing rows remain unchanged and report original data as unavailable, not as “equal.” The database migration adds nullable original/requested amount columns and a default static provider column only.

EXACT is the default. B appends only absent `am`. C appends only absent `am` and `cu=INR`. `scan` remains an API alias for B. Empty or invalid existing `am` is preserved rather than duplicated. Any attempted change to a signed QR is rejected explicitly. Boundary spaces/control characters are rejected, never trimmed. Non-ASCII/raw characters which browser serialization would change are diagnosed and not silently launched. This can require a correctly encoded issuer URI.

Generic remains `upi://pay?...`. Android package wrappers copy the query literally and are tested by reconstructing their embedded UPI data. Fragment/case situations that cannot be wrapped identically use unchanged generic fallback. Existing iOS schemes remain for compatibility; their current acceptance by PhonePe/Paytm was not independently verified. No false claim of universal iOS support is made.

Diagnostics show original/stored/final URIs, all Android intents, iOS targets, ordered raw entries, percent-decoded and form-decoded interpretations, unknown/duplicate fields, SHA-256/UTF-8 lengths, full character differences, A/B variants, browser serialization and last assigned launch target. These prove application-side preservation only; the browser/Android/PSP receiving boundary still needs device evidence.

## Provider boundary and remaining work

`PaymentProvider` defines createTransaction/getIntentUri/getStatus. `StaticQrProvider` is the working fallback; its status is always unverified. `PaytmProvider` is intentionally a disabled scaffold returning 503, including when credentials are set. **It is not a completed Paytm integration.** No fabricated API response, signature or success state exists.

Missing configuration: PAYTM_MID, PAYTM_MERCHANT_KEY, PAYTM_WEBSITE_NAME, PAYTM_CALLBACK_URL, PAYTM_ENVIRONMENT. The latter is environment selection, not a credential. Also missing: confirmed Paytm online merchant onboarding, UPI_INTENT product access for this merchant, approved website/callback setup, and a tested server gateway/status implementation.

Before activation, implement order reservation using the existing WP ID/database record, provider order/token persistence, idempotent Initiate/Process calls, exact returned-intent storage and provider expiry, then authenticated status verification against MID/order/amount/currency. Keep the current POST -> WP -> PostgreSQL -> /pay/WP flow. Provider activation must not reinterpret old static rows. Persist success only after server verification; never from app return, a URL query, visibility changes or user reports. A callback endpoint is deliberately absent until signature validation is implemented.

## Next evidence needed

Create separate A/B/C links for the same original QR, recording the diagnostic hashes. Use EXACT first. Capture device/browser/app versions, selected launch target, timestamp, exact failure message, and PSP transaction/reference ID without entering or recording a PIN here. Compare with a direct scan attempt under the same conditions. Obtain the acquirer's rejection code and online-intent enablement decision. If the unchanged payload still fails, stop URI edits and use the PSP-authorized order flow or original QR scan fallback.
