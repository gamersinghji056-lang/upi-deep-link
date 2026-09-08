package org.wtron.wpayagent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val store = AgentStore(context)
        if (!store.isPaired) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isEmpty()) return

        val sender = messages.firstOrNull()?.originatingAddress.orEmpty()
        val body = messages.joinToString(separator = "") { it.displayMessageBody.orEmpty() }.trim()
        val receivedAt = messages.maxOfOrNull { it.timestampMillis } ?: System.currentTimeMillis()
        if (body.isBlank()) return

        SmsProcessor.capture(
            context = context,
            sender = sender,
            body = body,
            receivedAt = receivedAt,
            scheduleUpload = true
        )

        CreditRetryScheduler.ensurePeriodic(context)
    }
}
