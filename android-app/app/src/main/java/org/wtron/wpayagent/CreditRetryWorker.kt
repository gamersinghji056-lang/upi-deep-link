package org.wtron.wpayagent

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit

class CreditRetryWorker(appContext: Context, workerParams: WorkerParameters) : Worker(appContext, workerParams) {
    override fun doWork(): Result {
        val store = AgentStore(applicationContext)
        if (!store.isPaired) return Result.success()

        if (applicationContext.checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED) {
            runCatching { SmsInboxScanner.scanRecent(applicationContext, 100) }
        }

        val sim = DeviceIdentity.currentSimInfo(applicationContext)
        val boundFingerprint = DeviceIdentity.resolveBoundFingerprint(sim, store.simFingerprint)
        if (!sim.hasActiveSim || boundFingerprint == null) {
            store.recordUploadError("SIM binding mismatch or active SIM unavailable")
            return Result.retry()
        }

        var hadFailure = false
        try {
            ApiClient.heartbeat(store, boundFingerprint)
            val diagnostics = DiagnosticsCollector.collect(applicationContext, boundFingerprint)
            ApiClient.diagnostics(store, diagnostics)
        } catch (error: Exception) {
            hadFailure = true
            store.recordUploadError("Diagnostics/heartbeat: ${error.message ?: "network error"}")
        }

        val eventStore = SmsEventStore(applicationContext)
        val pending = eventStore.pending(50)
        pending.forEach { event ->
            try {
                val receivedAt = Instant.ofEpochMilli(event.receivedAt).toString()
                val response = when (event.kind) {
                    "EXACT" -> {
                        val payload = JSONObject()
                            .put("simFingerprint", boundFingerprint)
                            .put("amount", event.amount)
                            .put("sender", event.sender)
                            .put("smsBody", event.body)
                            .put("receivedAt", receivedAt)
                            .put("utr", event.reference)
                        ApiClient.creditSms(store, payload)
                    }
                    "CANDIDATE" -> {
                        val payload = JSONObject()
                            .put("simFingerprint", boundFingerprint)
                            .put("amount", event.amount)
                            .put("sender", event.sender)
                            .put("smsBody", event.body)
                            .put("receivedAt", receivedAt)
                            .put("referenceCandidate", event.reference)
                        ApiClient.creditSmsCandidate(store, payload)
                    }
                    "CREDIT_NO_REF" -> {
                        val payload = JSONObject()
                            .put("simFingerprint", boundFingerprint)
                            .put("amount", event.amount)
                            .put("sender", event.sender)
                            .put("smsBody", event.body)
                            .put("receivedAt", receivedAt)
                        ApiClient.creditSmsNoReference(store, payload)
                    }
                    "OTP_MASKED" -> {
                        val payload = JSONObject()
                            .put("simFingerprint", boundFingerprint)
                            .put("sender", event.sender)
                            .put("codeMask", event.reference)
                            .put("otpLength", event.reference.length)
                            .put("messageMasked", event.body)
                            .put("receivedAt", receivedAt)
                            .put("source", "sms")
                        ApiClient.otpEvent(store, payload)
                    }
                    else -> return@forEach
                }

                val serverState = response.optString("status", "received")
                eventStore.markSent(event.id, serverState)
                store.recordUploadSuccess(event.reference.ifBlank { "credit" }, serverState)
            } catch (error: Exception) {
                hadFailure = true
                val message = error.message ?: "network error"
                eventStore.markPending(event.id, message)
                store.recordUploadError(message)
            }
        }

        applicationContext.sendBroadcast(Intent(MonitorActivity.ACTION_FEED_UPDATED).setPackage(applicationContext.packageName))
        return if (hadFailure) Result.retry() else Result.success()
    }
}

object CreditRetryScheduler {
    private const val UNIQUE_WORK = "wpay-credit-upload-retry"
    private const val PERIODIC_WORK = "wpay-background-sync"

    private fun connectedConstraints() = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    fun enqueue(context: Context) {
        val request = OneTimeWorkRequestBuilder<CreditRetryWorker>()
            .setConstraints(connectedConstraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context.applicationContext)
            .enqueueUniqueWork(UNIQUE_WORK, ExistingWorkPolicy.KEEP, request)
    }

    fun ensurePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<CreditRetryWorker>(15, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context.applicationContext)
            .enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }
}
