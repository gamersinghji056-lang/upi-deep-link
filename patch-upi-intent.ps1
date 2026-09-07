$ErrorActionPreference = "Stop"

$root = Get-Location
$indexPath = Join-Path $root "public\index.html"
$payPath = Join-Path $root "public\pay.html"

if (!(Test-Path $indexPath) -or !(Test-Path $payPath)) {
    Write-Host "ERROR: Run this script from the project folder that contains public\index.html and public\pay.html" -ForegroundColor Red
    exit 1
}

Copy-Item $indexPath "$indexPath.bak" -Force
Copy-Item $payPath "$payPath.bak" -Force

$index = Get-Content $indexPath -Raw
$pay = Get-Content $payPath -Raw

# 1) Preserve merchant category code from full UPI QR URI.
$oldIndexParse = @'
              tn: url.searchParams.get("tn") || "",
              tr: url.searchParams.get("tr") || ""
'@
$newIndexParse = @'
              tn: url.searchParams.get("tn") || "",
              tr: url.searchParams.get("tr") || "",
              mc: url.searchParams.get("mc") || ""
'@
$index = $index.Replace($oldIndexParse, $newIndexParse)

$index = $index.Replace(
'return { pa: raw, pn: "", am: "", tn: "", tr: "" };',
'return { pa: raw, pn: "", am: "", tn: "", tr: "", mc: "" };'
)

# Do not invent a fake transaction reference. Preserve original QR reference only.
$index = $index.Replace(
'const tr = parsed.tr || ("TEST" + Date.now().toString(36).toUpperCase());',
'const tr = parsed.tr || "";'
)

$oldParams = @'
        const params = new URLSearchParams({
          pa: parsed.pa,
          pn,
          am: amount.toFixed(2),
          tn,
          tr,
          cu: "INR"
        });
'@
$newParams = @'
        const params = new URLSearchParams({
          pa: parsed.pa,
          pn,
          am: amount.toFixed(2),
          tn,
          cu: "INR"
        });
        if (tr) params.set("tr", tr);
        if (parsed.mc) params.set("mc", parsed.mc);
'@
$index = $index.Replace($oldParams, $newParams)

# 2) Checkout: preserve optional tr/mc and build standard UPI payload.
$pay = $pay.Replace(
'tr: (q.get("tr") || ("TEST" + Date.now().toString(36).toUpperCase())).trim(),',
'tr: (q.get("tr") || "").trim(),'
)

$pay = $pay.Replace(
'        cu: "INR"`r`n      };',
'        cu: "INR",`r`n        mc: (q.get("mc") || "").trim()`r`n      };'
)
$pay = $pay.Replace(
'        cu: "INR"`n      };',
'        cu: "INR",`n        mc: (q.get("mc") || "").trim()`n      };'
)

$oldQuery = @'
      function queryString() {
        const p = new URLSearchParams({
          pa: data.pa,
          pn: data.pn,
          tr: data.tr,
          tn: data.tn,
          am: amount.toFixed(2),
          cu: "INR"
        });
        return p.toString();
      }

      function targetFor(app) {
        const qs = queryString();
        if (app === "gpay") return "gpay://upi/pay?" + qs;
        if (app === "phonepe") return "phonepe://pay?" + qs;
        if (app === "paytm") return "paytmmp://pay?" + qs;
        return "upi://pay?" + qs;
      }
'@

$newQuery = @'
      function queryString() {
        const p = new URLSearchParams({
          pa: data.pa,
          pn: data.pn,
          tn: data.tn,
          am: amount.toFixed(2),
          cu: "INR"
        });
        if (data.tr) p.set("tr", data.tr);
        if (data.mc) p.set("mc", data.mc);
        return p.toString();
      }

      function isAndroid() {
        return /Android/i.test(navigator.userAgent || "");
      }

      function androidIntent(packageName) {
        const qs = queryString();
        return "intent://pay?" + qs +
          "#Intent;scheme=upi;package=" + packageName + ";end";
      }

      function targetFor(app) {
        const qs = queryString();

        if (isAndroid()) {
          if (app === "phonepe") return androidIntent("com.phonepe.app");
          if (app === "paytm") return androidIntent("net.one97.paytm");
          if (app === "gpay") return androidIntent("com.google.android.apps.nbu.paisa.user");
        }

        if (app === "gpay") return "gpay://upi/pay?" + qs;

        // Generic standard UPI URI is the safest cross-app fallback.
        return "upi://pay?" + qs;
      }
'@

$pay = $pay.Replace($oldQuery, $newQuery)

Set-Content -Path $indexPath -Value $index -Encoding UTF8
Set-Content -Path $payPath -Value $pay -Encoding UTF8

Write-Host ""
Write-Host "UPI intent patch applied successfully." -ForegroundColor Green
Write-Host "Backups created:"
Write-Host "  public\index.html.bak"
Write-Host "  public\pay.html.bak"
Write-Host ""
Write-Host "Next run:"
Write-Host "  npm start"
Write-Host "Then test locally or push to GitHub."
