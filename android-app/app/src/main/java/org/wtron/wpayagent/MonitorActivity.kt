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
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
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
    private lateinit var simNumberValue: TextView
    private lateinit var batteryValue: TextView
    private lateinit var networkValue: TextView
    private lateinit var connectionValue: TextView
    private lateinit var locationValue: TextView
    private lateinit var locationSub: TextView
    private lateinit var receiverHealth: TextView
    private lateinit var homeMessageList: LinearLayout
    private lateinit var allMessageList: LinearLayout
    private lateinit var homeEmpty: TextView
    private lateinit var allEmpty: TextView
    private lateinit var refreshSms: Button
    private lateinit var tabUtr: Button
    private lateinit var tabOtp: Button
    private lateinit var homeView: ScrollView
    private lateinit var eventsView: ScrollView
    private lateinit var settingsView: ScrollView
    private lateinit var navHome: TextView
    private lateinit var navEvents: TextView
    private lateinit var navSettings: TextView
    private val handler = Handler(Looper.getMainLooper())
    private var running = false
    private var receiverRegistered = false
    private var activeHomeTab = "utr"
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
        simNumberValue = findViewById(R.id.simNumberValue)
        batteryValue = findViewById(R.id.batteryValue)
        networkValue = findViewById(R.id.networkValue)
        connectionValue = findViewById(R.id.connectionValue)
        locationValue = findViewById(R.id.locationValue)
        locationSub = findViewById(R.id.locationSub)
        receiverHealth = findViewById(R.id.receiverHealth)
        homeMessageList = findViewById(R.id.homeMessageList)
        allMessageList = findViewById(R.id.allMessageList)
        homeEmpty = findViewById(R.id.homeEmpty)
        allEmpty = findViewById(R.id.allEmpty)
        refreshSms = findViewById(R.id.refreshSms)
        tabUtr = findViewById(R.id.tabUtr)
        tabOtp = findViewById(R.id.tabOtp)
        homeView = findViewById(R.id.homeView)
        eventsView = findViewById(R.id.eventsView)
        settingsView = findViewById(R.id.settingsView)
        navHome = findViewById(R.id.navHome)
        navEvents = findViewById(R.id.navEvents)
        navSettings = findViewById(R.id.navSettings)

        refreshSms.setOnClickListener {
            refreshConnectionAndDiagnostics()
            refreshInbox()
        }
        findViewById<Button>(R.id.retryPending).setOnClickListener {
            CreditRetryScheduler.enqueue(this)
            toast("Pending credit and masked OTP events queued for resend.")
            renderMessages()
            renderReceiverHealth()
        }
        findViewById<Button>(R.id.disconnectDevice).setOnClickListener {
            store.clearPairing()
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }

        tabUtr.setOnClickListener { activeHomeTab = "utr"; updateHomeTabs(); renderMessages() }
        tabOtp.setOnClickListener { activeHomeTab = "otp"; updateHomeTabs(); renderMessages() }
        navHome.setOnClickListener { showSection("home") }
        navEvents.setOnClickListener { showSection("events") }
        navSettings.setOnClickListener { showSection("settings") }

        CreditRetryScheduler.ensurePeriodic(this)
        CreditRetryScheduler.enqueue(this)
        updateHomeTabs()
        showSection("home")
        renderMessages()
        renderReceiverHealth()
        refreshConnectionAndDiagnostics()
        autoReconcileInbox()
    }

    override fun onStart() {
        super.onStart()
        if (!receiverRegistered) {
            val filter = IntentFilter(ACTION_FEED_UPDATED)
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(feedReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            else {
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
            } else toast("SMS inbox permission is required for Refresh.")
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

    private fun showSection(section: String) {
        homeView.visibility = if (section == "home") View.VISIBLE else View.GONE
        eventsView.visibility = if (section == "events") View.VISIBLE else View.GONE
        settingsView.visibility = if (section == "settings") View.VISIBLE else View.GONE
        val selected = getColor(R.color.wpay_primary_2)
        val normal = Color.rgb(130, 119, 154)
        navHome.setTextColor(if (section == "home") selected else normal)
        navEvents.setTextColor(if (section == "events") selected else normal)
        navSettings.setTextColor(if (section == "settings") selected else normal)
    }

    private fun updateHomeTabs() {
        if (activeHomeTab == "utr") {
            tabUtr.setBackgroundResource(R.drawable.bg_primary)
            tabUtr.setTextColor(getColor(R.color.wpay_text))
            tabOtp.setBackgroundColor(Color.TRANSPARENT)
            tabOtp.setTextColor(getColor(R.color.wpay_muted))
        } else {
            tabOtp.setBackgroundResource(R.drawable.bg_primary)
            tabOtp.setTextColor(getColor(R.color.wpay_text))
            tabUtr.setBackgroundColor(Color.TRANSPARENT)
            tabUtr.setTextColor(getColor(R.color.wpay_muted))
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
        refreshSms.alpha = 0.55f
        refreshSms.text = "Refreshing..."
        Thread {
            try {
                val result = SmsInboxScanner.scanRecent(this, limit)
                runOnUiThread {
                    renderMessages()
                    renderReceiverHealth()
                    resetRefreshButton()
                    if (showToast) toast("${result.scanned} SMS checked · ${result.creditMessages} credit · ${result.otpMessages} masked OTP.")
                }
            } catch (error: Exception) {
                runOnUiThread {
                    resetRefreshButton()
                    if (showToast) toast("SMS refresh failed: ${error.message ?: "unknown error"}")
                    renderReceiverHealth()
                }
            }
        }.start()
    }

    private fun resetRefreshButton() {
        refreshSms.isEnabled = true
        refreshSms.alpha = 1f
        refreshSms.text = "Refresh"
    }

    private fun refreshConnectionAndDiagnostics() {
        Thread {
            try {
                val sim = DeviceIdentity.currentSimInfo(this)
                val boundFingerprint = DeviceIdentity.resolveBoundFingerprint(sim, store.simFingerprint)
                if (!sim.hasActiveSim || boundFingerprint == null) {
                    runOnUiThread {
                        showOnline(false, "SIM mismatch")
                        connectionValue.text = "SIM mismatch"
                        simNumberValue.text = sim.phoneNumber.ifBlank { "Unavailable" }
                    }
                    return@Thread
                }

                ApiClient.heartbeat(store, boundFingerprint)
                val diagnostics = DiagnosticsCollector.collect(this, boundFingerprint)
                ApiClient.diagnostics(store, diagnostics)

                val battery = if (diagnostics.isNull("batteryLevel")) "—" else String.format(Locale.US, "%.0f%%", diagnostics.optDouble("batteryLevel"))
                val charging = diagnostics.optBoolean("charging", false)
                val network = diagnostics.optString("networkType", "—")
                val location = diagnostics.optJSONObject("location")

                runOnUiThread {
                    showOnline(true, "Online")
                    simNumberValue.text = sim.phoneNumber.ifBlank { "Unavailable on device" }
                    batteryValue.text = if (charging && battery != "—") "$battery · Charging" else battery
                    networkValue.text = if (sim.carrier.isNotBlank()) "$network · ${sim.carrier}" else network
                    connectionValue.text = "Connected"
                    if (location != null) {
                        locationValue.text = "Current device location"
                        locationSub.text = String.format(
                            Locale.US,
                            "Lat %.6f, Long %.6f · ±%.0fm",
                            location.optDouble("latitude"),
                            location.optDouble("longitude"),
                            location.optDouble("accuracy")
                        )
                    } else if (!diagnostics.optBoolean("locationEnabled", true)) {
                        locationValue.text = "Location services off"
                        locationSub.text = "Enable location services for current diagnostics"
                    } else {
                        locationValue.text = "Waiting for current location"
                        locationSub.text = "WPAY will retry automatically"
                    }
                }
            } catch (error: Exception) {
                runOnUiThread {
                    showOnline(false, "Offline")
                    connectionValue.text = "Offline · retrying"
                    store.recordUploadError(error.message ?: "Server connection unavailable")
                    renderReceiverHealth()
                }
            }
        }.start()
    }

    private fun showOnline(online: Boolean, label: String) {
        onlineStatus.text = if (online) "●  $label" else "●  $label"
        onlineStatus.setTextColor(if (online) getColor(R.color.wpay_green) else getColor(R.color.wpay_red))
        onlineStatus.setBackgroundResource(if (online) R.drawable.bg_online else R.drawable.bg_secondary)
    }

    private fun renderReceiverHealth() {
        if (!::receiverHealth.isInitialized) return
        receiverHealth.text = buildString {
            append("Receiver health\n\n")
            append("Last automatic SMS: ")
            append(if (store.lastSmsBroadcastAt > 0) formatTime(store.lastSmsBroadcastAt) else "none received yet")
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
        val homeEvents = events.filter {
            if (activeHomeTab == "utr") it.kind == "EXACT" || it.kind == "CANDIDATE"
            else it.kind == "OTP_MASKED"
        }.take(30)
        renderEventList(homeMessageList, homeEmpty, homeEvents, false)
        renderEventList(allMessageList, allEmpty, events, true)
    }

    private fun renderEventList(container: LinearLayout, empty: TextView, events: List<SmsEventStore.Event>, showLocal: Boolean) {
        container.removeAllViews()
        empty.visibility = if (events.isEmpty()) View.VISIBLE else View.GONE
        events.forEach { container.addView(createEventCard(it, showLocal)) }
    }

    private fun createEventCard(event: SmsEventStore.Event, showLocal: Boolean): View {
        val isCredit = event.kind == "EXACT" || event.kind == "CANDIDATE"
        val isOtp = event.kind == "OTP_MASKED"
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(13), dp(14), dp(13))
            background = rounded(Color.rgb(20, 13, 45), 18f, Color.rgb(57, 40, 93))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                setMargins(0, 0, 0, dp(10))
            }
        }

        val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val icon = ImageView(this).apply {
            setImageResource(when { isCredit -> R.drawable.ic_credit; isOtp -> R.drawable.ic_key; else -> R.drawable.ic_sms })
            setPadding(dp(8), dp(8), dp(8), dp(8))
            background = rounded(
                when { isCredit -> Color.rgb(18, 64, 49); isOtp -> Color.rgb(49, 31, 92); else -> Color.rgb(31, 24, 58) },
                12f
            )
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(40))
        }
        top.addView(icon)

        val titleBlock = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { setMargins(dp(10), 0, dp(8), 0) }
        }
        titleBlock.addView(TextView(this).apply {
            text = when { isCredit -> "Money Credited"; isOtp -> "OTP Detected"; else -> "SMS Received" }
            setTextColor(getColor(R.color.wpay_text)); textSize = 14f; setTypeface(typeface, Typeface.BOLD)
        })
        titleBlock.addView(TextView(this).apply {
            text = "${event.sender.ifBlank { "SMS" }} · ${formatTime(event.receivedAt)}"
            setTextColor(getColor(R.color.wpay_muted)); textSize = 10.5f
        })
        top.addView(titleBlock)

        top.addView(TextView(this).apply {
            val sent = event.status == "SENT"
            text = when { !isCredit && !isOtp -> "Local"; sent -> "✓ Synced"; else -> "↻ Pending" }
            setTextColor(when { !isCredit && !isOtp -> getColor(R.color.wpay_muted); sent -> getColor(R.color.wpay_green); else -> getColor(R.color.wpay_amber) })
            textSize = 10.5f; setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(8), dp(5), dp(8), dp(5))
            background = rounded(when { sent -> Color.rgb(19, 58, 45); isCredit || isOtp -> Color.rgb(63, 44, 24); else -> Color.rgb(34, 28, 52) }, 999f)
        })
        card.addView(top)

        if (isCredit || isOtp || showLocal) {
            card.addView(TextView(this).apply {
                text = when {
                    isCredit -> {
                        val label = if (event.kind == "EXACT") "UTR/RRN" else "Reference"
                        "Amount: ₹${String.format(Locale.US, "%.2f", event.amount)}   •   $label: ${event.reference}"
                    }
                    isOtp -> {
                        val phone = runCatching { DeviceIdentity.currentSimInfo(this@MonitorActivity).phoneNumber }.getOrDefault("")
                        "Code: ${event.reference}   •   SIM: ${phone.ifBlank { "Unavailable" }}"
                    }
                    else -> "Local-only SMS · not uploaded"
                }
                setTextColor(if (isCredit || isOtp) Color.rgb(219, 210, 242) else getColor(R.color.wpay_muted))
                textSize = 11.5f; setPadding(dp(50), dp(9), 0, 0)
            })
        }

        card.addView(TextView(this).apply {
            text = event.body
            setTextColor(Color.rgb(182, 172, 207)); textSize = 11.5f
            setPadding(dp(50), dp(8), 0, 0); setLineSpacing(0f, 1.12f)
        })

        if ((isCredit || isOtp) && event.status != "SENT" && event.lastError.isNotBlank()) {
            card.addView(TextView(this).apply {
                text = "Auto retry: ${event.lastError}"
                setTextColor(getColor(R.color.wpay_amber)); textSize = 10.5f; setPadding(dp(50), dp(7), 0, 0)
            })
        }
        return card
    }

    private fun rounded(color: Int, radiusDp: Float, strokeColor: Int? = null): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        setColor(color)
        cornerRadius = dp(radiusDp.toInt()).toFloat()
        if (strokeColor != null) setStroke(dp(1), strokeColor)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun formatTime(value: Long): String =
        SimpleDateFormat("dd MMM yyyy, hh:mm:ss a", Locale.getDefault()).format(Date(value))

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
}
