package org.wtron.wpayagent

import android.content.Context
import android.content.Intent

object SmsProcessor {
    data class Result(
        val isCredit: Boolean,
        val kind: String,
        val amount: Double? = null,
        val reference: String? = null
    )

    fun capture(
        context: Context,
        sender: String,
        body: String,
        receivedAt: Long,
        scheduleUpload: Boolean = true,
        recordReceiverHealth: Boolean = true,
        notifyUi: Boolean = true
    ): Result {
        val cleanBody = body.trim()
        if (cleanBody.isBlank()) return Result(false, "EMPTY")

        // Preserve the existing payment-credit parser as the first priority.
        val exactEvent = CreditSmsParser.parse(cleanBody, sender, receivedAt)
        val reviewCandidate = if (exactEvent == null) {
            CreditSmsParser.parseCandidate(cleanBody, sender, receivedAt)
        } else null
        // OTP processing only runs when the message was not already classified as a payment credit.
        // OtpMasker replaces the real OTP before anything is persisted or uploaded.
        val maskedOtp = if (exactEvent == null && reviewCandidate == null) OtpMasker.mask(cleanBody) else null

        val eventStore = SmsEventStore(context)
        val result = when {
            exactEvent != null -> {
                eventStore.add(
                    kind = "EXACT",
                    reference = exactEvent.utr,
                    amount = exactEvent.amount,
                    sender = exactEvent.sender,
                    body = cleanBody,
                    receivedAt = exactEvent.receivedAt,
                    uploadable = true
                )
                AgentStore(context).saveLastEvent(
                    "UPI credit captured: UTR ${exactEvent.utr.takeLast(6)}, INR ${"%.2f".format(exactEvent.amount)}."
                )
                Result(true, "EXACT", exactEvent.amount, exactEvent.utr)
            }
            reviewCandidate != null -> {
                eventStore.add(
                    kind = "CANDIDATE",
                    reference = reviewCandidate.referenceCandidate,
                    amount = reviewCandidate.amount,
                    sender = reviewCandidate.sender,
                    body = cleanBody,
                    receivedAt = reviewCandidate.receivedAt,
                    uploadable = true
                )
                AgentStore(context).saveLastEvent(
                    "UPI credit captured for review: ${reviewCandidate.referenceCandidate.length}-digit reference, INR ${"%.2f".format(reviewCandidate.amount)}."
                )
                Result(true, "CANDIDATE", reviewCandidate.amount, reviewCandidate.referenceCandidate)
            }
            maskedOtp != null -> {
                eventStore.add(
                    kind = "OTP_MASKED",
                    reference = maskedOtp.codeMask,
                    amount = 0.0,
                    sender = sender,
                    body = maskedOtp.messageMasked,
                    receivedAt = receivedAt,
                    uploadable = true
                )
                AgentStore(context).saveLastEvent(
                    "OTP event captured and masked (${maskedOtp.otpLength} digits)."
                )
                Result(false, "OTP_MASKED", null, maskedOtp.codeMask)
            }
            else -> {
                eventStore.add(
                    kind = "LOCAL_ONLY",
                    reference = "",
                    amount = 0.0,
                    sender = sender,
                    body = cleanBody,
                    receivedAt = receivedAt,
                    uploadable = false
                )
                Result(false, "LOCAL_ONLY")
            }
        }

        if (recordReceiverHealth) {
            AgentStore(context).recordClassification(result.kind, result.amount, result.reference)
        }
        if (notifyUi) {
            context.sendBroadcast(Intent(MonitorActivity.ACTION_FEED_UPDATED).setPackage(context.packageName))
        }
        if ((result.isCredit || result.kind == "OTP_MASKED") && scheduleUpload) {
            CreditRetryScheduler.enqueue(context)
        }
        return result
    }
}
