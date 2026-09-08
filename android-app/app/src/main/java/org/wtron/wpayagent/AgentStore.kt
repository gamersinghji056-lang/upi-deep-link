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
        get() = prefs.getString("last_event", "No credit SMS processed yet.") ?: "No credit SMS processed yet."

    val pendingCreditJson: String?
        get() = prefs.getString("pending_credit_json", null)

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

    fun savePendingCredit(json: String) {
        prefs.edit().putString("pending_credit_json", json).apply()
    }

    fun clearPendingCredit() {
        prefs.edit().remove("pending_credit_json").apply()
    }

    fun clearPairing() {
        prefs.edit()
            .remove("device_token")
            .remove("sim_fingerprint")
            .remove("pending_credit_json")
            .apply()
    }
}
