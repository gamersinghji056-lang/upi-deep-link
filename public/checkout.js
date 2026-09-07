(async function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const flags = new URLSearchParams(location.search);
  const match = location.pathname.match(/^\/pay\/(WP[A-Za-z0-9]{8})$/);
  let uri, expiresAt, paymentId = "Legacy link", diagnostics = null;

  function isAndroid() {
    return /Android/i.test(navigator.userAgent || "");
  }

  function launchPhonePeAndroid(raw) {
    const primary = Upi.phonepeNative(raw);
    const fallback = Upi.androidIntent(raw, "phonepe");
    if (!primary) {
      location.href = fallback || raw;
      return;
    }

    let leftPage = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
    const onVisibility = () => {
      if (document.hidden) {
        leftPage = true;
        cleanup();
      }
    };
    const onPageHide = () => {
      leftPage = true;
      cleanup();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    timer = setTimeout(() => {
      cleanup();
      if (!leftPage && !document.hidden && fallback) location.href = fallback;
    }, 1600);

    // Primary experiment: enter PhonePe through its own scheme while preserving
    // the payment query byte-for-byte. If it does not open, the timer falls back
    // to the package-targeted Android UPI intent.
    location.href = primary;
  }

  try {
    if (match) {
      paymentId = match[1];
      const response = await fetch("/api/payments/" + paymentId, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load payment");
      uri = data.upiUri;
      expiresAt = data.expiresAt;
    } else {
      if (location.pathname !== "/pay" && location.pathname !== "/pay.html") throw new Error("Payment link not found");
      const payload = flags.get("payload");
      if (payload) {
        const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
        uri = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)));
      } else uri = flags.get("upi") || "";
    }

    const parsed = Upi.parse(uri).fields;
    const amount = parsed.am[0];
    $("amount").textContent = amount && Number.isFinite(Number(amount)) && Number(amount) > 0
      ? (parsed.cu[0] || "INR") + " " + Number(amount).toFixed(2)
      : "Amount in PhonePe";
    $("name").textContent = parsed.pn[0] || "UPI Payment";
    $("vpa").textContent = parsed.pa[0];
    $("paymentId").textContent = paymentId;
    $("loading").style.display = "none";
    $("payment").style.display = "block";

    document.querySelector("button[data-app=\"phonepe\"]").addEventListener("click", () => {
      try {
        $("error").textContent = "";
        if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) throw new Error("Payment link expired");

        if (diagnostics) {
          diagnostics.lastLaunch = {
            app: "phonepe",
            android: isAndroid(),
            primary: isAndroid() ? Upi.phonepeNative(uri) : Upi.target(uri, "phonepe", navigator.userAgent || ""),
            fallback: isAndroid() ? Upi.androidIntent(uri, "phonepe") : null
          };
          $("debug").textContent = JSON.stringify(diagnostics, null, 2);
        }

        if (isAndroid()) launchPhonePeAndroid(uri);
        else location.href = Upi.target(uri, "phonepe", navigator.userAgent || "");
      } catch (error) {
        $("error").textContent = error.message;
      }
    });

    if (match && flags.get("diagnostics") === "1") {
      const response = await fetch("/api/payments/" + paymentId + "/diagnostics", { cache: "no-store" });
      if (response.ok) {
        diagnostics = await response.json();
        $("debug").hidden = false;
        $("debug").textContent = JSON.stringify(diagnostics, null, 2);
      }
    }
  } catch (error) {
    $("loading").style.display = "none";
    $("error").textContent = error.message || "Payment link unavailable";
  }
})();
