(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  let scannedRaw = null;
  function fields(raw) { try { return Upi.parse(raw).fields; } catch { return null; } }

  $("upiInput").addEventListener("input", () => { scannedRaw = null; });

  $("qrFile").addEventListener("change", async () => {
    const file = $("qrFile").files?.[0];
    if (!file) return;
    $("qrMsg").className = "msg muted";
    $("qrMsg").textContent = "Reading QR...";
    let scanner;
    try {
      const hidden = $("qr-hidden") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "qr-hidden" }));
      hidden.style.display = "none";
      scanner = new Html5Qrcode("qr-hidden");
      const decoded = await scanner.scanFile(file, true);
      const parsed = Upi.parse(decoded).fields;
      scannedRaw = decoded;
      $("upiInput").value = decoded;
      $("pn").value = parsed.pn[0] || "";
      $("am").value = parsed.am[0] || "";
      $("tn").value = parsed.tn[0] || "";
      $("qrMsg").className = "msg ok";
      $("qrMsg").textContent = parsed.am[0]
        ? "UPI QR loaded. RAW mode will send this QR exactly as decoded, including its existing amount."
        : "UPI QR loaded. RAW mode will send this QR exactly as decoded; enter the amount inside PhonePe.";
    } catch (error) {
      $("qrMsg").className = "msg err";
      $("qrMsg").textContent = "Could not read a standard UPI QR. " + error.message;
    } finally {
      try { scanner?.clear(); } catch { /* ignore */ }
    }
  });

  $("form").addEventListener("submit", async event => {
    event.preventDefault();
    $("msg").textContent = "";
    $("createBtn").disabled = true;
    $("createBtn").textContent = "Creating...";
    try {
      let raw = scannedRaw ?? $("upiInput").value;
      let source = "merchant";
      let profile = "exact";

      if (!fields(raw)) {
        if (/^\s*upi:/i.test(raw)) Upi.parse(raw);
        const vpa = raw.trim();
        if (!/^[^\s@]+@[^\s@]+$/.test(vpa)) throw new Error("Enter a valid UPI ID or full UPI URI.");
        raw = Upi.manual(vpa, $("pn").value.trim(), $("am").value.trim(), $("tn").value.trim());
        source = "manual";
        profile = "standard";
      }

      const response = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upiUri: raw,
          amount: $("am").value.trim(),
          profile,
          source
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create payment link");

      $("checkout").value = new URL(data.url, location.origin).href;
      $("paymentId").textContent = data.id;
      $("debug").textContent = source === "merchant"
        ? "Short payment ID: " + data.id + "\nApp: PhonePe only\nProfile: RAW QR / EXACT\nThe merchant UPI URI is stored exactly as supplied. No am/cu/tr/mc/url/mode/orgid/sign is added or changed.\nIf the QR has no amount, enter the amount inside PhonePe.\nExpires: " + data.expiresIn
        : "Short payment ID: " + data.id + "\nApp: PhonePe only\nProfile: manual VPA\nAmount/currency come from the manual payment form.\nExpires: " + data.expiresIn;
      $("empty").style.display = "none";
      $("result").style.display = "block";
      $("msg").className = "msg ok";
      $("msg").textContent = source === "merchant" ? "PhonePe RAW QR test link created." : "PhonePe payment link created.";
    } catch (error) {
      $("msg").className = "msg err";
      $("msg").textContent = error.message;
    } finally {
      $("createBtn").disabled = false;
      $("createBtn").textContent = "Create PhonePe RAW QR Link";
    }
  });

  $("copy").onclick = async () => navigator.clipboard.writeText($("checkout").value);
  $("open").onclick = () => { if ($("checkout").value) window.open($("checkout").value, "_blank", "noopener"); };
})();
