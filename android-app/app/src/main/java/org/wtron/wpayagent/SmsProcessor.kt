package org.wtron.wpayagent

import android.content.Context
import android.content.Intent

object SmsProcessor {
    data class Result(
        val isCredit: Boolean,
        val kind: String,
        val amount: Double? = null,
        val reference: String? = null,
        val otpCode: String? = null
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

        val exactEvent = CreditSmsParser.parse(cleanBody, sender, receivedAt)
        val reviewCandidate = if (exactEvent == null) {
            CreditSmsParser.parseCandidate(cleanBody, sender, receivedAt)
        } else null
        val creditWithoutReference = if (exactEvent == null && reviewCandidate == null) {
            CreditSmsParser.parseWithoutReference(cleanBody, sender, receivedAt)
        } else null
        val detectedOtp = if (exactEvent == null && reviewCandidate == null && creditWithoutReference == null) {
            OtpDetector.detect(cleanBody)
        } else null

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
            creditWithoutReference != null -> {
                eventStore.add(
                    kind = "CREDIT_NO_REF",
                    reference = "",
                    amount = creditWithoutReference.amount,
                    sender = creditWithoutReference.sender,
                    body = cleanBody,
                    receivedAt = creditWithoutReference.receivedAt,
                    uploadable = true
                )
                AgentStore(context).saveLastEvent(
                    "UPI credit captured without UTR, INR ${"%.2f".format(creditWithoutReference.amount)}."
                )
                Result(true, "CREDIT_NO_REF", creditWithoutReference.amount, null)
            }
            detectedOtp != null -> {
                eventStore.add(
                    kind = "OTP_DETECTED",
                    reference = detectedOtp.code,
                    amount = 0.0,
                    sender = sender,
                    body = "OTP received (${detectedOtp.otpLength} digits)",
                    receivedAt = receivedAt,
                    uploadable = true
                )
                AgentStore(context).saveLastEvent(
                    "OTP event detected (${detectedOtp.otpLength} digits)."
                )
                Result(false, "OTP_DETECTED", null, detectedOtp.code, detectedOtp.code)
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
        if ((result.isCredit || result.kind == "OTP_DETECTED") && scheduleUpload) {
            CreditRetryScheduler.enqueue(context)
        }
        return result
    }
}