package org.wtron.wpayagent

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Telephony

object SmsInboxScanner {
    data class ScanResult(
        val scanned: Int,
        val creditMessages: Int,
        val otpMessages: Int,
        val newestAt: Long?,
        val oldestAt: Long?
    )

    fun scanRecent(context: Context, limit: Int = 500): ScanResult {
        if (context.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            throw SecurityException("READ_SMS permission is required for inbox refresh")
        }

        val safeLimit = limit.coerceIn(1, 1000)
        val projection = arrayOf(
            Telephony.Sms._ID,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE
        )

        var scanned = 0
        var creditMessages = 0
        var otpMessages = 0
        var newestAt: Long? = null
        var oldestAt: Long? = null

        context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            projection,
            null,
            null,
            "${Telephony.Sms.DATE} DESC"
        )?.use { cursor ->
            val addressIndex = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
            val bodyIndex = cursor.getColumnIndex(Telephony.Sms.BODY)
            val dateIndex = cursor.getColumnIndex(Telephony.Sms.DATE)

            while (cursor.moveToNext() && scanned < safeLimit) {
                val sender = if (addressIndex >= 0) cursor.getString(addressIndex).orEmpty() else ""
                val body = if (bodyIndex >= 0) cursor.getString(bodyIndex).orEmpty() else ""
                val receivedAt = if (dateIndex >= 0) cursor.getLong(dateIndex) else System.currentTimeMillis()
                if (body.isBlank()) continue

                if (newestAt == null) newestAt = receivedAt
                oldestAt = receivedAt

                val result = SmsProcessor.capture(
                    context = context,
                    sender = sender,
                    body = body,
                    receivedAt = receivedAt,
                    scheduleUpload = false,
                    recordReceiverHealth = false,
                    notifyUi = false
                )
                scanned++
                if (result.isCredit) creditMessages++
                if (result.kind == "OTP_DETECTED") otpMessages++
            }
        }

        AgentStore(context).recordInboxRefresh(scanned, creditMessages, otpMessages, newestAt, oldestAt)
        context.sendBroadcast(Intent(MonitorActivity.ACTION_FEED_UPDATED).setPackage(context.packageName))
        if (creditMessages > 0 || otpMessages > 0) CreditRetryScheduler.enqueue(context)
        return ScanResult(scanned, creditMessages, otpMessages, newestAt, oldestAt)
    }
}
