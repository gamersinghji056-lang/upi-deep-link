package org.wtron.wpayagent

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Telephony

object SmsInboxScanner {
    data class ScanResult(
        val scanned: Int,
        val creditMessages: Int
    )

    fun scanAllInbox(context: Context): ScanResult {
        if (context.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            throw SecurityException("READ_SMS permission is required for inbox refresh")
        }

        val projection = arrayOf(
            Telephony.Sms._ID,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE
        )

        var scanned = 0
        var creditMessages = 0
        context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            projection,
            null,
            null,
            Telephony.Sms.DEFAULT_SORT_ORDER
        )?.use { cursor ->
            val addressIndex = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
            val bodyIndex = cursor.getColumnIndex(Telephony.Sms.BODY)
            val dateIndex = cursor.getColumnIndex(Telephony.Sms.DATE)

            while (cursor.moveToNext()) {
                val sender = if (addressIndex >= 0) cursor.getString(addressIndex).orEmpty() else ""
                val body = if (bodyIndex >= 0) cursor.getString(bodyIndex).orEmpty() else ""
                val receivedAt = if (dateIndex >= 0) cursor.getLong(dateIndex) else System.currentTimeMillis()
                if (body.isBlank()) continue

                val result = SmsProcessor.capture(
                    context = context,
                    sender = sender,
                    body = body,
                    receivedAt = receivedAt,
                    scheduleUpload = false
                )
                scanned++
                if (result.isCredit) creditMessages++
            }
        }

        if (creditMessages > 0) CreditRetryScheduler.enqueue(context)
        return ScanResult(scanned, creditMessages)
    }
}
