(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Upi = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const packages = Object.freeze({ phonepe: "com.phonepe.app", gpay: "com.google.android.apps.nbu.paisa.user", paytm: "net.one97.paytm" });
  const known = ["pa", "pn", "am", "cu", "tr", "tid", "mc", "mode", "orgid", "purpose", "url", "sign", "tn"];

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

  function setField(raw, key, value) {
    const parsed = parse(raw);
    const entry = parsed.entries.find(e => e.key === key);
    if (!entry) return append(raw, key, value);
    if (entry.value === String(value)) return raw;

    const hash = raw.indexOf("#");
    const head = hash < 0 ? raw : raw.slice(0, hash);
    const fragment = hash < 0 ? "" : raw.slice(hash);
    const q = head.indexOf("?");
    const prefix = head.slice(0, q + 1);
    const segments = head.slice(q + 1).split("&");
    segments[entry.index] = entry.rawKey + "=" + encodeURIComponent(value);
    return prefix + segments.join("&") + fragment;
  }

  function fillEmpty(raw, key, value) {
    const parsed = parse(raw);
    const entry = parsed.entries.find(e => e.key === key);
    if (!entry) return append(raw, key, value);
    if (entry.rawValue !== "") return raw;
    return setField(raw, key, value);
  }

  function amount(value) {
    const text = String(value ?? "");
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(text) || Number(text) <= 0) throw new Error("Enter a positive INR amount with at most two decimal places.");
    return Number(text).toFixed(2);
  }

  function transactionRef(value) {
    const text = String(value ?? "");
    if (!/^\d{1,35}$/.test(text)) throw new Error("Transaction reference must contain 1 to 35 digits.");
    return text;
  }

  function mode(value) {
    if (value === "scan") return "amount_only";
    if (value === undefined || value === "") return "exact";
    if (!["exact", "amount_only", "standard", "merchant_intent", "compat", "web_intent"].includes(value)) throw new Error("Unknown payment profile.");
    return value;
  }

  function build(raw, value, profile, ref, note) {
    const parsed = parse(raw);
    const selected = mode(profile);
    if (selected === "exact") return raw;

    const signed = parsed.entries.some(e => String(e.key || "").toLowerCase() === "sign");
    let final = raw;

    if (selected === "compat" || selected === "web_intent") {
      final = fillEmpty(final, "tn", String(note || "Payment"));
      final = fillEmpty(final, "am", amount(value));

      if (selected === "web_intent") {
        // UPI initiation mode must match the channel actually used. QR payloads commonly
        // carry mode=01/02, while an app handoff/deep link is an Intent transaction (04).
        // Never rewrite a signed payload because that would invalidate its signature.
        if (signed && parse(final).fields.mode[0] !== "04") {
          throw new Error("Signed QR cannot be converted from QR mode to intent mode. Use the issuer/provider intent.");
        }
        if (!signed) final = setField(final, "mode", "04");
      }
    } else {
      if (!parsed.entries.some(e => e.key === "am")) final = append(final, "am", amount(value));
      if ((selected === "standard" || selected === "merchant_intent") && !parsed.entries.some(e => e.key === "cu")) {
        final = append(final, "cu", "INR");
      }
      if (selected === "merchant_intent" && !parsed.entries.some(e => e.key === "tr")) {
        final = append(final, "tr", transactionRef(ref));
      }
    }

    if (final !== raw && signed) {
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
    if (/Android/i.test(userAgent)) return androidIntent(raw, app) || raw;
    if (/iPhone|iPad|iPod/i.test(userAgent)) return iosUri(raw, app) || raw;
    return raw;
  }

  function manual(pa, pn, value, tn) {
    const entries = [["pa", pa], ["pn", pn || "UPI Payment"], ["am", amount(value)], ["cu", "INR"], ["mode", "04"]];
    if (tn) entries.push(["tn", tn]);
    const raw = "upi://pay?" + entries.map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
    parse(raw);
    return raw;
  }

  return { parse, build, mode, amount, transactionRef, manual, targets, target, packages, androidIntent, phonepeNative, fillEmpty, setField };
});
