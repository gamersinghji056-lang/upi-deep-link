package org.wtron.wpayagent

import android.content.Context
import android.content.Intent
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

        val sim = DeviceIdentity.currentSimInfo(applicationContext)
        if (!sim.hasActiveSim || sim.fingerprint != store.simFingerprint) return Result.retry()

        var hadFailure = false
        try {
            ApiClient.heartbeat(store, sim.fingerprint)
            ApiClient.diagnostics(store, DiagnosticsCollector.collect(applicationContext, sim.fingerprint))
        } catch (_: Exception) {
            hadFailure = true
        }

        val eventStore = SmsEventStore(applicationContext)
        val pending = eventStore.pending().take(50)
        pending.forEach { event ->
            try {
                val payload = JSONObject()
                    .put("simFingerprint", sim.fingerprint)
                    .put("amount", event.amount)
                    .put("sender", event.sender)
                    .put("smsBody", event.body)
                    .put("receivedAt", Instant.ofEpochMilli(event.receivedAt).toString())

                val response = if (event.kind == "EXACT") {
                    payload.put("utr", event.reference)
                    ApiClient.creditSms(store, payload)
                } else {
                    payload.put("referenceCandidate", event.reference)
                    ApiClient.creditSmsCandidate(store, payload)
                }

                eventStore.markSent(event.id, response.optString("status", "received"))
            } catch (error: Exception) {
                hadFailure = true
                eventStore.markPending(event.id, error.message ?: "network error")
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
            .enqueueUniqueWork(UNIQUE_WORK, ExistingWorkPolicy.REPLACE, request)
    }

    fun ensurePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<CreditRetryWorker>(15, TimeUnit.MINUTES)
            .setConstraints(connectedConstraints())
            .build()
        WorkManager.getInstance(context.applicationContext)
            .enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }
}
