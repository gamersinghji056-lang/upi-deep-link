# WPAY Agent Android prototype

This Android app pairs one consented merchant device to the existing WPAY backend and confirms **new incoming bank credit SMS events** against customer-submitted UTR + amount.

## What it does

- Shows all requested runtime permissions before pairing.
- Requires an active SIM and creates a best-available SIM fingerprint from Android subscription/carrier metadata.
- Exchanges the dashboard's one-time pairing code for a device token.
- Sends battery, network/carrier and best-available last-known location diagnostics.
- Listens only for **new incoming SMS broadcasts** after permission is granted.
- Parses credit amount + UTR locally and sends only structured fields (`UTR`, `amount`, sender, timestamp) to `/api/devices/credit-sms`.
- Does **not** request `READ_SMS`, does not scrape the inbox, and does not upload full SMS message text.
- Queues the latest parsed credit event locally if the network request fails and retries when the app opens again.

## Pairing

1. Open `https://pay.wtron.org` dashboard -> APK Setup.
2. Create a one-time pairing code.
3. Install/open the APK and tap **Review & Grant Permissions**.
4. Enter the pairing code and tap **Connect This Device**.
5. The backend binds the device credential to the SIM fingerprint.

## Verification flow

Customer payment page -> customer enters UTR -> claim remains `pending` -> bank credit SMS reaches paired merchant phone -> app extracts UTR + amount -> backend matches the same UTR + amount -> payment status becomes `success`.

Credit SMS can arrive before or after the customer submits UTR; the backend stores credit events and matches either direction.

## Important limitations

Android does not reliably expose a globally stable SIM serial/phone number to ordinary apps on modern versions. This prototype uses the strongest best-available subscription metadata the OS exposes. For stronger SIM ownership verification, add phone-number OTP/carrier verification later.

The credit SMS parser is intentionally conservative but banks format alerts differently. Test it with your own bank alerts before production and add bank-specific patterns where needed.

Google Play heavily restricts SMS-related permissions. This project is intended for an explicitly consented merchant/device-agent workflow; distribution and store policy requirements must be reviewed before publishing.

## Build locally

```bash
gradle -p android-app assembleDebug
```

APK output:

`android-app/app/build/outputs/apk/debug/app-debug.apk`

GitHub Actions also builds and uploads a `wpay-agent-debug` artifact automatically.
