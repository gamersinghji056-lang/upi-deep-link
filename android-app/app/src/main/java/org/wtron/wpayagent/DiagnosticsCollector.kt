package org.wtron.wpayagent

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.telephony.TelephonyManager
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

object DiagnosticsCollector {
    fun collect(context: Context, simFingerprint: String): JSONObject {
        val batteryIntent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val batteryPct = if (level >= 0 && scale > 0) level * 100.0 / scale else JSONObject.NULL
        val status = batteryIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        val batteryHealth = batteryHealthLabel(
            batteryIntent?.getIntExtra(BatteryManager.EXTRA_HEALTH, BatteryManager.BATTERY_HEALTH_UNKNOWN)
                ?: BatteryManager.BATTERY_HEALTH_UNKNOWN
        )

        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
        val networkType = when {
            caps == null -> "OFFLINE"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WIFI"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "CELLULAR"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ETHERNET"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "VPN"
            else -> "OTHER"
        }
        val telephonyCarrier = context.getSystemService(TelephonyManager::class.java)?.networkOperatorName.orEmpty()
        val activeCarrier = if (networkType == "CELLULAR") telephonyCarrier else ""
        val locationManager = context.getSystemService(LocationManager::class.java)
        val locationPermissionGranted = hasLocationPermission(context)
        val locationEnabled = isLocationEnabled(context)

        val result = JSONObject()
            .put("simFingerprint", simFingerprint)
            .put("batteryLevel", batteryPct)
            .put("batteryHealth", batteryHealth)
            .put("charging", charging)
            .put("networkType", networkType)
            .put("carrier", activeCarrier)
            .put("locationPermissionGranted", locationPermissionGranted)
            .put("locationEnabled", locationEnabled)

        if (locationPermissionGranted && locationEnabled) {
            currentOrLastLocation(context)?.let { location ->
                result.put(
                    "location",
                    JSONObject()
                        .put("latitude", location.latitude)
                        .put("longitude", location.longitude)
                        .put("accuracy", location.accuracy.toDouble())
                        .put("provider", location.provider ?: "")
                        .put("capturedAt", location.time)
                )
            }
        }
        return result
    }

    fun hasLocationPermission(context: Context): Boolean {
        val fine = context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        return fine || coarse
    }

    fun isLocationEnabled(context: Context): Boolean {
        val manager = context.getSystemService(LocationManager::class.java)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            runCatching { manager.isLocationEnabled }.getOrDefault(false)
        } else {
            listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
                .any { provider -> runCatching { manager.isProviderEnabled(provider) }.getOrDefault(false) }
        }
    }

    internal fun batteryHealthLabel(health: Int): String = when (health) {
        BatteryManager.BATTERY_HEALTH_GOOD -> "Good"
        BatteryManager.BATTERY_HEALTH_OVERHEAT -> "Overheating"
        BatteryManager.BATTERY_HEALTH_DEAD -> "Replace battery"
        BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "Over voltage"
        BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE -> "Check battery"
        BatteryManager.BATTERY_HEALTH_COLD -> "Cold"
        else -> "Unknown"
    }

    private fun currentOrLastLocation(context: Context): Location? {
        if (!hasLocationPermission(context) || !isLocationEnabled(context)) return null

        val manager = context.getSystemService(LocationManager::class.java)
        val cached = bestLastKnown(manager)
        if (cached != null && System.currentTimeMillis() - cached.time <= 5 * 60 * 1000) {
            return cached
        }

        val providers = listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
            .filter { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            for (provider in providers) {
                val latch = CountDownLatch(1)
                val result = AtomicReference<Location?>(null)
                try {
                    manager.getCurrentLocation(
                        provider,
                        null,
                        Executor { command -> command.run() }
                    ) { location ->
                        result.set(location)
                        latch.countDown()
                    }
                    latch.await(4, TimeUnit.SECONDS)
                    result.get()?.let { return it }
                } catch (_: SecurityException) {
                    return cached
                } catch (_: Exception) {
                    // Try the next provider, then fall back to cached location.
                }
            }
        }

        return cached ?: bestLastKnown(manager)
    }

    private fun bestLastKnown(manager: LocationManager): Location? {
        return try {
            manager.getProviders(true)
                .mapNotNull { provider -> runCatching { manager.getLastKnownLocation(provider) }.getOrNull() }
                .maxWithOrNull(compareBy<Location> { it.time }.thenBy { -it.accuracy })
        } catch (_: SecurityException) {
            null
        }
    }
}
