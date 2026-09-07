(async function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const flags = new URLSearchParams(location.search);
  const match = location.pathname.match(/^\/pay\/(WP[A-Za-z0-9]{8})$/);
  let uri, expiresAt, paymentId = "Legacy link", diagnostics = null;

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
      : "Enter amount in UPI app";
    $("name").textContent = parsed.pn[0] || "UPI Payment";
    $("vpa").textContent = parsed.pa[0];
    $("paymentId").textContent = paymentId;
    $("loading").style.display = "none";
    $("payment").style.display = "block";

    document.querySelector("button[data-app=\"upi\"]").addEventListener("click", () => {
      try {
        $("error").textContent = "";
        if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) throw new Error("Payment link expired");

        // Keep the normal UPI hand-off simple: send the stored upi://pay URI exactly as-is.
        // Android may show the installed UPI-app chooser; select PhonePe there.
        if (diagnostics) {
          diagnostics.lastLaunch = { app: "upi", assignedUri: uri, unchanged: true };
          $("debug").textContent = JSON.stringify(diagnostics, null, 2);
        }
        location.href = uri;
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
