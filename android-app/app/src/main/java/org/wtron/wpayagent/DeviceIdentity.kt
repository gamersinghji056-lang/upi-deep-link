package org.wtron.wpayagent

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import java.security.MessageDigest

object DeviceIdentity {
    data class SimInfo(
        val fingerprint: String,
        val carrier: String,
        val label: String,
        val hasActiveSim: Boolean,
        val detail: String
    )

    data class DeviceInfo(
        val manufacturer: String,
        val model: String,
        val androidVersion: String,
        val appVersion: String
    )

    fun currentSimInfo(context: Context): SimInfo {
        val telephony = context.getSystemService(TelephonyManager::class.java)
        val hasPhonePermission = context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        val subscriptions: List<SubscriptionInfo> = if (hasPhonePermission) {
            try {
                context.getSystemService(SubscriptionManager::class.java).activeSubscriptionInfoList.orEmpty()
            } catch (_: SecurityException) {
                emptyList()
            }
        } else {
            emptyList()
        }

        val parts = mutableListOf<String>()
        val carriers = mutableListOf<String>()
        val labels = mutableListOf<String>()

        subscriptions.sortedBy { it.simSlotIndex }.forEach { info ->
            parts += "slot:${info.simSlotIndex}"
            parts += "sub:${info.subscriptionId}"
            parts += "carrierId:${if (Build.VERSION.SDK_INT >= 28) info.carrierId else -1}"
            parts += "country:${info.countryIso.orEmpty()}"
            parts += "carrier:${info.carrierName?.toString().orEmpty()}"
            parts += "label:${info.displayName?.toString().orEmpty()}"
            if (Build.VERSION.SDK_INT >= 29) {
                parts += "mcc:${info.mccString.orEmpty()}"
                parts += "mnc:${info.mncString.orEmpty()}"
                try { parts += "card:${info.cardId}" } catch (_: Throwable) { }
            } else {
                @Suppress("DEPRECATION")
                parts += "mcc:${info.mcc}"
                @Suppress("DEPRECATION")
                parts += "mnc:${info.mnc}"
            }
            try {
                @Suppress("DEPRECATION")
                val icc = info.iccId.orEmpty()
                if (icc.isNotBlank()) parts += "icc:$icc"
            } catch (_: SecurityException) { }
            info.carrierName?.toString()?.takeIf { it.isNotBlank() }?.let { carriers += it }
            info.displayName?.toString()?.takeIf { it.isNotBlank() }?.let { labels += it }
        }

        parts += "simOperator:${telephony?.simOperator.orEmpty()}"
        parts += "simCountry:${telephony?.simCountryIso.orEmpty()}"
        parts += "simState:${telephony?.simState ?: -1}"

        val hasActiveSim = subscriptions.isNotEmpty() || telephony?.simState == TelephonyManager.SIM_STATE_READY
        val detail = parts.joinToString("|")
        return SimInfo(
            fingerprint = sha256(detail),
            carrier = carriers.distinct().joinToString(" / ").ifBlank { telephony?.networkOperatorName.orEmpty() },
            label = labels.distinct().joinToString(" / "),
            hasActiveSim = hasActiveSim,
            detail = detail
        )
    }

    fun deviceInfo(context: Context): DeviceInfo {
        val version = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unknown"
        } catch (_: Exception) {
            "unknown"
        }
        return DeviceInfo(
            manufacturer = Build.MANUFACTURER ?: "",
            model = Build.MODEL ?: "",
            androidVersion = Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString(),
            appVersion = version
        )
    }

    private fun sha256(value: String): String {
        return MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
