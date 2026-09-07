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

  function requirePayment(parsed) {
    const vpa = parsed.pa[0];
    const amount = Number(parsed.am[0]);
    if (!vpa) throw new Error("UPI ID is missing");
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Payment amount is missing");
    return { vpa, amount };
  }

  function paymentNote(parsed, id) {
    return String(parsed.tn[0] || id || "Payment").slice(0, 80);
  }

  function buildPhonePeNative(parsed, id) {
    const { vpa, amount } = requirePayment(parsed);
    const note = paymentNote(parsed, id);
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

  function buildPaytmUrl(parsed, id) {
    const { vpa, amount } = requirePayment(parsed);
    const note = paymentNote(parsed, id);
    const params = new URLSearchParams({
      featuretype: "money_transfer",
      pa: vpa,
      tr: note,
      am: amount.toFixed(2),
      pn: "VPAY",
      tn: note
    });
    return "paytmmp://cash_wallet?" + params.toString();
  }

  function buildOtherUpiUrl(parsed, id) {
    const { vpa, amount } = requirePayment(parsed);
    const note = paymentNote(parsed, id);
    const params = new URLSearchParams({
      pa: vpa,
      tn: note,
      am: amount.toFixed(2),
      cu: "INR",
      pn: ""
    });
    return "upi://pay?" + params.toString();
  }

  function buildGooglePayUrl(parsed, id) {
    const generic = buildOtherUpiUrl(parsed, id);
    return "gpay://upi/pay?" + generic.slice(generic.indexOf("?") + 1);
  }

  function renderQr(text) {
    const box = $("upiQr");
    const status = $("qrStatus");
    const download = $("downloadQr");
    if (!box || !download) return;
    box.innerHTML = "";

    if (typeof QRCode !== "function") {
      if (status) status.textContent = "QR could not load. Use Other UPI Apps instead.";
      download.disabled = true;
      return;
    }

    new QRCode(box, {
      text,
      width: 240,
      height: 240,
      correctLevel: QRCode.CorrectLevel.M
    });

    if (status) status.textContent = "Scan this QR with any UPI app.";
    download.disabled = false;
    download.onclick = () => {
      try {
        const canvas = box.querySelector("canvas");
        const image = box.querySelector("img");
        const href = canvas ? canvas.toDataURL("image/png") : image?.src;
        if (!href) throw new Error("QR image is not ready");
        const link = document.createElement("a");
        link.href = href;
        link.download = (paymentId || "upi-payment") + "-qr.png";
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch (error) {
        $("error").textContent = error.message || "Could not download QR";
      }
    };
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

    const genericUpiUrl = buildOtherUpiUrl(parsed, paymentId);
    renderQr(genericUpiUrl);

    const launchers = {
      phonepe: () => buildPhonePeNative(parsed, paymentId),
      paytm: () => buildPaytmUrl(parsed, paymentId),
      gpay: () => buildGooglePayUrl(parsed, paymentId),
      other: () => genericUpiUrl
    };

    for (const button of document.querySelectorAll("button[data-app]")) {
      button.addEventListener("click", () => {
        try {
          $("error").textContent = "";
          if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) throw new Error("Payment link expired");
          const app = button.dataset.app;
          if (!launchers[app]) throw new Error("Unsupported payment app");
          const target = launchers[app]();
          if (diagnostics) {
            diagnostics.lastLaunch = { app, scheme: target.split(":")[0], paymentId };
            $("debug").textContent = JSON.stringify(diagnostics, null, 2);
          }
          location.href = target;
        } catch (error) {
          $("error").textContent = error.message;
        }
      });
    }

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
