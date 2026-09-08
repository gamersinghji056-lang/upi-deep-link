package org.wtron.wpayagent

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var store: AgentStore
    private lateinit var pairStage: LinearLayout
    private lateinit var permissionStage: LinearLayout
    private lateinit var pairingCode: EditText
    private lateinit var pairContinue: Button
    private lateinit var completeSetup: Button
    private lateinit var pairingStatus: TextView
    private lateinit var smsPermissionStatus: TextView
    private lateinit var phonePermissionStatus: TextView
    private lateinit var locationPermissionStatus: TextView
    private lateinit var notificationPermissionStatus: TextView
    private lateinit var grantPermissions: Button
    private val permissionRequestCode = 2201
    private var codeValidated = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = AgentStore(this)
        if (store.isPaired) {
            CreditRetryScheduler.ensurePeriodic(this)
            BackgroundMonitorService.start(this)
            openMonitor()
            return
        }

        setContentView(R.layout.activity_main)
        pairStage = findViewById(R.id.pairStage)
        permissionStage = findViewById(R.id.permissionStage)
        pairingCode = findViewById(R.id.pairingCode)
        pairContinue = findViewById(R.id.pairContinue)
        completeSetup = findViewById(R.id.completeSetup)
        pairingStatus = findViewById(R.id.pairingStatus)
        smsPermissionStatus = findViewById(R.id.smsPermissionStatus)
        phonePermissionStatus = findViewById(R.id.phonePermissionStatus)
        locationPermissionStatus = findViewById(R.id.locationPermissionStatus)
        notificationPermissionStatus = findViewById(R.id.notificationPermissionStatus)
        grantPermissions = findViewById(R.id.grantPermissions)

        pairingCode.addTextChangedListener(object : TextWatcher {
            private var editing = false
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(editable: Editable?) {
                if (editing) return
                val clean = editable?.toString().orEmpty().uppercase().replace(Regex("[^A-Z0-9]"), "").take(8)
                if (clean != editable?.toString().orEmpty()) {
                    editing = true
                    pairingCode.setText(clean)
                    pairingCode.setSelection(clean.length)
                    editing = false
                }
                codeValidated = false
                updatePairButton()
            }
        })

        pairContinue.setOnClickListener { validatePairingCode() }
        grantPermissions.setOnClickListener {
            if (allRuntimePermissionsGranted() && !DiagnosticsCollector.isLocationEnabled(this)) openLocationSettings()
            else requestRequiredPermissions()
        }
        completeSetup.setOnClickListener { pairDevice() }
        findViewById<Button>(R.id.changeCode).setOnClickListener {
            codeValidated = false
            permissionStage.visibility = View.GONE
            pairStage.visibility = View.VISIBLE
            pairingStatus.text = "Enter the dashboard pairing code to continue"
            pairingCode.requestFocus()
            updatePairButton()
        }
        updatePermissionUi()
        updatePairButton()
    }

    override fun onResume() {
        super.onResume()
        if (store.isPaired) {
            CreditRetryScheduler.ensurePeriodic(this)
            BackgroundMonitorService.start(this)
            openMonitor()
            return
        }
        if (::completeSetup.isInitialized) updatePermissionUi()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == permissionRequestCode) {
            updatePermissionUi()
            if (!allRuntimePermissionsGranted()) {
                toast("Grant the required permissions to complete device setup.")
            } else if (!DiagnosticsCollector.isLocationEnabled(this)) {
                toast("Turn on Android Location to complete device setup.")
                Handler(Looper.getMainLooper()).postDelayed({ openLocationSettings() }, 250)
            }
        }
    }

    private fun updatePairButton() {
        val ready = Regex("^[A-Z2-9]{8}$").matches(pairingCode.text.toString().trim().uppercase())
        pairContinue.isEnabled = ready
        pairContinue.alpha = if (ready) 1f else 0.45f
    }

    private fun validatePairingCode() {
        val code = pairingCode.text.toString().trim().uppercase()
        if (!Regex("^[A-Z2-9]{8}$").matches(code)) {
            toast("Enter the exact 8-character pairing code from the WPAY dashboard.")
            return
        }
        pairContinue.isEnabled = false
        pairContinue.alpha = 0.55f
        pairingStatus.text = "Checking pairing code..."
        pairingStatus.setTextColor(getColor(R.color.wpay_muted))

        Thread {
            try {
                val result = ApiClient.validatePairingCode(code)
                val expires = result.optInt("expiresInSeconds", 0)
                runOnUiThread {
                    codeValidated = true
                    pairingStatus.text = if (expires > 0) "Code accepted · continue setup now" else "Code accepted"
                    pairingStatus.setTextColor(getColor(R.color.wpay_green))
                    pairStage.visibility = View.GONE
                    permissionStage.visibility = View.VISIBLE
                    updatePermissionUi()
                    if (!allRuntimePermissionsGranted()) {
                        Handler(Looper.getMainLooper()).postDelayed({ requestRequiredPermissions() }, 300)
                    } else if (!DiagnosticsCollector.isLocationEnabled(this)) {
                        Handler(Looper.getMainLooper()).postDelayed({ openLocationSettings() }, 300)
                    }
                }
            } catch (error: Exception) {
                runOnUiThread {
                    codeValidated = false
                    pairingStatus.text = error.message ?: "Pairing code could not be verified"
                    pairingStatus.setTextColor(getColor(R.color.wpay_red))
                    updatePairButton()
                }
            }
        }.start()
    }

    private fun requestRequiredPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_PHONE_NUMBERS,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_FINE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= 33) permissions += Manifest.permission.POST_NOTIFICATIONS
        requestPermissions(permissions.toTypedArray(), permissionRequestCode)
    }

    private fun allRuntimePermissionsGranted(): Boolean {
        val receiveSms = checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        val readSms = checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED
        val phone = checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        val number = checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) == PackageManager.PERMISSION_GRANTED
        val location = DiagnosticsCollector.hasLocationPermission(this)
        val notifications = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        return receiveSms && readSms && phone && number && location && notifications
    }

    private fun allSetupRequirementsReady(): Boolean =
        allRuntimePermissionsGranted() && DiagnosticsCollector.isLocationEnabled(this)

    private fun updatePermissionUi() {
        if (!::smsPermissionStatus.isInitialized) return
        val sms = checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED
        val phone = checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) == PackageManager.PERMISSION_GRANTED
        val locationPermission = DiagnosticsCollector.hasLocationPermission(this)
        val locationEnabled = DiagnosticsCollector.isLocationEnabled(this)
        val notification = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

        setPermissionState(smsPermissionStatus, sms)
        setPermissionState(phonePermissionStatus, phone)
        when {
            !locationPermission -> {
                locationPermissionStatus.text = "Required"
                locationPermissionStatus.setTextColor(getColor(R.color.wpay_amber))
            }
            !locationEnabled -> {
                locationPermissionStatus.text = "Turn on Location"
                locationPermissionStatus.setTextColor(getColor(R.color.wpay_amber))
            }
            else -> {
                locationPermissionStatus.text = "✓ Granted · On"
                locationPermissionStatus.setTextColor(getColor(R.color.wpay_green))
            }
        }
        setPermissionState(notificationPermissionStatus, notification)
        grantPermissions.text = when {
            !allRuntimePermissionsGranted() -> "Grant Required Permissions"
            !locationEnabled -> "Turn On Location"
            else -> "Permissions Ready"
        }
        val ready = codeValidated && allSetupRequirementsReady()
        completeSetup.isEnabled = ready
        completeSetup.alpha = if (ready) 1f else 0.45f
    }

    private fun setPermissionState(view: TextView, granted: Boolean) {
        view.text = if (granted) "✓ Granted" else "Required"
        view.setTextColor(getColor(if (granted) R.color.wpay_green else R.color.wpay_amber))
    }

    private fun pairDevice() {
        if (!codeValidated) {
            toast("Validate the pairing code first.")
            return
        }
        if (!allRuntimePermissionsGranted()) {
            toast("Grant the requested permissions first.")
            requestRequiredPermissions()
            return
        }
        if (!DiagnosticsCollector.isLocationEnabled(this)) {
            toast("Turn on Android Location before completing setup.")
            openLocationSettings()
            return
        }
        val code = pairingCode.text.toString().trim().uppercase()
        val sim = DeviceIdentity.currentSimInfo(this)
        if (!sim.hasActiveSim) {
            toast("No active SIM detected. Insert or enable the SIM before setup.")
            return
        }

        completeSetup.isEnabled = false
        completeSetup.alpha = 0.55f
        completeSetup.text = "Connecting device..."
        val deviceId = store.getOrCreateDeviceId()
        val device = DeviceIdentity.deviceInfo(this)

        Thread {
            try {
                val result = ApiClient.pair(code, deviceId, sim, device)
                store.savePairing(result.deviceId, result.deviceToken, sim.fingerprint)
                CreditRetryScheduler.ensurePeriodic(this)
                CreditRetryScheduler.enqueue(this)
                BackgroundMonitorService.start(this)
                runOnUiThread {
                    BackgroundMonitorService.requestBatteryOptimizationExemption(this@MainActivity)
                    toast("Device connected successfully.")
                    openMonitor()
                }
            } catch (error: Exception) {
                runOnUiThread {
                    completeSetup.text = "Complete Setup"
                    completeSetup.isEnabled = true
                    completeSetup.alpha = 1f
                    toast("Setup failed: ${error.message ?: "unknown error"}")
                }
            }
        }.start()
    }

    private fun openLocationSettings() {
        runCatching { startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)) }
            .onFailure { toast("Open Android Settings and turn on Location.") }
    }

    private fun openMonitor() {
        startActivity(Intent(this, MonitorActivity::class.java))
        finish()
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
}
