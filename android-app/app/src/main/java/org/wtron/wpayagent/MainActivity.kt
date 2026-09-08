package org.wtron.wpayagent

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var store: AgentStore
    private lateinit var pairingCode: EditText
    private lateinit var pairingStatus: TextView
    private lateinit var deviceInfoText: TextView
    private lateinit var lastEventText: TextView
    private lateinit var smsPermissionStatus: TextView
    private lateinit var phonePermissionStatus: TextView
    private lateinit var locationPermissionStatus: TextView

    private val permissionRequestCode = 2201

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = AgentStore(this)

        pairingCode = findViewById(R.id.pairingCode)
        pairingStatus = findViewById(R.id.pairingStatus)
        deviceInfoText = findViewById(R.id.deviceInfo)
        lastEventText = findViewById(R.id.lastEvent)
        smsPermissionStatus = findViewById(R.id.smsPermissionStatus)
        phonePermissionStatus = findViewById(R.id.phonePermissionStatus)
        locationPermissionStatus = findViewById(R.id.locationPermissionStatus)

        findViewById<Button>(R.id.grantPermissions).setOnClickListener { requestRequiredPermissions() }
        findViewById<Button>(R.id.pairDevice).setOnClickListener { pairDevice() }
        findViewById<Button>(R.id.sendDiagnostics).setOnClickListener { sendDiagnostics() }
        findViewById<Button>(R.id.resetPairing).setOnClickListener {
            store.clearPairing()
            updateUi()
            toast("Local pairing cleared. Create a new dashboard pairing code to reconnect.")
        }

        updateUi()
        if (store.isPaired) {
            sendHeartbeatInBackground()
            flushPendingCreditInBackground()
        }
    }

    override fun onResume() {
        super.onResume()
        updateUi()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == permissionRequestCode) {
            updateUi()
            if (!allRequiredPermissionsGranted()) {
                toast("All requested permissions must be granted before this device can be paired.")
            }
        }
    }

    private fun requestRequiredPermissions() {
        val requested = arrayOf(
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_FINE_LOCATION
        )
        requestPermissions(requested, permissionRequestCode)
    }

    private fun allRequiredPermissionsGranted(): Boolean {
        val sms = checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        val phone = checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        val location = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        return sms && phone && location
    }

    private fun pairDevice() {
        if (!allRequiredPermissionsGranted()) {
            toast("Review and grant the requested permissions first.")
            requestRequiredPermissions()
            return
        }
        val code = pairingCode.text.toString().trim().uppercase()
        if (!Regex("^[A-Z2-9]{8}$").matches(code)) {
            toast("Enter the 8-character pairing code from the WPAY dashboard.")
            return
        }

        val sim = DeviceIdentity.currentSimInfo(this)
        if (!sim.hasActiveSim) {
            toast("No active SIM detected. Insert/enable the SIM before pairing.")
            return
        }
        val deviceId = store.getOrCreateDeviceId()
        val device = DeviceIdentity.deviceInfo(this)
        pairingStatus.text = "Connecting..."

        Thread {
            try {
                val result = ApiClient.pair(code, deviceId, sim, device)
                store.savePairing(result.deviceId, result.deviceToken, sim.fingerprint)
                runOnUiThread {
                    pairingCode.setText("")
                    updateUi()
                    toast("Device paired and SIM binding saved.")
                }
                sendHeartbeatInBackground()
                sendDiagnosticsInBackground(showToast = false)
                flushPendingCreditInBackground()
            } catch (error: Exception) {
                runOnUiThread {
                    pairingStatus.text = "Pairing failed: ${error.message ?: "unknown error"}"
                }
            }
        }.start()
    }

    private fun sendHeartbeatInBackground() {
        if (!store.isPaired) return
        Thread {
            try {
                val sim = DeviceIdentity.currentSimInfo(this)
                ApiClient.heartbeat(store, sim.fingerprint)
            } catch (_: Exception) { }
        }.start()
    }

    private fun sendDiagnostics() {
        if (!store.isPaired) {
            toast("Pair this device first.")
            return
        }
        sendDiagnosticsInBackground(showToast = true)
    }

    private fun sendDiagnosticsInBackground(showToast: Boolean) {
        Thread {
            try {
                val sim = DeviceIdentity.currentSimInfo(this)
                val payload = DiagnosticsCollector.collect(this, sim.fingerprint)
                ApiClient.diagnostics(store, payload)
                if (showToast) runOnUiThread { toast("Diagnostics sent.") }
                runOnUiThread { updateUi() }
            } catch (error: Exception) {
                if (showToast) runOnUiThread { toast("Diagnostics failed: ${error.message}") }
            }
        }.start()
    }

    private fun flushPendingCreditInBackground() {
        val pending = store.pendingCreditJson ?: return
        Thread {
            try {
                val response = ApiClient.creditSms(store, JSONObject(pending))
                store.clearPendingCredit()
                if (response.optBoolean("matched")) store.saveLastEvent("Pending credit upload matched a payment successfully.")
                runOnUiThread { updateUi() }
            } catch (_: Exception) { }
        }.start()
    }

    private fun updateUi() {
        val sms = checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        val phone = checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        val location = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

        smsPermissionStatus.text = "SMS receive: ${if (sms) "Granted" else "Required"}"
        phonePermissionStatus.text = "SIM / phone state: ${if (phone) "Granted" else "Required"}"
        locationPermissionStatus.text = "Location: ${if (location) "Granted" else "Required"}"
        lastEventText.text = store.lastEvent

        val sim = if (phone) DeviceIdentity.currentSimInfo(this) else null
        val currentFingerprint = sim?.fingerprint
        val simMatches = store.simFingerprint != null && currentFingerprint == store.simFingerprint
        pairingStatus.text = when {
            !store.isPaired -> "Not paired"
            !simMatches -> "Paired, but current SIM does not match the bound SIM. Requests will be rejected."
            else -> "Connected · SIM binding matches"
        }

        val device = DeviceIdentity.deviceInfo(this)
        deviceInfoText.text = buildString {
            append(device.manufacturer).append(' ').append(device.model)
            append(" · Android ").append(device.androidVersion)
            append("\nCarrier: ").append(sim?.carrier?.ifBlank { "Unknown" } ?: "Permission required")
            append("\nAPI: ").append(BuildConfig.API_BASE_URL)
        }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
}
