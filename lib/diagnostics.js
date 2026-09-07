const crypto = require("node:crypto");
const Upi = require("../public/upi");

function fingerprint(value) {
  if (value === null || value === undefined) return null;
  return { characters: Array.from(value).length, utf16Length: value.length, utf8Bytes: Buffer.byteLength(value), sha256: crypto.createHash("sha256").update(value, "utf8").digest("hex") };
}
function compare(before, after) {
  if (before === null || before === undefined) return { available: false, reason: "Original URI was not recorded for this legacy row." };
  const a = Array.from(before), b = Array.from(after), differences = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) differences.push({ characterIndex: i, before: a[i] ?? null, after: b[i] ?? null, beforeCodePoint: a[i]?.codePointAt(0) ?? null, afterCodePoint: b[i]?.codePointAt(0) ?? null });
  }
  return { available: true, equal: before === after, before: fingerprint(before), after: fingerprint(after), differences };
}
function diagnose(row) {
  const original = row.original_upi_uri ?? null;
  const stored = row.upi_uri;
  const final = stored; // Checkout uses the stored provider result; never rebuild on GET.
  const targets = Upi.targets(final);
  const parsed = Upi.parse(final);
  const variants = Object.fromEntries(["exact", "amount_only", "standard"].map(profile => {
    if (original === null) return [profile, { unavailable: "Original URI was not recorded." }];
    try { const uri = Upi.build(original, row.requested_amount ?? row.amount, profile); return [profile, { uri, comparison: compare(original, uri) }]; }
    catch (error) { return [profile, { error: error.message }]; }
  }));
  const warnings = [];
  if (parsed.entries.some(e => e.rawValue.includes("+"))) warnings.push("Literal + present: percent-decoded and form-decoded readings are both shown; launch bytes are unchanged.");
  if (parsed.entries.some(e => e.key === null || e.value === null)) warnings.push("Malformed percent encoding exists in the input; it was not repaired.");
  if (parsed.entries.some((e, i, all) => all.findIndex(other => other.key === e.key) !== i)) warnings.push("Duplicate parameters exist in the original payload and are preserved.");
  if (parsed.fragment) warnings.push("Fragment preserved for generic launch; package targeting is unavailable to avoid changing it.");
  if (new URL(final).href !== final) warnings.push("Browser URL serialization changes this URI. Checkout will refuse that launch; obtain a correctly encoded original from the issuer.");
  return {
    originalQr: row.source === "merchant" ? original : null, originalInputUri: original,
    storedUri: stored, finalGenericUri: final,
    phonePeAndroidIntent: targets.android.phonepe, googlePayAndroidIntent: targets.android.gpay, paytmAndroidIntent: targets.android.paytm,
    appSpecificUris: targets.ios, parsedFields: parsed.fields, unknownParameters: parsed.unknown, entries: parsed.entries,
    parsedOriginal: original === null ? null : Upi.parse(original),
    hashes: { original: fingerprint(original), stored: fingerprint(stored), generic: fingerprint(final) },
    comparisons: { originalToStored: compare(original, stored), storedToGeneric: compare(stored, final), androidToGeneric: Object.fromEntries(Object.entries(targets.android).map(([app, uri]) => [app, uri ? compare(final, "upi:" + uri.slice(7, uri.indexOf("#Intent;"))) : { available: false }])) },
    browserSerialization: Object.fromEntries([['generic', final], ...Object.entries(targets.android)].filter(([, uri]) => uri).map(([app, uri]) => [app, { input: uri, serialized: new URL(uri).href, comparison: compare(uri, new URL(uri).href) }])),
    profile: row.profile, provider: row.provider || "static_qr", variants, warnings,
    boundary: "These are server/build/browser-serialization observations, not a capture from inside the receiving UPI app. No payment success is inferred."
  };
}
module.exports = { compare, fingerprint, diagnose };
