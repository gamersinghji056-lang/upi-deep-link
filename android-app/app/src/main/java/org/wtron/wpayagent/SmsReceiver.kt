package org.wtron.wpayagent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import org.json.JSONObject
import java.time.Instant

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val store = AgentStore(context)
        if (!store.isPaired) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isEmpty()) return
        val sender = messages.firstOrNull()?.originatingAddress.orEmpty()
        val body = messages.joinToString(separator = "") { it.displayMessageBody.orEmpty() }
        val receivedAt = messages.maxOfOrNull { it.timestampMillis } ?: System.currentTimeMillis()
        val event = CreditSmsParser.parse(body, sender, receivedAt) ?: return

        val pending = goAsync()
        Thread {
            try {
                val sim = DeviceIdentity.currentSimInfo(context)
                if (!sim.hasActiveSim) {
                    store.saveLastEvent("Credit SMS detected, but no active SIM is available for verification.")
                    return@Thread
                }
                val payload = JSONObject()
                    .put("simFingerprint", sim.fingerprint)
                    .put("utr", event.utr)
                    .put("amount", event.amount)
                    .put("sender", event.sender)
                    .put("receivedAt", Instant.ofEpochMilli(event.receivedAt).toString())
                store.savePendingCredit(payload.toString())
                val response = ApiClient.creditSms(store, payload)
                store.clearPendingCredit()
                if (response.optBoolean("matched")) {
                    store.saveLastEvent("Payment verified: UTR ${event.utr.takeLast(6)}, INR ${"%.2f".format(event.amount)}")
                } else {
                    store.saveLastEvent("Credit received: UTR ${event.utr.takeLast(6)}, INR ${"%.2f".format(event.amount)}. Waiting for matching customer UTR.")
                }
            } catch (error: Exception) {
                store.saveLastEvent("Credit detected but upload is pending: ${error.message ?: "network error"}")
            } finally {
                pending.finish()
            }
        }.start()
    }
}
