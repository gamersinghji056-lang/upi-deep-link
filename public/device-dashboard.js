(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const createBtn = $("createPairingCode");
  const refreshBtn = $("refreshDevices");
  const codeBox = $("pairingCode");
  const msg = $("deviceMsg");
  const grid = $("deviceGrid");
  const summary = $("deviceSummaryCard");
  const empty = $("deviceEmptyState");
  const eventsBody = $("deviceEventsBody");
  if (!createBtn || !refreshBtn || !codeBox || !msg || !grid || !summary || !eventsBody) return;

  let devices = [];
  let selectedId = "";

  function showMessage(text, type = "muted") { msg.className = "msg " + type; msg.textContent = text; }
  function esc(value) { return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#039;"); }
  function when(value) { if (!value) return "—"; const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString(); }
  function amount(value) { const n = Number(value); return Number.isFinite(n) ? n.toFixed(2) : "—"; }
  function online(value) { const t = new Date(value || 0).getTime(); return Number.isFinite(t) && Date.now() - t <= 10 * 60 * 1000; }

  function renderCards() {
    if (!devices.length) { grid.innerHTML = '<div class="muted">No Android device has been paired yet.</div>'; return; }
    grid.innerHTML = devices.map(d => {
      const isOnline = online(d.last_seen_at);
      const title = [d.manufacturer,d.model].filter(Boolean).join(" ") || d.id;
      return `<button class="device-card${d.id===selectedId?' selected':''}" data-device-id="${esc(d.id)}"><div class="device-card-head"><strong>${esc(title)}</strong><span class="state-pill ${isOnline?'online':'offline'}">${isOnline?'Online':'Offline'}</span></div><div class="device-card-meta">SIM: ${esc(d.phone_e164 || d.sim_subscription_label || d.sim_carrier || 'Unavailable')}</div><div class="device-card-meta">Battery: ${d.battery_level==null?'—':Math.round(Number(d.battery_level))+'%'}</div><div class="device-card-meta">Network: ${esc(d.network_type || '—')}</div><div class="device-card-meta">Last UTR: ${esc(d.last_utr || '—')}</div></button>`;
    }).join("");
    grid.querySelectorAll("[data-device-id]").forEach(btn => btn.addEventListener("click", () => loadDevice(btn.dataset.deviceId)));
  }

  function renderSummary(d) {
    empty.hidden = true; summary.hidden = false;
    const isOnline = online(d.last_seen_at);
    const loc = d.latitude==null || d.longitude==null ? "Unavailable" : `${Number(d.latitude).toFixed(6)}, ${Number(d.longitude).toFixed(6)}`;
    summary.innerHTML = `<div class="device-card-head"><div><strong>${esc([d.manufacturer,d.model].filter(Boolean).join(' ') || d.id)}</strong><div class="muted small">${esc(d.id)}</div></div><span class="state-pill ${isOnline?'online':'offline'}">${isOnline?'Online':'Offline'}</span></div><div class="detail-grid"><div class="detail"><span>Location</span><strong>${esc(loc)}</strong><small>${d.location_accuracy==null?'Accuracy unavailable':'± '+esc(d.location_accuracy)+' m'}</small></div><div class="detail"><span>SIM card / phone number</span><strong>${esc(d.phone_e164 || 'Not exposed by Android/device')}</strong><small>${esc(d.sim_carrier || d.network_carrier || 'Carrier unavailable')}</small></div><div class="detail"><span>Battery health</span><strong>${d.battery_level==null?'—':Math.round(Number(d.battery_level))+'%'}</strong><small>${d.charging?'Charging':'Not charging'}</small></div><div class="detail"><span>Connection network</span><strong>${esc(d.network_type || '—')}</strong><small>${esc(d.network_carrier || d.sim_carrier || '—')}</small></div><div class="detail"><span>Status</span><strong>${isOnline?'Online':'Offline'}</strong><small>Last seen ${esc(when(d.last_seen_at))}</small></div><div class="detail"><span>App / Android</span><strong>${esc(d.app_version || '—')}</strong><small>Android ${esc(d.android_version || '—')}</small></div></div>`;
  }

  function renderEvents(events) {
    if (!events.length) { eventsBody.innerHTML='<tr><td colspan="6" class="muted">No credit / UTR events yet.</td></tr>'; return; }
    eventsBody.innerHTML = events.map(e => `<tr><td>${esc(when(e.created_at || e.received_at))}</td><td>${esc(e.utr || '—')}</td><td>₹ ${esc(amount(e.amount))}</td><td>${esc(e.sender || '—')}</td><td>${esc(e.status || '—')}</td><td class="sms-cell">${esc(e.sms_body || '—')}</td></tr>`).join("");
  }

  async function createPairing() {
    createBtn.disabled = true; showMessage("Creating one-time pairing code...");
    try {
      const r = await fetch("/api/devices/admin/pairing-token", { method:"POST", headers:{"Content-Type":"application/json"}, body:"{}" });
      const data = await r.json(); if (!r.ok) throw new Error(data.error || "Could not create pairing code");
      codeBox.textContent = data.pairingCode; codeBox.hidden = false; showMessage("Pairing code created. It expires in 10 minutes.", "ok");
    } catch (e) { codeBox.hidden = true; showMessage(e.message, "err"); } finally { createBtn.disabled = false; }
  }

  async function refreshDevices(autoSelect = false) {
    refreshBtn.disabled = true; showMessage("Loading connected devices...");
    try {
      const r = await fetch("/api/devices/admin/list", { cache:"no-store" }); const data = await r.json(); if (!r.ok) throw new Error(data.error || "Could not load devices");
      devices = Array.isArray(data.devices) ? data.devices : [];
      $("connectedCount").textContent = String(devices.length);
      $("lastUtr").textContent = devices.find(d=>d.last_utr)?.last_utr || "—";
      $("deviceHealth").textContent = devices.some(d=>online(d.last_seen_at)) ? "Online" : (devices.length ? "Offline" : "Not connected");
      renderCards();
      if (selectedId && devices.some(d=>d.id===selectedId)) await loadDevice(selectedId); else if (autoSelect && devices.length) await loadDevice(devices[0].id); else if (!devices.length) { summary.hidden=true; empty.hidden=false; eventsBody.innerHTML='<tr><td colspan="6" class="muted">No connected device.</td></tr>'; }
      showMessage("Device list updated.", "ok");
    } catch(e){ showMessage(e.message,"err"); } finally { refreshBtn.disabled=false; }
  }

  async function loadDevice(id) {
    selectedId = id; renderCards(); showMessage("Loading device details...");
    try { const r=await fetch(`/api/devices/admin/device/${encodeURIComponent(id)}`,{cache:"no-store"}); const data=await r.json(); if(!r.ok) throw new Error(data.error||"Could not load device details"); renderSummary(data.device||{}); renderEvents(Array.isArray(data.events)?data.events:[]); showMessage("Device details loaded.","ok"); }
    catch(e){ showMessage(e.message,"err"); }
  }

  createBtn.addEventListener("click", createPairing);
  refreshBtn.addEventListener("click", () => refreshDevices(false));
  refreshDevices(true);
})();
