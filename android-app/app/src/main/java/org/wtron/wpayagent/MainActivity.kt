package org.wtron.wpayagent

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast

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
        store = AgentStore(this)
        if (store.isPaired) {
            CreditRetryScheduler.ensurePeriodic(this)
            openMonitor()
            return
        }

        setContentView(R.layout.activity_main)
        pairingCode = findViewById(R.id.pairingCode)
        pairingStatus = findViewById(R.id.pairingStatus)
        deviceInfoText = findViewById(R.id.deviceInfo)
        lastEventText = findViewById(R.id.lastEvent)
        smsPermissionStatus = findViewById(R.id.smsPermissionStatus)
        phonePermissionStatus = findViewById(R.id.phonePermissionStatus)
        locationPermissionStatus = findViewById(R.id.locationPermissionStatus)

        findViewById<Button>(R.id.grantPermissions).setOnClickListener { requestRequiredPermissions() }
        findViewById<Button>(R.id.pairDevice).setOnClickListener { pairDevice() }
        findViewById<Button>(R.id.sendDiagnostics).setOnClickListener { toast("Pair the device first. Diagnostics will then sync automatically.") }
        findViewById<Button>(R.id.resetPairing).setOnClickListener {
            store.clearPairing()
            updateUi()
        }
        updateUi()
    }

    override fun onResume() {
        super.onResume()
        if (store.isPaired) {
            CreditRetryScheduler.ensurePeriodic(this)
            openMonitor()
            return
        }
        if (::pairingStatus.isInitialized) updateUi()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == permissionRequestCode) {
            updateUi()
            if (!allRequiredPermissionsGranted()) toast("SMS receive/read, SIM/phone-state and location permissions are required before pairing.")
        }
    }

    private fun requestRequiredPermissions() {
        requestPermissions(
            arrayOf(
                Manifest.permission.RECEIVE_SMS,
                Manifest.permission.READ_SMS,
                Manifest.permission.READ_PHONE_STATE,
                Manifest.permission.READ_PHONE_NUMBERS,
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_FINE_LOCATION
            ),
            permissionRequestCode
        )
    }

    private fun allRequiredPermissionsGranted(): Boolean {
        val receiveSms = checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        val readSms = checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED
        val phone = checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        val location = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        return receiveSms && readSms && phone && location
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
                CreditRetryScheduler.ensurePeriodic(this)
                CreditRetryScheduler.enqueue(this)
                runOnUiThread {
                    toast("Device connected successfully.")
                    openMonitor()
                }
            } catch (error: Exception) {
                runOnUiThread { pairingStatus.text = "Pairing failed: ${error.message ?: "unknown error"}" }
            }
        }.start()
    }

    private fun updateUi() {
        val receiveSms = checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        val readSms = checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED
        val phone = checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        val number = checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) == PackageManager.PERMISSION_GRANTED
        val location = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

        smsPermissionStatus.text = "SMS receive: ${if (receiveSms) "Granted" else "Required"} · inbox read: ${if (readSms) "Granted" else "Required"}"
        phonePermissionStatus.text = "SIM / phone state: ${if (phone) "Granted" else "Required"} · number: ${if (number) "Granted" else "Optional"}"
        locationPermissionStatus.text = "Location: ${if (location) "Granted" else "Required"}"
        lastEventText.text = "After pairing, WPAY Agent keeps a local SMS feed. Only detected UPI-credit messages are sent to the payment system."
        pairingStatus.text = "Not paired"

        val sim = if (phone) DeviceIdentity.currentSimInfo(this) else null
        val device = DeviceIdentity.deviceInfo(this)
        deviceInfoText.text = buildString {
            append(device.manufacturer).append(' ').append(device.model)
            append(" · Android ").append(device.androidVersion)
            append("\nCarrier: ").append(sim?.carrier?.ifBlank { "Unknown" } ?: "Permission required")
            append("\nSIM number: ").append(sim?.phoneNumber?.ifBlank { "Unavailable on this device" } ?: "Permission required")
            append("\nAPI: ").append(BuildConfig.API_BASE_URL)
        }
    }

    private fun openMonitor() {
        startActivity(Intent(this, MonitorActivity::class.java))
        finish()
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
}
