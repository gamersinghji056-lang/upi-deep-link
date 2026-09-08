package org.wtron.wpayagent

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MonitorActivity : Activity() {
    companion object {
        const val ACTION_FEED_UPDATED = "org.wtron.wpayagent.FEED_UPDATED"
    }

    private lateinit var store: AgentStore
    private lateinit var eventStore: SmsEventStore
    private lateinit var onlineStatus: TextView
    private lateinit var deviceStatus: TextView
    private lateinit var receiverHealth: TextView
    private lateinit var messageList: LinearLayout
    private lateinit var emptyMessages: TextView
    private lateinit var refreshSms: Button
    private val handler = Handler(Looper.getMainLooper())
    private var running = false
    private var receiverRegistered = false
    private val readSmsPermissionRequestCode = 4402

    private val feedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != ACTION_FEED_UPDATED) return
            renderMessages()
            renderReceiverHealth()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = AgentStore(this)
        if (!store.isPaired) {
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_monitor)
        eventStore = SmsEventStore(this)
        onlineStatus = findViewById(R.id.onlineStatus)
        deviceStatus = findViewById(R.id.deviceStatus)
        receiverHealth = findViewById(R.id.receiverHealth)
        messageList = findViewById(R.id.messageList)
        emptyMessages = findViewById(R.id.emptyMessages)
        refreshSms = findViewById(R.id.refreshSms)

        refreshSms.setOnClickListener { refreshInbox() }
        findViewById<Button>(R.id.retryPending).setOnClickListener {
            CreditRetryScheduler.enqueue(this)
            toast("Pending payment-credit messages queued for resend.")
            renderMessages()
            renderReceiverHealth()
        }
        findViewById<Button>(R.id.disconnectDevice).setOnClickListener {
            store.clearPairing()
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }

        CreditRetryScheduler.ensurePeriodic(this)
        CreditRetryScheduler.enqueue(this)
        renderMessages()
        renderReceiverHealth()
        refreshConnectionAndDiagnostics()
        autoReconcileInbox()
    }

    override fun onStart() {
        super.onStart()
        if (!receiverRegistered) {
            val filter = IntentFilter(ACTION_FEED_UPDATED)
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(feedReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("DEPRECATION")
                registerReceiver(feedReceiver, filter)
            }
            receiverRegistered = true
        }
    }

    override fun onStop() {
        if (receiverRegistered) {
            runCatching { unregisterReceiver(feedReceiver) }
            receiverRegistered = false
        }
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        running = true
        renderMessages()
        renderReceiverHealth()
        handler.post(statusLoop)
    }

    override fun onPause() {
        running = false
        handler.removeCallbacks(statusLoop)
        super.onPause()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == readSmsPermissionRequestCode) {
            if (checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED) {
                scanInboxInBackground(showToast = true, limit = 500)
            } else {
                toast("SMS inbox permission is required for Refresh Latest SMS.")
            }
        }
    }

    private val statusLoop = object : Runnable {
        override fun run() {
            if (!running) return
            renderMessages()
            renderReceiverHealth()
            refreshConnectionAndDiagnostics()
            handler.postDelayed(this, 30_000)
        }
    }

    private fun refreshInbox() {
        if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.READ_SMS), readSmsPermissionRequestCode)
            return
        }
        scanInboxInBackground(showToast = true, limit = 500)
    }

    private fun autoReconcileInbox() {
        if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) return
        scanInboxInBackground(showToast = false, limit = 200)
    }

    private fun scanInboxInBackground(showToast: Boolean, limit: Int) {
        refreshSms.isEnabled = false
        refreshSms.text = "Refreshing..."
        Thread {
            try {
                val result = SmsInboxScanner.scanRecent(this, limit)
                runOnUiThread {
                    renderMessages()
                    renderReceiverHealth()
                    refreshSms.isEnabled = true
                    refreshSms.text = "Refresh Latest SMS"
                    if (showToast) {
                        toast("${result.scanned} latest inbox SMS checked · ${result.creditMessages} UPI credit message(s) found.")
                    }
                }
            } catch (error: Exception) {
                runOnUiThread {
                    refreshSms.isEnabled = true
                    refreshSms.text = "Refresh Latest SMS"
                    if (showToast) toast("SMS refresh failed: ${error.message ?: "unknown error"}")
                    renderReceiverHealth()
                }
            }
        }.start()
    }

    private fun refreshConnectionAndDiagnostics() {
        Thread {
            try {
                val sim = DeviceIdentity.currentSimInfo(this)
                val boundFingerprint = DeviceIdentity.resolveBoundFingerprint(sim, store.simFingerprint)
                if (!sim.hasActiveSim || boundFingerprint == null) {
                    runOnUiThread {
                        showOnline(false, "SIM mismatch")
                        deviceStatus.text = "Bound SIM does not match the active SIM."
                    }
                    return@Thread
                }

                ApiClient.heartbeat(store, boundFingerprint)
                val diagnostics = DiagnosticsCollector.collect(this, boundFingerprint)
                ApiClient.diagnostics(store, diagnostics)

                val battery = if (diagnostics.isNull("batteryLevel")) "—" else String.format(Locale.US, "%.0f%%", diagnostics.optDouble("batteryLevel"))
                val network = diagnostics.optString("networkType", "—")
                val location = diagnostics.optJSONObject("location")
                val locationText = if (location != null) {
                    String.format(Locale.US, "%.6f, %.6f", location.optDouble("latitude"), location.optDouble("longitude"))
                } else if (!diagnostics.optBoolean("locationEnabled", true)) {
                    "Location services OFF"
                } else {
                    "Waiting for current location"
                }

                runOnUiThread {
                    showOnline(true, "Online")
                    deviceStatus.text = buildString {
                        append("Carrier: ").append(sim.carrier.ifBlank { "Unknown" })
                        if (sim.phoneNumber.isNotBlank()) append("\nSIM number: ").append(sim.phoneNumber)
                        append("\nBattery: ").append(battery)
                        append(" · Network: ").append(network)
                        append("\nLocation: ").append(locationText)
                    }
                }
            } catch (error: Exception) {
                runOnUiThread {
                    showOnline(false, "Offline")
                    deviceStatus.text = "Server connection unavailable. Credit messages stay queued and retry automatically."
                    store.recordUploadError(error.message ?: "Server connection unavailable")
                    renderReceiverHealth()
                }
            }
        }.start()
    }

    private fun showOnline(online: Boolean, label: String) {
        onlineStatus.text = label
        onlineStatus.setTextColor(if (online) Color.rgb(22, 163, 74) else Color.rgb(220, 38, 38))
    }

    private fun renderReceiverHealth() {
        if (!::receiverHealth.isInitialized) return
        receiverHealth.text = buildString {
            append("Last automatic SMS: ")
            append(if (store.lastSmsBroadcastAt > 0) formatTime(store.lastSmsBroadcastAt) else "none received by app yet")
            if (store.lastSmsSender.isNotBlank()) append(" · ").append(store.lastSmsSender)
            append("\nLast classification: ").append(store.lastClassification)
            append("\nLast upload: ")
            append(if (store.lastUploadAt > 0) "${formatTime(store.lastUploadAt)} · ${store.lastUploadSummary}" else store.lastUploadSummary)
            if (store.lastUploadError.isNotBlank()) append("\nLast upload error: ").append(store.lastUploadError)
            append("\nLast inbox reconcile: ")
            append(if (store.lastInboxRefreshAt > 0) formatTime(store.lastInboxRefreshAt) else "not run yet")
        }
    }

    private fun renderMessages() {
        if (!::eventStore.isInitialized) return
        val events = eventStore.list(250)
        messageList.removeAllViews()
        emptyMessages.visibility = if (events.isEmpty()) View.VISIBLE else View.GONE

        events.forEach { event ->
            val isCredit = event.kind == "EXACT" || event.kind == "CANDIDATE"
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(18, 16, 18, 16)
                setBackgroundColor(Color.rgb(245, 247, 250))
                val params = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                params.setMargins(0, 0, 0, 14)
                layoutParams = params
            }

            card.addView(TextView(this).apply {
                text = "${event.sender.ifBlank { "SMS" }}  ·  ${formatTime(event.receivedAt)}"
                textSize = 13f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(Color.rgb(70, 70, 70))
            })

            card.addView(TextView(this).apply {
                text = if (isCredit) {
                    val refLabel = if (event.kind == "EXACT") "UTR/RRN" else "Reference candidate"
                    "UPI CREDIT · ₹${String.format(Locale.US, "%.2f", event.amount)} · $refLabel ${event.reference}"
                } else {
                    "SMS · Local only"
                }
                textSize = 16f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(if (isCredit) Color.rgb(21, 128, 61) else Color.BLACK)
                setPadding(0, 8, 0, 8)
            })

            card.addView(TextView(this).apply {
                text = event.body
                textSize = 14f
                setTextColor(Color.rgb(65, 65, 65))
            })

            card.addView(TextView(this).apply {
                text = when {
                    !isCredit -> "Not sent · this SMS stays local"
                    event.status == "SENT" -> if (event.serverState.isNotBlank()) "Sent to system · ${event.serverState}" else "Sent to system"
                    event.lastError.isNotBlank() -> "Pending · automatic resend · ${event.lastError}"
                    else -> "Pending · automatic resend"
                }
                textSize = 13f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(
                    when {
                        !isCredit -> Color.rgb(107, 114, 128)
                        event.status == "SENT" -> Color.rgb(22, 163, 74)
                        else -> Color.rgb(217, 119, 6)
                    }
                )
                setPadding(0, 10, 0, 0)
            })
            messageList.addView(card)
        }
    }

    private fun formatTime(value: Long): String =
        SimpleDateFormat("dd MMM yyyy, hh:mm:ss a", Locale.getDefault()).format(Date(value))

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
}
