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

        val exactEvent = CreditSmsParser.parse(body, sender, receivedAt)
        val reviewCandidate = if (exactEvent == null) CreditSmsParser.parseCandidate(body, sender, receivedAt) else null

        // Only payment-credit SMS is handled. OTP/personal messages are ignored.
        if (exactEvent == null && reviewCandidate == null) return

        val eventStore = SmsEventStore(context)
        if (exactEvent != null) {
            eventStore.add(
                kind = "EXACT",
                reference = exactEvent.utr,
                amount = exactEvent.amount,
                sender = exactEvent.sender,
                body = body,
                receivedAt = exactEvent.receivedAt
            )
            store.saveLastEvent("Credit captured: UTR ${exactEvent.utr.takeLast(6)}, INR ${"%.2f".format(exactEvent.amount)}. Sending to server...")
        } else if (reviewCandidate != null) {
            eventStore.add(
                kind = "CANDIDATE",
                reference = reviewCandidate.referenceCandidate,
                amount = reviewCandidate.amount,
                sender = reviewCandidate.sender,
                body = body,
                receivedAt = reviewCandidate.receivedAt
            )
            store.saveLastEvent("Credit captured for review: ${reviewCandidate.referenceCandidate.length}-digit reference, INR ${"%.2f".format(reviewCandidate.amount)}.")
        }

        context.sendBroadcast(Intent(MonitorActivity.ACTION_FEED_UPDATED).setPackage(context.packageName))
        CreditRetryScheduler.enqueue(context)
    }
}
