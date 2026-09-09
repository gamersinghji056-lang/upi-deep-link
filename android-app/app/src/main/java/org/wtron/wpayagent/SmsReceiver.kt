package org.wtron.wpayagent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val pendingResult = goAsync()
        Thread {
            try {
                val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
                if (messages.isEmpty()) return@Thread

                val sender = messages.firstOrNull()?.originatingAddress.orEmpty()
                val body = messages.joinToString(separator = "") { it.displayMessageBody.orEmpty() }.trim()
                val receivedAt = messages.maxOfOrNull { it.timestampMillis } ?: System.currentTimeMillis()
                if (body.isBlank()) return@Thread

                val store = AgentStore(context)
                store.recordSmsBroadcast(sender, body, receivedAt)

                if (!store.isPaired) {
                    store.recordClassification("RECEIVED_NOT_PAIRED", null, null)
                    return@Thread
                }

                SmsProcessor.capture(
                    context = context,
                    sender = sender,
                    body = body,
                    receivedAt = receivedAt,
                    scheduleUpload = true
                )

                CreditRetryScheduler.ensurePeriodic(context)
            } catch (error: Exception) {
                AgentStore(context).recordUploadError("SMS receiver: ${error.message ?: error.javaClass.simpleName}")
            } finally {
                pendingResult.finish()
            }
        }.start()
    }
}
