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
        ? "UPI QR loaded. Existing QR amount will be used."
        : "UPI QR loaded. Enter the payment amount below; it will be included in the UPI payment link.";
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
      const amountInput = $("am").value.trim();
      let parsedFields = fields(raw);

      if (!parsedFields) {
        if (/^\s*upi:/i.test(raw)) Upi.parse(raw);
        const vpa = raw.trim();
        if (!/^[^\s@]+@[^\s@]+$/.test(vpa)) throw new Error("Enter a valid UPI ID or full UPI URI.");
        if (!amountInput) throw new Error("Enter payment amount.");
        raw = Upi.manual(vpa, $("pn").value.trim(), amountInput, $("tn").value.trim());
        source = "manual";
        parsedFields = fields(raw);
      } else if (!parsedFields.am[0] && !amountInput) {
        throw new Error("Enter payment amount.");
      }

      const response = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upiUri: raw,
          amount: amountInput,
          profile: "standard",
          source
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create payment link");

      $("checkout").value = new URL(data.url, location.origin).href;
      $("paymentId").textContent = data.id;
      $("debug").textContent = "Short payment ID: " + data.id + "\nNormal UPI payment link\nAmount is included in the UPI URI when missing from the QR.\nCurrency is INR when missing.\nExisting merchant QR fields are preserved.\nExpires: " + data.expiresIn;
      $("empty").style.display = "none";
      $("result").style.display = "block";
      $("msg").className = "msg ok";
      $("msg").textContent = "UPI payment link created.";
    } catch (error) {
      $("msg").className = "msg err";
      $("msg").textContent = error.message;
    } finally {
      $("createBtn").disabled = false;
      $("createBtn").textContent = "Create UPI Payment Link";
    }
  });

  $("copy").onclick = async () => navigator.clipboard.writeText($("checkout").value);
  $("open").onclick = () => { if ($("checkout").value) window.open($("checkout").value, "_blank", "noopener"); };
})();
