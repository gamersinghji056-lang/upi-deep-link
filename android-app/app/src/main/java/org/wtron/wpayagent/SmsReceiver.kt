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
        val exactEvent = CreditSmsParser.parse(body, sender, receivedAt)
        val reviewCandidate = if (exactEvent == null) CreditSmsParser.parseCandidate(body, sender, receivedAt) else null
        if (exactEvent == null && reviewCandidate == null) return
        val pending = goAsync()
        Thread {
            try {
                val sim = DeviceIdentity.currentSimInfo(context)
                if (!sim.hasActiveSim) { store.saveLastEvent("Credit SMS detected, but no active SIM is available for verification."); return@Thread }
                if (exactEvent != null) {
                    val payload = JSONObject().put("simFingerprint", sim.fingerprint).put("utr", exactEvent.utr).put("amount", exactEvent.amount).put("sender", exactEvent.sender).put("smsBody", body.take(3000)).put("receivedAt", Instant.ofEpochMilli(exactEvent.receivedAt).toString())
                    store.savePendingCredit(payload.toString())
                    val response = ApiClient.creditSms(store, payload)
                    store.clearPendingCredit()
                    if (response.optBoolean("matched")) store.saveLastEvent("Payment verified: UTR ${exactEvent.utr.takeLast(6)}, INR ${"%.2f".format(exactEvent.amount)}") else store.saveLastEvent("Credit received: UTR ${exactEvent.utr.takeLast(6)}, INR ${"%.2f".format(exactEvent.amount)}. Waiting for matching customer UTR.")
                } else if (reviewCandidate != null) {
                    val payload = JSONObject().put("simFingerprint", sim.fingerprint).put("referenceCandidate", reviewCandidate.referenceCandidate).put("amount", reviewCandidate.amount).put("sender", reviewCandidate.sender).put("smsBody", body.take(3000)).put("receivedAt", Instant.ofEpochMilli(reviewCandidate.receivedAt).toString())
                    ApiClient.creditSmsCandidate(store, payload)
                    store.saveLastEvent("Credit SMS needs review: ${reviewCandidate.referenceCandidate.length}-digit reference, INR ${"%.2f".format(reviewCandidate.amount)}. Auto-success was not allowed.")
                }
            } catch (error: Exception) { store.saveLastEvent("Credit detected but upload is pending: ${error.message ?: "network error"}") } finally { pending.finish() }
        }.start()
    }
}
