package org.wtron.wpayagent

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
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
    private lateinit var messageList: LinearLayout
    private lateinit var emptyMessages: TextView
    private val handler = Handler(Looper.getMainLooper())
    private var running = false

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
        messageList = findViewById(R.id.messageList)
        emptyMessages = findViewById(R.id.emptyMessages)

        findViewById<Button>(R.id.retryPending).setOnClickListener {
            CreditRetryScheduler.enqueue(this)
            renderMessages()
        }
        findViewById<Button>(R.id.disconnectDevice).setOnClickListener {
            store.clearPairing()
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }

        CreditRetryScheduler.enqueue(this)
        renderMessages()
        refreshConnectionAndDiagnostics()
    }

    override fun onResume() {
        super.onResume()
        running = true
        renderMessages()
        handler.post(statusLoop)
    }

    override fun onPause() {
        running = false
        handler.removeCallbacks(statusLoop)
        super.onPause()
    }

    private val statusLoop = object : Runnable {
        override fun run() {
            if (!running) return
            renderMessages()
            refreshConnectionAndDiagnostics()
            handler.postDelayed(this, 30_000)
        }
    }

    private fun refreshConnectionAndDiagnostics() {
        Thread {
            try {
                val sim = DeviceIdentity.currentSimInfo(this)
                if (!sim.hasActiveSim || sim.fingerprint != store.simFingerprint) {
                    runOnUiThread {
                        showOnline(false, "SIM changed or unavailable")
                        deviceStatus.text = "Bound SIM does not match the active SIM."
                    }
                    return@Thread
                }

                ApiClient.heartbeat(store, sim.fingerprint)
                val diagnostics = DiagnosticsCollector.collect(this, sim.fingerprint)
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
            } catch (_: Exception) {
                runOnUiThread {
                    showOnline(false, "Offline")
                    deviceStatus.text = "Server connection unavailable. Pending credit messages will retry automatically."
                }
            }
        }.start()
    }

    private fun showOnline(online: Boolean, label: String) {
        onlineStatus.text = label
        onlineStatus.setTextColor(if (online) Color.rgb(22, 163, 74) else Color.rgb(220, 38, 38))
    }

    private fun renderMessages() {
        if (!::eventStore.isInitialized) return
        val events = eventStore.list().take(50)
        messageList.removeAllViews()
        emptyMessages.visibility = if (events.isEmpty()) View.VISIBLE else View.GONE

        events.forEach { event ->
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(18, 16, 18, 16)
                setBackgroundColor(Color.rgb(245, 247, 250))
                val params = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                params.setMargins(0, 0, 0, 14)
                layoutParams = params
            }

            card.addView(TextView(this).apply {
                text = "${event.sender.ifBlank { "Bank SMS" }}  ·  ${formatTime(event.receivedAt)}"
                textSize = 13f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(Color.rgb(70, 70, 70))
            })

            card.addView(TextView(this).apply {
                text = "₹${String.format(Locale.US, "%.2f", event.amount)}  ·  Ref ${event.reference}"
                textSize = 17f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(Color.BLACK)
                setPadding(0, 8, 0, 8)
            })

            card.addView(TextView(this).apply {
                text = event.body
                textSize = 14f
                setTextColor(Color.rgb(65, 65, 65))
            })

            card.addView(TextView(this).apply {
                val sent = event.status == "SENT"
                text = if (sent) {
                    if (event.serverState.isNotBlank()) "Sent to system · ${event.serverState}" else "Sent to system"
                } else {
                    if (event.lastError.isNotBlank()) "Pending · auto retry · ${event.lastError}" else "Pending · auto retry"
                }
                textSize = 13f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(if (sent) Color.rgb(22, 163, 74) else Color.rgb(217, 119, 6))
                setPadding(0, 10, 0, 0)
            })
            messageList.addView(card)
        }
    }

    private fun formatTime(value: Long): String =
        SimpleDateFormat("dd MMM yyyy, hh:mm:ss a", Locale.getDefault()).format(Date(value))
}
