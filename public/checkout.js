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
      } else uri = flags.get("upi") || ""; // Decode only the legacy outer envelope once.
    }
    const parsed = Upi.parse(uri).fields;
    const amount = parsed.am[0];
    $("amount").textContent = amount && Number.isFinite(Number(amount)) && Number(amount) > 0 ? (parsed.cu[0] || "INR") + " " + Number(amount).toFixed(2) : "Amount in UPI app";
    $("name").textContent = parsed.pn[0] || "UPI Payment";
    $("vpa").textContent = parsed.pa[0];
    $("paymentId").textContent = paymentId;
    $("loading").style.display = "none";
    $("payment").style.display = "block";

    document.querySelectorAll("button[data-app]").forEach(button => button.addEventListener("click", () => {
      try {
        $("error").textContent = "";
        if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) throw new Error("Payment link expired");
        const target = Upi.target(uri, button.dataset.app, navigator.userAgent || "");
        const serialized = new URL(target).href;
        if (diagnostics) {
          diagnostics.lastLaunch = { app: button.dataset.app, assignedUri: target, browserSerializedUri: serialized, unchanged: serialized === target };
          $("debug").textContent = JSON.stringify(diagnostics, null, 2);
        }
        if (serialized !== target) throw new Error("The browser would change this URI. Use the original merchant QR or request a correctly encoded URI from its issuer.");
        location.href = target; // Synchronous user gesture; no fetch/timer before launch.
      } catch (error) { $("error").textContent = error.message; }
    }));
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
