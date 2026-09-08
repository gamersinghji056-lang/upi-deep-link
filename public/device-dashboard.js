(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const createBtn = $("createPairingCode");
  const refreshBtn = $("refreshDevices");
  const refreshSelectedBtn = $("refreshSelectedDevice");
  const codeBox = $("pairingCode");
  const msg = $("deviceMsg");
  const grid = $("deviceGrid");
  const summary = $("deviceSummaryCard");
  const empty = $("deviceEmptyState");
  const eventsBody = $("deviceEventsBody");
  const otpEventsBody = $("otpEventsBody");
  const utrPanel = $("utrEventsPanel");
  const otpPanel = $("otpEventsPanel");
  const eventTitle = $("eventTitle");
  const eventDescription = $("eventDescription");
  const eventTabs = Array.from(document.querySelectorAll("[data-event-tab]"));
  if (!createBtn || !refreshBtn || !codeBox || !msg || !grid || !summary || !eventsBody || !otpEventsBody) return;

  let devices = [];
  let selectedId = "";
  let selectedDevice = null;
  let activeEventTab = "utr";
  let autoTimer = null;
  let refreshBusy = false;
  let detailBusy = false;

  function showMessage(text, type = "muted") { msg.className = "msg " + type; msg.textContent = text; }
  function esc(value) { return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#039;"); }
  function when(value) { if (!value) return "—"; const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString(); }
  function amount(value) { const n = Number(value); return Number.isFinite(n) ? n.toFixed(2) : "—"; }
  function online(value) { const t = new Date(value || 0).getTime(); return Number.isFinite(t) && Date.now() - t <= 2 * 60 * 1000; }
  function deviceName(d) { return [d?.manufacturer,d?.model].filter(Boolean).join(" ") || d?.id || "—"; }
  function redirectIfUnauthorized(response) { if (response && response.status === 401) { location.replace("/login"); return true; } return false; }

  function normalizePhone(value) { return String(value || "").replace(/\D/g, ""); }
  function identityKey(d) {
    const phone = normalizePhone(d?.phone_e164);
    if (phone) return "phone:" + phone;
    const sim = [d?.sim_subscription_label,d?.sim_carrier].filter(Boolean).join("|").trim().toLowerCase();
    if (sim) return "sim:" + sim;
    return "device:" + [d?.manufacturer,d?.model,d?.android_version].filter(Boolean).join("|").toLowerCase();
  }

  function dedupeDevices(raw) {
    const sorted = [...raw].sort((a,b) => new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0));
    const groups = new Map();
    for (const d of sorted) {
      const key = identityKey(d);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    return Array.from(groups.values()).map(group => {
      const latest = group[0];
      return { ...latest, _aliasIds: group.map(x => x.id), _duplicateCount: group.length };
    });
  }

  function mergeEvents(chunks, timeField) {
    const map = new Map();
    for (const list of chunks) for (const item of list || []) {
      const key = [item.id,item.utr,item.sender,item.sms_received_at,item.created_at,item.message_masked,item.sms_body].join("|");
      if (!map.has(key)) map.set(key, item);
    }
    return Array.from(map.values()).sort((a,b) => new Date(b[timeField] || b.created_at || 0) - new Date(a[timeField] || a.created_at || 0));
  }

  async function refreshApkInfo() {
    const link = $("apkDownloadLink");
    const versionLabel = $("apkVersion");
    if (link) link.href = "/downloads/WPAY-Agent.apk?fresh=" + Date.now();
    try {
      const r = await fetch("/downloads/WPAY-Agent.json?fresh=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json();
      const version = String(data.version || "").trim();
      const commit = String(data.commit || "").trim();
      if (versionLabel && version) versionLabel.textContent = "v" + version;
      if (link) link.href = "/downloads/WPAY-Agent.apk?v=" + encodeURIComponent(commit || version || Date.now());
    } catch { }
  }

  function ensureLogoutButton() {
    const side = document.querySelector(".side");
    if (!side || $("logoutDashboard")) return;
    const button = document.createElement("button");
    button.id = "logoutDashboard";
    button.type = "button";
    button.textContent = "Log out";
    button.style.cssText = "margin:18px 8px 0;width:calc(100% - 16px);border:1px solid #30415f;border-radius:12px;padding:11px 12px;background:#131d30;color:#dce6f6;font-weight:800;cursor:pointer";
    button.addEventListener("click", async () => {
      try { await fetch("/api/dashboard/logout", { method: "POST" }); } catch { }
      location.replace("/login");
    });
    side.appendChild(button);
  }

  function renderCards() {
    if (!devices.length) { grid.innerHTML = '<div class="muted">No Android device has been paired yet.</div>'; return; }
    grid.innerHTML = devices.map(d => {
      const isOnline = online(d.last_seen_at);
      const title = deviceName(d);
      return `<button class="device-card${d.id===selectedId?' selected':''}" data-device-id="${esc(d.id)}"><div class="device-card-head"><strong>${esc(title)}</strong><span class="state-pill ${isOnline?'online':'offline'}">${isOnline?'Online':'Offline'}</span></div><div class="device-card-meta">SIM: ${esc(d.phone_e164 || d.sim_subscription_label || d.sim_carrier || 'Unavailable')}</div><div class="device-card-meta">Battery: ${d.battery_level==null?'—':Math.round(Number(d.battery_level))+'%'}</div><div class="device-card-meta">Network: ${esc(d.network_type || '—')}</div><div class="device-card-meta">Last UTR: ${esc(d.last_utr || '—')}</div>${d._duplicateCount>1?`<div class="device-card-meta" style="color:#8f82b8">Previous pairings merged: ${d._duplicateCount}</div>`:''}</button>`;
    }).join("");
    grid.querySelectorAll("[data-device-id]").forEach(btn => btn.addEventListener("click", () => loadDevice(btn.dataset.deviceId, false)));
  }

  function renderSummary(d) {
    selectedDevice = d;
    empty.hidden = true; summary.hidden = false;
    const isOnline = online(d.last_seen_at);
    const loc = d.latitude==null || d.longitude==null ? "Unavailable" : `${Number(d.latitude).toFixed(6)}, ${Number(d.longitude).toFixed(6)}`;
    summary.innerHTML = `<div class="device-card-head"><div><strong>${esc(deviceName(d))}</strong><div class="muted small">${esc(d.id)}</div></div><span class="state-pill ${isOnline?'online':'offline'}">${isOnline?'Online':'Offline'}</span></div><div class="detail-grid"><div class="detail"><span>Location</span><strong>${esc(loc)}</strong><small>${d.location_accuracy==null?'Accuracy unavailable':'± '+esc(d.location_accuracy)+' m'}</small></div><div class="detail"><span>SIM card / phone number</span><strong>${esc(d.phone_e164 || 'Not exposed by Android/device')}</strong><small>${esc(d.sim_carrier || d.network_carrier || 'Carrier unavailable')}</small></div><div class="detail"><span>Battery health</span><strong>${d.battery_level==null?'—':Math.round(Number(d.battery_level))+'%'}</strong><small>${d.charging?'Charging':'Not charging'}</small></div><div class="detail"><span>Connection network</span><strong>${esc(d.network_type || '—')}</strong><small>${esc(d.network_carrier || d.sim_carrier || '—')}</small></div><div class="detail"><span>Status</span><strong>${isOnline?'Online':'Offline'}</strong><small>Last seen ${esc(when(d.last_seen_at))}</small></div><div class="detail"><span>App / Android</span><strong>${esc(d.app_version || '—')}</strong><small>Android ${esc(d.android_version || '—')}</small></div></div>`;
  }

  function renderEvents(events) {
    if (!events.length) { eventsBody.innerHTML='<tr><td colspan="6" class="muted">No credit / UTR events yet.</td></tr>'; return; }
    eventsBody.innerHTML = events.map(e => `<tr><td>${esc(when(e.created_at || e.received_at))}</td><td>${esc(e.utr || '—')}</td><td>₹ ${esc(amount(e.amount))}</td><td>${esc(e.sender || '—')}</td><td>${esc(e.status || '—')}</td><td class="sms-cell">${esc(e.sms_body || '—')}</td></tr>`).join("");
  }

  function renderOtpEvents(events, phone, name) {
    if (!events.length) { otpEventsBody.innerHTML='<tr><td colspan="8" class="muted">No masked OTP events yet.</td></tr>'; return; }
    otpEventsBody.innerHTML = events.map(e => `<tr><td>${esc(when(e.sms_received_at || e.created_at))}</td><td class="otp-code">${esc(e.code_mask || '—')}</td><td>${esc(e.sender || '—')}</td><td class="sms-cell">${esc(e.message_masked || '—')}</td><td class="mobile-full">${esc(phone || 'Unavailable')}</td><td>${esc(name)}</td><td>${esc(e.source || 'sms')}</td><td class="event-status">Received</td></tr>`).join("");
  }

  function setEventTab(tab) {
    activeEventTab = tab === "otp" ? "otp" : "utr";
    eventTabs.forEach(btn => btn.classList.toggle("active", btn.dataset.eventTab === activeEventTab));
    if (utrPanel) utrPanel.hidden = activeEventTab !== "utr";
    if (otpPanel) otpPanel.hidden = activeEventTab !== "otp";
    if (eventTitle) eventTitle.textContent = activeEventTab === "otp" ? "OTP Events" : "Credit / UTR Events";
    if (eventDescription) eventDescription.textContent = activeEventTab === "otp"
      ? "Masked OTP and SMS events from the selected device. Real OTP digits are replaced before upload; the linked mobile number is shown in full."
      : "Bank credit messages received from the selected WPAY Agent device.";
  }

  async function createPairing() {
    createBtn.disabled = true; showMessage("Creating one-time pairing code...");
    try {
      const r = await fetch("/api/devices/admin/pairing-token", { method:"POST", headers:{"Content-Type":"application/json"}, body:"{}" });
      if (redirectIfUnauthorized(r)) return;
      const data = await r.json(); if (!r.ok) throw new Error(data.error || "Could not create pairing code");
      codeBox.textContent = data.pairingCode; codeBox.hidden = false; showMessage("Pairing code created. It expires in 10 minutes.", "ok");
    } catch (e) { codeBox.hidden = true; showMessage(e.message, "err"); } finally { createBtn.disabled = false; }
  }

  async function refreshDevices(autoSelect = false, silent = false) {
    if (refreshBusy) return;
    refreshBusy = true;
    if (!silent) { refreshBtn.disabled = true; showMessage("Loading connected devices..."); }
    try {
      const r = await fetch("/api/devices/admin/list", { cache:"no-store" });
      if (redirectIfUnauthorized(r)) return;
      const data = await r.json(); if (!r.ok) throw new Error(data.error || "Could not load devices");
      devices = dedupeDevices(Array.isArray(data.devices) ? data.devices : []);
      $("connectedCount").textContent = String(devices.length);
      $("lastUtr").textContent = devices.find(d=>d.last_utr)?.last_utr || "—";
      $("deviceHealth").textContent = devices.some(d=>online(d.last_seen_at)) ? "Online" : (devices.length ? "Offline" : "Not connected");
      if (selectedId && !devices.some(d => d.id === selectedId)) {
        const selectedPhone = normalizePhone(selectedDevice?.phone_e164);
        const replacement = selectedPhone ? devices.find(d => normalizePhone(d.phone_e164) === selectedPhone) : null;
        if (replacement) selectedId = replacement.id;
      }
      renderCards();
      if (selectedId && devices.some(d=>d.id===selectedId)) await loadDevice(selectedId, true);
      else if (autoSelect && devices.length) await loadDevice(devices[0].id, true);
      else if (!devices.length) {
        selectedDevice = null;
        if (refreshSelectedBtn) refreshSelectedBtn.disabled = true;
        summary.hidden=true; empty.hidden=false;
        eventsBody.innerHTML='<tr><td colspan="6" class="muted">No connected device.</td></tr>';
        otpEventsBody.innerHTML='<tr><td colspan="8" class="muted">No connected device.</td></tr>';
      }
      if (!silent) showMessage("Device list updated.", "ok");
    } catch(e){ if (!silent) showMessage(e.message,"err"); }
    finally { refreshBusy = false; if (!silent) refreshBtn.disabled=false; }
  }

  async function loadDevice(id, silent = false) {
    if (detailBusy && silent) return;
    detailBusy = true;
    selectedId = id;
    const group = devices.find(d => d.id === id);
    const aliasIds = group?._aliasIds?.length ? group._aliasIds : [id];
    renderCards();
    if (!silent) showMessage("Loading device details...");
    if (refreshSelectedBtn && !silent) refreshSelectedBtn.disabled = true;
    try {
      const pairs = await Promise.all(aliasIds.map(async aliasId => {
        const [detailResponse, otpResponse] = await Promise.all([
          fetch(`/api/devices/admin/device/${encodeURIComponent(aliasId)}`,{cache:"no-store"}),
          fetch(`/api/devices/admin/device/${encodeURIComponent(aliasId)}/otp-events`,{cache:"no-store"})
        ]);
        if (redirectIfUnauthorized(detailResponse) || redirectIfUnauthorized(otpResponse)) throw new Error("Dashboard login required");
        const detailData = await detailResponse.json();
        const otpData = await otpResponse.json();
        if(!detailResponse.ok) throw new Error(detailData.error||"Could not load device details");
        if(!otpResponse.ok) throw new Error(otpData.error||"Could not load OTP events");
        return { detailData, otpData };
      }));

      const detailDevices = pairs.map(x => x.detailData.device || {}).sort((a,b) => new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0));
      const latest = { ...(group || {}), ...(detailDevices[0] || {}) };
      renderSummary(latest);
      const creditEvents = mergeEvents(pairs.map(x => Array.isArray(x.detailData.events) ? x.detailData.events : []), "created_at");
      const otpEvents = mergeEvents(pairs.map(x => Array.isArray(x.otpData.events) ? x.otpData.events : []), "sms_received_at");
      renderEvents(creditEvents);
      renderOtpEvents(otpEvents, latest.phone_e164 || group?.phone_e164, deviceName(latest));
      if (!silent) showMessage("Device details loaded.","ok");
    } catch(e){ if (!silent && e.message !== "Dashboard login required") showMessage(e.message,"err"); }
    finally { detailBusy = false; if (refreshSelectedBtn) refreshSelectedBtn.disabled = false; }
  }

  createBtn.addEventListener("click", createPairing);
  refreshBtn.addEventListener("click", () => refreshDevices(false, false));
  if (refreshSelectedBtn) refreshSelectedBtn.addEventListener("click", () => selectedId && loadDevice(selectedId, false));
  eventTabs.forEach(btn => btn.addEventListener("click", () => setEventTab(btn.dataset.eventTab)));
  setEventTab("utr");
  ensureLogoutButton();
  refreshApkInfo();
  refreshDevices(true, false);
  autoTimer = setInterval(() => refreshDevices(false, true), 4000);
  window.addEventListener("beforeunload", () => { if (autoTimer) clearInterval(autoTimer); });
})();
