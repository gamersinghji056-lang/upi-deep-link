(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const keyInput = $("deviceAdminKey");
  const createBtn = $("createPairingCode");
  const refreshBtn = $("refreshDevices");
  const codeBox = $("pairingCode");
  const msg = $("deviceMsg");
  const list = $("deviceList");

  if (!keyInput || !createBtn || !refreshBtn || !codeBox || !msg || !list) return;

  keyInput.value = sessionStorage.getItem("wpayDeviceAdminKey") || "";
  keyInput.addEventListener("input", () => {
    sessionStorage.setItem("wpayDeviceAdminKey", keyInput.value);
  });

  function headers() {
    const key = keyInput.value.trim();
    if (!key) throw new Error("Enter the dashboard device key first.");
    return { "Content-Type": "application/json", "x-device-admin-key": key };
  }

  function showMessage(text, type = "muted") {
    msg.className = "msg " + type;
    msg.textContent = text;
  }

  function formatSeen(value) {
    if (!value) return "Never";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  async function createPairing() {
    createBtn.disabled = true;
    showMessage("Creating one-time pairing code...");
    try {
      const response = await fetch("/api/devices/admin/pairing-token", {
        method: "POST",
        headers: headers(),
        body: "{}"
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create pairing code");
      codeBox.textContent = data.pairingCode;
      codeBox.hidden = false;
      showMessage("Pairing code created. It expires in 10 minutes.", "ok");
    } catch (error) {
      codeBox.hidden = true;
      showMessage(error.message, "err");
    } finally {
      createBtn.disabled = false;
    }
  }

  async function refreshDevices() {
    refreshBtn.disabled = true;
    showMessage("Loading connected devices...");
    try {
      const response = await fetch("/api/devices/admin/list", {
        method: "GET",
        headers: headers(),
        cache: "no-store"
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load devices");
      const devices = Array.isArray(data.devices) ? data.devices : [];
      $("connectedCount").textContent = String(devices.length);
      const last = devices.find(d => d.last_utr);
      $("lastUtr").textContent = last?.last_utr || "—";
      $("deviceHealth").textContent = devices.length ? "Connected" : "Not connected";

      if (!devices.length) {
        list.innerHTML = '<div class="muted">No Android device has been paired yet.</div>';
      } else {
        list.innerHTML = devices.map(device => {
          const battery = device.battery_level == null ? "—" : Math.round(Number(device.battery_level)) + "%";
          const network = device.network_type || "—";
          const carrier = device.network_carrier || device.sim_carrier || "—";
          const model = [device.manufacturer, device.model].filter(Boolean).join(" ") || device.id;
          const verified = device.phone_verified ? "Verified" : "Pending OTP verification";
          const utr = device.last_utr || "—";
          return '<div class="device-row">' +
            '<div><b>' + escapeHtml(model) + '</b><div class="muted small">' + escapeHtml(device.id) + '</div></div>' +
            '<div><span class="muted small">SIM</span><br>' + escapeHtml(carrier) + '<div class="muted small">' + escapeHtml(verified) + '</div></div>' +
            '<div><span class="muted small">Battery / Network</span><br>' + escapeHtml(battery) + ' · ' + escapeHtml(network) + '</div>' +
            '<div><span class="muted small">Last UTR</span><br>' + escapeHtml(utr) + '<div class="muted small">Seen ' + escapeHtml(formatSeen(device.last_seen_at)) + '</div></div>' +
          '</div>';
        }).join("");
      }
      showMessage("Device list updated.", "ok");
    } catch (error) {
      showMessage(error.message, "err");
    } finally {
      refreshBtn.disabled = false;
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  createBtn.addEventListener("click", createPairing);
  refreshBtn.addEventListener("click", refreshDevices);
})();
