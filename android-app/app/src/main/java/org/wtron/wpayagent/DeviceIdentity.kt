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
        val legacyFingerprint: String,
        val carrier: String,
        val label: String,
        val phoneNumber: String,
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
        val phoneState = context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        val phoneNumberPermission = context.checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) == PackageManager.PERMISSION_GRANTED
        val subscriptionManager = context.getSystemService(SubscriptionManager::class.java)
        val subscriptions: List<SubscriptionInfo> = if (phoneState) {
            try { subscriptionManager.activeSubscriptionInfoList.orEmpty() } catch (_: SecurityException) { emptyList() }
        } else emptyList()

        val stableParts = mutableListOf<String>()
        val legacyParts = mutableListOf<String>()
        val carriers = mutableListOf<String>()
        val labels = mutableListOf<String>()
        val numbers = mutableListOf<String>()

        subscriptions.sortedBy { it.simSlotIndex }.forEach { info ->
            val country = info.countryIso.orEmpty()
            val carrierName = info.carrierName?.toString().orEmpty()
            val displayName = info.displayName?.toString().orEmpty()
            val carrierId = if (Build.VERSION.SDK_INT >= 28) info.carrierId else -1
            val mcc = if (Build.VERSION.SDK_INT >= 29) info.mccString.orEmpty() else {
                @Suppress("DEPRECATION") info.mcc.toString()
            }
            val mnc = if (Build.VERSION.SDK_INT >= 29) info.mncString.orEmpty() else {
                @Suppress("DEPRECATION") info.mnc.toString()
            }
            val cardId = if (Build.VERSION.SDK_INT >= 29) runCatching { info.cardId }.getOrNull() else null
            val icc = try {
                @Suppress("DEPRECATION")
                info.iccId.orEmpty()
            } catch (_: Throwable) { "" }

            stableParts += "slot:${info.simSlotIndex}"
            stableParts += "carrierId:$carrierId"
            stableParts += "country:$country"
            stableParts += "mcc:$mcc"
            stableParts += "mnc:$mnc"
            if (cardId != null && cardId >= 0) stableParts += "card:$cardId"
            if (icc.isNotBlank()) stableParts += "icc:$icc"

            // v0.3 and older fingerprint retained exactly for seamless migration.
            legacyParts += "slot:${info.simSlotIndex}"
            legacyParts += "sub:${info.subscriptionId}"
            legacyParts += "carrierId:$carrierId"
            legacyParts += "country:$country"
            legacyParts += "carrier:$carrierName"
            legacyParts += "label:$displayName"
            legacyParts += "mcc:$mcc"
            legacyParts += "mnc:$mnc"
            if (Build.VERSION.SDK_INT >= 29 && cardId != null) legacyParts += "card:$cardId"
            if (icc.isNotBlank()) legacyParts += "icc:$icc"

            if (carrierName.isNotBlank()) carriers += carrierName
            if (displayName.isNotBlank()) labels += displayName
            if (phoneNumberPermission) {
                val number = try {
                    if (Build.VERSION.SDK_INT >= 33) subscriptionManager.getPhoneNumber(info.subscriptionId)
                    else {
                        @Suppress("DEPRECATION")
                        info.number.orEmpty()
                    }
                } catch (_: Throwable) { "" }
                if (number.isNotBlank()) numbers += number
            }
        }

        val simOperator = telephony?.simOperator.orEmpty()
        val simCountry = telephony?.simCountryIso.orEmpty()
        val simState = telephony?.simState ?: -1

        stableParts += "simOperator:$simOperator"
        stableParts += "simCountry:$simCountry"
        stableParts += "simState:$simState"
        legacyParts += "simOperator:$simOperator"
        legacyParts += "simCountry:$simCountry"
        legacyParts += "simState:$simState"

        val hasActiveSim = subscriptions.isNotEmpty() || telephony?.simState == TelephonyManager.SIM_STATE_READY
        val stableDetail = stableParts.joinToString("|")
        val legacyDetail = legacyParts.joinToString("|")

        return SimInfo(
            fingerprint = sha256(stableDetail),
            legacyFingerprint = sha256(legacyDetail),
            carrier = carriers.distinct().joinToString(" / ").ifBlank { telephony?.networkOperatorName.orEmpty() },
            label = labels.distinct().joinToString(" / "),
            phoneNumber = numbers.distinct().joinToString(" / "),
            hasActiveSim = hasActiveSim,
            detail = stableDetail
        )
    }

    fun resolveBoundFingerprint(sim: SimInfo, boundFingerprint: String?): String? {
        if (boundFingerprint.isNullOrBlank()) return null
        return when (boundFingerprint) {
            sim.fingerprint -> sim.fingerprint
            sim.legacyFingerprint -> sim.legacyFingerprint
            else -> null
        }
    }

    fun deviceInfo(context: Context): DeviceInfo {
        val version = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unknown"
        } catch (_: Exception) { "unknown" }
        return DeviceInfo(
            Build.MANUFACTURER ?: "",
            Build.MODEL ?: "",
            Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString(),
            version
        )
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
}
