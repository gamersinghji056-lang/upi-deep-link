package org.wtron.wpayagent

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Long-running merchant-device monitor.
 *
 * The foreground service is started while the user is in WPAY after pairing. Swiping
 * the task away does not stop this service, and START_STICKY asks Android to recreate
 * it after a normal process reclaim. SMS_RECEIVED itself remains handled by the
 * manifest receiver; this service adds continuous heartbeat/diagnostics and regular
 * inbox/pending-event reconciliation as a safety net.
 */
class BackgroundMonitorService : Service() {
    companion object {
        private const val CHANNEL_ID = "wpay_background_monitor"
        private const val NOTIFICATION_ID = 8042
        private const val HEARTBEAT_SECONDS = 30L
        private const val BACKUP_SCAN_SECONDS = 120L

        fun start(context: Context) {
            val app = context.applicationContext
            if (!AgentStore(app).isPaired) return
            val intent = Intent(app, BackgroundMonitorService::class.java)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(intent)
                else app.startService(intent)
            }.onFailure {
                AgentStore(app).recordUploadError("Background monitor start: ${it.message ?: it.javaClass.simpleName}")
                CreditRetryScheduler.ensurePeriodic(app)
                CreditRetryScheduler.enqueue(app)
            }
        }

        fun stop(context: Context) {
            context.applicationContext.stopService(Intent(context.applicationContext, BackgroundMonitorService::class.java))
        }
    }

    private lateinit var executor: ScheduledExecutorService
    private val syncing = AtomicBoolean(false)
    private var lastBackupScanAt = 0L
    private var lastDiagnosticsAt = 0L

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        promoteToForeground("Background monitoring active")
        executor = Executors.newSingleThreadScheduledExecutor()
        executor.scheduleWithFixedDelay(
            { syncOnce() },
            0,
            HEARTBEAT_SECONDS,
            TimeUnit.SECONDS
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!AgentStore(this).isPaired) {
            stopSelf()
            return START_NOT_STICKY
        }
        CreditRetryScheduler.ensurePeriodic(this)
        CreditRetryScheduler.enqueue(this)
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Do not stop when the user swipes WPAY out of Recents. Keep an independent
        // WorkManager retry path active as well in case Android later reclaims process memory.
        CreditRetryScheduler.ensurePeriodic(this)
        CreditRetryScheduler.enqueue(this)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        if (::executor.isInitialized) executor.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun syncOnce() {
        if (!syncing.compareAndSet(false, true)) return
        try {
            val store = AgentStore(this)
            if (!store.isPaired) {
                stopSelf()
                return
            }

            val sim = DeviceIdentity.currentSimInfo(this)
            val boundFingerprint = DeviceIdentity.resolveBoundFingerprint(sim, store.simFingerprint)
            if (!sim.hasActiveSim || boundFingerprint == null) {
                store.recordUploadError("Background monitor: SIM binding mismatch or SIM unavailable")
                updateNotification("SIM unavailable · waiting")
                return
            }

            try {
                ApiClient.heartbeat(store, boundFingerprint)
                updateNotification("Online · monitoring payment SMS")
            } catch (error: Exception) {
                store.recordUploadError("Background heartbeat: ${error.message ?: "network error"}")
                updateNotification("Offline · retrying automatically")
            }

            val now = System.currentTimeMillis()
            if (now - lastDiagnosticsAt >= BACKUP_SCAN_SECONDS * 1000) {
                lastDiagnosticsAt = now
                runCatching {
                    ApiClient.diagnostics(store, DiagnosticsCollector.collect(this, boundFingerprint))
                }.onFailure {
                    store.recordUploadError("Background diagnostics: ${it.message ?: "network error"}")
                }
            }

            if (now - lastBackupScanAt >= BACKUP_SCAN_SECONDS * 1000) {
                lastBackupScanAt = now
                if (checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED) {
                    runCatching { SmsInboxScanner.scanRecent(this, 150) }
                        .onFailure { store.recordUploadError("Background inbox reconcile: ${it.message ?: "scan error"}") }
                }
            }

            // SMS_RECEIVED queues immediate uploads. This is a second path for anything
            // that was pending because connectivity was unavailable at receive time.
            CreditRetryScheduler.enqueue(this)
        } finally {
            syncing.set(false)
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "WPAY background monitoring",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps the paired WPAY merchant device online and monitors new payment SMS."
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun promoteToForeground(status: String) {
        val notification = buildNotification(status)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(status: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(status))
    }

    private fun buildNotification(status: String): Notification {
        val openIntent = Intent(this, MonitorActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        return builder
            .setSmallIcon(R.drawable.ic_wpay_logo)
            .setContentTitle("WPAY Agent")
            .setContentText(status)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()
    }
}
