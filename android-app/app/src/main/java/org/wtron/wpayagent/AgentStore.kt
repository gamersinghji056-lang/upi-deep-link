package org.wtron.wpayagent

import android.content.Context
import java.util.UUID

class AgentStore(context: Context) {
    private val prefs = context.getSharedPreferences("wpay_agent", Context.MODE_PRIVATE)

    val deviceId: String?
        get() = prefs.getString("device_id", null)

    val deviceToken: String?
        get() = prefs.getString("device_token", null)

    val simFingerprint: String?
        get() = prefs.getString("sim_fingerprint", null)

    val lastEvent: String
        get() = prefs.getString("last_event", "No SMS event processed yet.") ?: "No SMS event processed yet."

    val lastSmsBroadcastAt: Long
        get() = prefs.getLong("last_sms_broadcast_at", 0L)

    val lastSmsSender: String
        get() = prefs.getString("last_sms_sender", "") ?: ""

    val lastSmsPreview: String
        get() = prefs.getString("last_sms_preview", "") ?: ""

    val lastClassification: String
        get() = prefs.getString("last_sms_classification", "No SMS classified yet") ?: "No SMS classified yet"

    val lastClassificationAt: Long
        get() = prefs.getLong("last_sms_classification_at", 0L)

    val lastUploadAt: Long
        get() = prefs.getLong("last_upload_at", 0L)

    val lastUploadSummary: String
        get() = prefs.getString("last_upload_summary", "No event uploaded yet") ?: "No event uploaded yet"

    val lastUploadError: String
        get() = prefs.getString("last_upload_error", "") ?: ""

    val lastInboxRefreshAt: Long
        get() = prefs.getLong("last_inbox_refresh_at", 0L)

    val lastInboxRefreshSummary: String
        get() = prefs.getString("last_inbox_refresh_summary", "Never refreshed") ?: "Never refreshed"

    val isPaired: Boolean
        get() = !deviceId.isNullOrBlank() && !deviceToken.isNullOrBlank() && !simFingerprint.isNullOrBlank()

    fun getOrCreateDeviceId(): String {
        deviceId?.let { return it }
        val value = "wpay-" + UUID.randomUUID().toString().replace("-", "")
        prefs.edit().putString("device_id", value).apply()
        return value
    }

    fun savePairing(deviceId: String, token: String, simFingerprint: String) {
        prefs.edit()
            .putString("device_id", deviceId)
            .putString("device_token", token)
            .putString("sim_fingerprint", simFingerprint)
            .apply()
    }

    fun saveLastEvent(value: String) {
        prefs.edit().putString("last_event", value.take(500)).apply()
    }

    fun recordSmsBroadcast(sender: String, body: String, receivedAt: Long) {
        prefs.edit()
            .putLong("last_sms_broadcast_at", receivedAt)
            .putString("last_sms_sender", sender.take(120))
            .putString("last_sms_preview", body.replace(Regex("\\s+"), " ").take(180))
            .apply()
    }

    fun recordClassification(kind: String, amount: Double?, reference: String?) {
        val summary = buildString {
            append(kind)
            if (amount != null && amount > 0) append(" · INR ").append("%.2f".format(amount))
            if (!reference.isNullOrBlank()) append(" · ref ").append(reference)
        }
        prefs.edit()
            .putLong("last_sms_classification_at", System.currentTimeMillis())
            .putString("last_sms_classification", summary.take(220))
            .apply()
    }

    fun recordUploadSuccess(reference: String, status: String) {
        prefs.edit()
            .putLong("last_upload_at", System.currentTimeMillis())
            .putString("last_upload_summary", "${reference.takeLast(12)} · ${status.ifBlank { "received" }}")
            .putString("last_upload_error", "")
            .apply()
    }

    fun recordUploadError(error: String) {
        prefs.edit()
            .putString("last_upload_error", error.take(220))
            .apply()
    }

    fun recordInboxRefresh(scanned: Int, credits: Int, otps: Int, newestAt: Long?, oldestAt: Long?) {
        val range = if (newestAt != null && oldestAt != null) "$newestAt..$oldestAt" else "empty"
        prefs.edit()
            .putLong("last_inbox_refresh_at", System.currentTimeMillis())
            .putString("last_inbox_refresh_summary", "$scanned checked · $credits credit · $otps OTP · $range")
            .apply()
    }

    fun clearPairing() {
        prefs.edit()
            .remove("device_token")
            .remove("sim_fingerprint")
            .apply()
    }
}
