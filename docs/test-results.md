# Validation — 8 September 2026

Base: `6f1e0f029d4a9635029d2a19fedf43ad2441cbbb` (current remote main at investigation time).

| Check | Result |
| --- | --- |
| `npm install` | Passed; final dependency install audited 87 packages, 0 vulnerabilities reported. |
| `npm run check` | Passed, 11 JavaScript files. |
| `git diff --check` | Passed. |
| `npm test` | Passed: 14 tests, 0 failures, 0 skipped. |
| Database | Real PostgreSQL 18.4, isolated local cluster and schema; old-schema row retained, additive migration repeated successfully. |
| `npm start` | Passed through literal npm start command, against temporary PostgreSQL. |
| `/health` | 200 with configured DB; 503 for missing DB. |
| Create/read | POST 201, valid WP ID, GET 200, final URI preserved. |
| Short checkout | `/pay/WPxxxxxxxx` 200; old record still readable. |
| Invalid/expired | Invalid or absent IDs 404; expired API and page 410. |
| A/B/C | EXACT default, amount-only, standard-minimal and legacy scan alias passed. |
| Manual VPA | Generator and API path passed. |
| Signed input | EXACT preserved; modifying modes rejected. |
| Android intent | All package wrappers round-trip to the exact generic payload. Actual click handler assigns expected URI. |
| Diagnostics | Raw/hash/character comparison passed; production and unconfigured diagnostics return 404. Normal checkout hides panel. |
| QR decoder | Existing dependency/asset preserved and served; decoder-output-to-POST tested with a stub. No actual image decode/UI test claimed. |
| Legacy envelope | One outer decoding pass preserves inner plus and percent escapes. |
| No false success | Static status unverified; launch handlers make no status writes. |
| Cleanup | Temporary server/database shut down; successful run exited 0. |

The first SQL attempt used pg-mem and hit an emulator limitation; it was replaced and removed. The final suite uses a real PostgreSQL binary. Windows sandbox user-information restrictions required running the isolated database tests with approval. A portable PostgreSQL I/O worker initially impeded test shutdown; synchronous I/O in the temporary test cluster resolved it. Neither workaround changes production configuration.

Plain `npm start` without DATABASE_URL correctly failed startup. No production DATABASE_URL or Paytm environment configuration was available. The successful smoke test supplied only its own random temporary local credentials.

Not tested: Railway's live database or deployment; visual browser interaction (no browser session available); actual merchant QR image recognition; Android receiving-app payload; iOS scheme acceptance; UPI PIN processing, settlement or PSP rejection cause; real Paytm API transactions/status. The supplied public comparison page was read with HTTP only and did not reveal a final intent. No real payment was initiated and nothing was deployed.
