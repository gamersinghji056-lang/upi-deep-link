(async function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const flags = new URLSearchParams(location.search);
  const match = location.pathname.match(/^\/pay\/(WP[A-Za-z0-9]{8})$/);
  let uri = "";
  let expiresAt = null;
  let paymentId = "Legacy link";
  let diagnostics = null;
  let verificationTimer = null;
  let expiryTimer = null;
  let selectedApp = "phonepe";
  let parsed = null;
  let merchantName = "Merchant";
  let displayAmount = "₹ --";
  let lastSubmittedUtr = "";
  let isExpired = false;

  function utf8Base64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function showToast(text) {
    const toast = $("toast");
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(window.__wpayToast);
    window.__wpayToast = setTimeout(() => toast.classList.remove("show"), 1800);
  }

  function showFatal(message) {
    const box = $("error");
    if (!box) return;
    box.hidden = false;
    box.textContent = message;
  }

  function setVerification(text, state = "") {
    const box = $("verificationState");
    if (!box) return;
    box.textContent = text;
    box.className = "warn" + (state ? " " + state : "");
  }

  function requirePayment(fields) {
    const vpa = fields.pa[0];
    const amount = Number(fields.am[0]);
    if (!vpa) throw new Error("UPI ID is missing");
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Payment amount is missing");
    return { vpa, amount };
  }

  function paymentNote(fields, id) {
    return String(fields.tn[0] || id || "Payment").slice(0, 80);
  }

  function buildPhonePeNative(fields, id) {
    const { vpa, amount } = requirePayment(fields);
    const note = paymentNote(fields, id);
    const payload = {
      contact: { cbsName: "", nickName: "", type: "VPA", vpa },
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

  function buildPaytmUrl(fields, id) {
    const { vpa, amount } = requirePayment(fields);
    const note = paymentNote(fields, id);
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

  function buildQrUpiUrl(fields, id) {
    const { vpa, amount } = requirePayment(fields);
    const note = paymentNote(fields, id);
    const params = new URLSearchParams({
      pa: vpa,
      tn: note,
      am: amount.toFixed(2),
      cu: "INR",
      pn: ""
    });
    return "upi://pay?" + params.toString();
  }

  function renderQr(text) {
    const box = $("upiQr");
    const status = $("qrStatus");
    const download = $("downloadQr");
    if (!box || !download) return;

    box.innerHTML = '<div class="qlogo">W</div>';
    if (typeof QRCode !== "function") {
      if (status) status.textContent = "QR could not load. Copy the UPI ID instead.";
      download.disabled = true;
      return;
    }

    const host = document.createElement("div");
    host.style.display = "grid";
    host.style.placeItems = "center";
    box.insertBefore(host, box.firstChild);
    new QRCode(host, { text, width: 164, height: 164, correctLevel: QRCode.CorrectLevel.M });
    if (status) status.textContent = "Scan with PhonePe or Paytm";
    download.disabled = false;
    download.onclick = () => {
      try {
        const canvas = host.querySelector("canvas");
        const image = host.querySelector("img");
        const href = canvas ? canvas.toDataURL("image/png") : image?.src;
        if (!href) throw new Error("QR image is not ready");
        const link = document.createElement("a");
        link.href = href;
        link.download = (paymentId || "upi-payment") + "-qr.png";
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch (error) {
        showToast(error.message || "Could not download QR");
      }
    };
  }

  function formatExpiry(ms) {
    if (ms <= 0) return "Expired";
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
    return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
  }

  function disableCheckoutForExpiry() {
    isExpired = true;
    for (const button of document.querySelectorAll(".method, #openSelected, #submitUtr, #pasteUtr")) {
      button.disabled = true;
    }
    const input = $("utrInput");
    if (input) input.disabled = true;
    setVerification("This payment link has expired. Create a new payment link.", "err");
  }

  function startExpiryTimer() {
    if (!expiresAt) {
      $("timer").textContent = "Active";
      return;
    }
    const deadline = new Date(expiresAt).getTime();
    if (!Number.isFinite(deadline)) {
      $("timer").textContent = "Active";
      return;
    }
    const update = () => {
      const remaining = deadline - Date.now();
      $("timer").textContent = formatExpiry(remaining);
      if (remaining <= 0) {
        if (expiryTimer) clearInterval(expiryTimer);
        expiryTimer = null;
        disableCheckoutForExpiry();
      }
    };
    update();
    if (!isExpired) expiryTimer = setInterval(update, 1000);
  }

  function selectApp(app) {
    if (!["phonepe", "paytm"].includes(app)) return;
    selectedApp = app;
    for (const button of document.querySelectorAll(".method")) {
      button.classList.toggle("active", button.dataset.app === app);
    }
    const label = app === "phonepe" ? "PhonePe" : "Paytm";
    $("openSelected").textContent = "Open " + label;
  }

  function launchSelectedApp() {
    try {
      if (isExpired || (expiresAt && new Date(expiresAt).getTime() <= Date.now())) {
        disableCheckoutForExpiry();
        throw new Error("Payment link expired");
      }
      const launchers = {
        phonepe: () => buildPhonePeNative(parsed, paymentId),
        paytm: () => buildPaytmUrl(parsed, paymentId)
      };
      const target = launchers[selectedApp]?.();
      if (!target) throw new Error("Unsupported payment app");
      if (diagnostics) {
        diagnostics.lastLaunch = { app: selectedApp, scheme: target.split(":")[0], paymentId };
        $("debug").textContent = JSON.stringify(diagnostics, null, 2);
      }
      location.href = target;
    } catch (error) {
      showToast(error.message || "Could not open payment app");
    }
  }

  function showVerified(data = {}) {
    if (verificationTimer) {
      clearInterval(verificationTimer);
      verificationTimer = null;
    }
    if (expiryTimer) {
      clearInterval(expiryTimer);
      expiryTimer = null;
    }

    const verifiedUtr = lastSubmittedUtr || data.utrMasked || "Verified";
    const verifiedAt = data.verifiedAt ? new Date(data.verifiedAt) : new Date();
    $("successAmount").textContent = displayAmount;
    $("successMerchant").textContent = merchantName;
    $("successOrder").textContent = paymentId;
    $("successUtr").textContent = verifiedUtr;
    $("successDate").textContent = verifiedAt.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    $("utrInput").disabled = true;
    $("submitUtr").disabled = true;
    setVerification(data.utrMasked ? "Verified UTR " + data.utrMasked : "Payment verified successfully.", "ok");

    $("checkout").classList.add("hide");
    $("checkout").hidden = true;
    $("success").hidden = false;
    $("success").classList.add("show");
    document.title = "Payment Successful - WPAY";
    if (typeof window.scrollTo === "function") window.scrollTo({ top: 0, behavior: "smooth" });
    window.dispatchEvent(new CustomEvent("wpay:payment-success", {
      detail: { paymentId, status: "success", verified: true }
    }));
  }

  async function checkVerification() {
    if (!match) return;
    try {
      const response = await fetch("/api/payments/" + paymentId + "/verification-status", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not check payment status");
      if (data.verified && data.status === "success") {
        showVerified(data);
      } else if (data.status === "pending") {
        setVerification("UTR received. Waiting for matching bank credit confirmation...", "pending");
      } else {
        setVerification("Do not close this page until the payment is independently verified.");
      }
    } catch (error) {
      setVerification(error.message || "Could not check payment status", "err");
    }
  }

  function startVerificationPolling() {
    if (!match || verificationTimer) return;
    verificationTimer = setInterval(checkVerification, 3000);
  }

  async function submitUtr() {
    if (!match) {
      setVerification("UTR verification is available on WP short links only.", "err");
      return;
    }
    if (isExpired) {
      setVerification("This payment link has expired.", "err");
      return;
    }

    const input = $("utrInput");
    const utr = input.value.replace(/\D/g, "").slice(0, 12);
    input.value = utr;
    if (!/^\d{12}$/.test(utr)) {
      setVerification("Enter the exact 12-digit UPI UTR.", "err");
      return;
    }

    const button = $("submitUtr");
    button.disabled = true;
    setVerification("Checking UTR with the payment system...", "pending");
    try {
      const response = await fetch("/api/payments/" + paymentId + "/utr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ utr })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not submit UTR");
      lastSubmittedUtr = utr;

      if (data.verified === true && data.status === "success") {
        showVerified({ ...data, utrMasked: data.utrMasked || "••••" + utr.slice(-4) });
      } else {
        setVerification(data.message || "UTR submitted. Waiting for matching bank credit confirmation...", "pending");
        startVerificationPolling();
      }
    } catch (error) {
      setVerification(error.message || "Could not verify payment", "err");
    } finally {
      if (!$("success").classList.contains("show") && !isExpired) button.disabled = false;
    }
  }

  function goBack() {
    if (window.history && window.history.length > 1 && typeof window.history.back === "function") {
      window.history.back();
    } else {
      location.href = "/";
    }
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
      } else {
        uri = flags.get("upi") || "";
      }
    }

    parsed = Upi.parse(uri).fields;
    const { vpa, amount } = requirePayment(parsed);
    merchantName = parsed.pn[0] || "Merchant";
    const hasFraction = Math.abs(amount - Math.round(amount)) > 0.0001;
    displayAmount = "₹ " + Number(amount).toLocaleString("en-IN", {
      minimumFractionDigits: hasFraction ? 2 : 0,
      maximumFractionDigits: hasFraction ? 2 : 0
    });

    $("amount").textContent = displayAmount;
    $("name").textContent = merchantName;
    $("merchantAvatar").textContent = merchantName.trim().charAt(0).toUpperCase() || "W";
    $("vpa").textContent = vpa;
    $("copyVpaValue").textContent = vpa;
    $("paymentId").textContent = paymentId;
    $("loading").style.display = "none";
    $("payment").style.display = "block";

    $("copyVpa").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(vpa);
        showToast("UPI ID copied");
      } catch {
        showToast("Could not copy UPI ID");
      }
    });

    $("pasteUtr").addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        const matchUtr = String(text || "").match(/\d{12}/);
        if (!matchUtr) throw new Error("No 12-digit UTR found");
        $("utrInput").value = matchUtr[0];
        showToast("UTR pasted");
      } catch (error) {
        showToast(error.message || "Paste permission unavailable");
      }
    });

    $("utrInput").addEventListener("input", event => {
      event.target.value = event.target.value.replace(/\D/g, "").slice(0, 12);
    });
    $("utrInput").addEventListener("keydown", event => {
      if (event.key === "Enter") submitUtr();
    });
    $("submitUtr").addEventListener("click", submitUtr);

    for (const button of document.querySelectorAll(".method")) {
      button.addEventListener("click", () => selectApp(button.dataset.app));
    }
    $("openSelected").addEventListener("click", launchSelectedApp);
    $("checkoutBack").addEventListener("click", goBack);
    $("backMerchant").addEventListener("click", goBack);
    $("downloadReceipt").addEventListener("click", () => window.print());

    renderQr(buildQrUpiUrl(parsed, paymentId));
    selectApp("phonepe");
    startExpiryTimer();

    if (match) {
      await checkVerification();
      if (!$("success").classList.contains("show")) startVerificationPolling();
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
    showFatal(error.message || "Payment link unavailable");
  }
})();
