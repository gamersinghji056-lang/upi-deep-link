(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Upi = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const packages = Object.freeze({ phonepe: "com.phonepe.app", gpay: "com.google.android.apps.nbu.paisa.user", paytm: "net.one97.paytm" });
  const known = ["pa", "pn", "am", "cu", "tr", "tid", "mc", "mode", "orgid", "purpose", "url", "sign", "tn"];

  // Inspection only. Never serialize these decoded fields back into a QR URI.
  // Unlike form encoding, a literal '+' stays a literal '+'. Both readings are shown.
  function parse(raw) {
    if (typeof raw !== "string" || !/^upi:\/\/pay\?/i.test(raw) || /[\u0000-\u0020\u007f]/.test(raw)) {
      throw new Error("Expected a UPI URI without raw spaces or control characters; input was not modified.");
    }
    const start = raw.indexOf("?") + 1;
    const end = raw.indexOf("#", start);
    const query = raw.slice(start, end < 0 ? raw.length : end);
    const entries = query.split("&").map((segment, index) => {
      const equal = segment.indexOf("=");
      const rawKey = equal < 0 ? segment : segment.slice(0, equal);
      const rawValue = equal < 0 ? "" : segment.slice(equal + 1);
      const decode = value => { try { return decodeURIComponent(value); } catch { return null; } };
      return { index, raw: segment, rawKey, rawValue, key: decode(rawKey), value: decode(rawValue), formValue: decode(rawValue.replace(/\+/g, " ")) };
    });
    const fields = Object.fromEntries(known.map(key => [key, entries.filter(e => e.key === key).map(e => e.value)]));
    const pa = fields.pa[0];
    if (!pa || !/^[^\s@]+@[^\s@]+$/.test(pa)) throw new Error("Invalid VPA in UPI URI.");
    return { entries, fields, unknown: entries.filter(e => !known.includes(e.key)), fragment: end < 0 ? "" : raw.slice(end) };
  }

  function append(raw, key, value) {
    const hash = raw.indexOf("#");
    const head = hash < 0 ? raw : raw.slice(0, hash);
    return head + (/[?&]$/.test(head) ? "" : "&") + key + "=" + encodeURIComponent(value) + (hash < 0 ? "" : raw.slice(hash));
  }

  function amount(value) {
    const text = String(value ?? "");
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(text) || Number(text) <= 0) throw new Error("Enter a positive INR amount with at most two decimal places.");
    return Number(text).toFixed(2);
  }

  function mode(value) {
    if (value === "scan") return "amount_only"; // Existing API clients remain compatible.
    if (value === undefined || value === "") return "exact";
    if (!["exact", "amount_only", "standard"].includes(value)) throw new Error("Unknown payment profile.");
    return value;
  }

  function build(raw, value, profile) {
    const parsed = parse(raw);
    const selected = mode(profile);
    if (selected === "exact") return raw;
    let final = raw;
    if (!parsed.entries.some(e => e.key === "am")) final = append(final, "am", amount(value));
    if (selected === "standard" && !parsed.entries.some(e => e.key === "cu")) final = append(final, "cu", "INR");
    // A signed input may be used verbatim, but never modified by an A/B mode.
    if (final !== raw && parsed.entries.some(e => e.key?.toLowerCase() === "sign")) {
      throw new Error("Signed QR cannot be modified. Use EXACT or obtain a new intent from the provider.");
    }
    return final;
  }

  function rawQuery(raw) {
    const parsed = parse(raw);
    if (parsed.fragment || !raw.startsWith("upi://pay?")) return null;
    return raw.slice(raw.indexOf("?") + 1);
  }

  function androidIntent(raw, app) {
    const query = rawQuery(raw);
    if (!Object.hasOwn(packages, app)) throw new Error("Unknown UPI app.");
    if (query === null) return null;
    const pkg = packages[app];
    return "intent://pay?" + query + "#Intent;scheme=upi;package=" + pkg + ";S.browser_fallback_url=" + encodeURIComponent("https://play.google.com/store/apps/details?id=" + pkg) + ";end";
  }

  // Controlled PhonePe-only experiment: preserve the exact UPI query and change only
  // the entry scheme. This is intentionally separate from the Android package intent.
  function phonepeNative(raw) {
    const query = rawQuery(raw);
    return query === null ? null : "phonepe://pay?" + query;
  }

  function iosUri(raw, app) {
    const query = rawQuery(raw);
    if (query === null) return null;
    const prefix = { gpay: "gpay://upi/pay?", phonepe: "phonepe://pay?", paytm: "paytmmp://pay?" }[app];
    return prefix ? prefix + query : raw;
  }

  function targets(raw) {
    parse(raw);
    return {
      generic: raw,
      phonepeNative: phonepeNative(raw),
      android: Object.fromEntries(Object.keys(packages).map(app => [app, androidIntent(raw, app)])),
      ios: Object.fromEntries(Object.keys(packages).map(app => [app, iosUri(raw, app)]))
    };
  }

  function target(raw, app, userAgent) {
    if (app === "generic") return raw;
    if (!Object.hasOwn(packages, app)) throw new Error("Unknown UPI app.");
    if (/Android/i.test(userAgent)) {
      if (app === "phonepe") return phonepeNative(raw) || androidIntent(raw, app) || raw;
      return androidIntent(raw, app) || raw;
    }
    if (/iPhone|iPad|iPod/i.test(userAgent)) return iosUri(raw, app) || raw;
    return raw;
  }

  function manual(pa, pn, value, tn) {
    const entries = [["pa", pa], ["pn", pn || "UPI Payment"], ["am", amount(value)], ["cu", "INR"]];
    if (tn) entries.push(["tn", tn]);
    const raw = "upi://pay?" + entries.map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
    parse(raw);
    return raw;
  }

  return { parse, build, mode, amount, manual, targets, target, packages, androidIntent, phonepeNative };
});
