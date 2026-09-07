(async function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const flags = new URLSearchParams(location.search);
  const match = location.pathname.match(/^\/pay\/(WP[A-Za-z0-9]{8})$/);
  let uri, expiresAt, paymentId = "Legacy link", diagnostics = null;

  function utf8Base64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function buildPhonePeNative(parsed, paymentId) {
    const vpa = parsed.pa[0];
    const amount = Number(parsed.am[0]);
    if (!vpa) throw new Error("UPI ID is missing");
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Payment amount is missing");

    const noteCandidate = parsed.tn[0] || paymentId || "Payment";
    const note = String(noteCandidate).slice(0, 80);
    const payload = {
      contact: {
        cbsName: "",
        nickName: "",
        type: "VPA",
        vpa
      },
      p2pPaymentCheckoutParams: {
        checkoutType: "DEFAULT",
        initialAmount: Math.round(amount * 100),
        note,
        isByDefaultKnownContact: true,
        disableViewHistory: true,
        shouldShowMaskedNumber: true,
        shouldShowUnsavedContactBanner: false,
        showKeyboard: true,
        allowAmountEdit: false,
        disableNotesEdit: true,
        currency: "INR",
        showQrCodeOption: false,
        enableSpeechToText: false,
        transactionContext: "p2p",
        isRecurring: false
      }
    };
    return "phonepe://native?data=" + encodeURIComponent(utf8Base64(JSON.stringify(payload))) + "&id=p2ppayment";
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
      ? "INR " + Number(amount).toFixed(2)
      : "Amount unavailable";
    $("name").textContent = parsed.pn[0] || "UPI Payment";
    $("vpa").textContent = parsed.pa[0];
    $("paymentId").textContent = paymentId;
    $("loading").style.display = "none";
    $("payment").style.display = "block";

    document.querySelector("button[data-app=\"phonepe\"]").addEventListener("click", () => {
      try {
        $("error").textContent = "";
        if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) throw new Error("Payment link expired");
        const phonePeUrl = buildPhonePeNative(parsed, paymentId);
        if (diagnostics) {
          diagnostics.lastLaunch = { app: "phonepe", scheme: "phonepe://native", paymentId };
          $("debug").textContent = JSON.stringify(diagnostics, null, 2);
        }
        location.href = phonePeUrl;
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
