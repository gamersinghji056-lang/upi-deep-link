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
    data class SimInfo(val fingerprint:String,val carrier:String,val label:String,val phoneNumber:String,val hasActiveSim:Boolean,val detail:String)
    data class DeviceInfo(val manufacturer:String,val model:String,val androidVersion:String,val appVersion:String)

    fun currentSimInfo(context: Context): SimInfo {
        val telephony=context.getSystemService(TelephonyManager::class.java)
        val phoneState=context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE)==PackageManager.PERMISSION_GRANTED
        val phoneNumberPermission=context.checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS)==PackageManager.PERMISSION_GRANTED
        val subscriptions:List<SubscriptionInfo> = if(phoneState) try{context.getSystemService(SubscriptionManager::class.java).activeSubscriptionInfoList.orEmpty()}catch(_:SecurityException){emptyList()} else emptyList()
        val parts=mutableListOf<String>(); val carriers=mutableListOf<String>(); val labels=mutableListOf<String>(); val numbers=mutableListOf<String>()
        val subscriptionManager=context.getSystemService(SubscriptionManager::class.java)
        subscriptions.sortedBy{it.simSlotIndex}.forEach{info->
            parts += "slot:${info.simSlotIndex}"; parts += "sub:${info.subscriptionId}"; parts += "carrierId:${if(Build.VERSION.SDK_INT>=28)info.carrierId else -1}"; parts += "country:${info.countryIso.orEmpty()}"; parts += "carrier:${info.carrierName?.toString().orEmpty()}"; parts += "label:${info.displayName?.toString().orEmpty()}"
            if(Build.VERSION.SDK_INT>=29){parts += "mcc:${info.mccString.orEmpty()}"; parts += "mnc:${info.mncString.orEmpty()}"; try{parts += "card:${info.cardId}"}catch(_:Throwable){}} else {@Suppress("DEPRECATION") parts += "mcc:${info.mcc}"; @Suppress("DEPRECATION") parts += "mnc:${info.mnc}"}
            try{@Suppress("DEPRECATION") val icc=info.iccId.orEmpty(); if(icc.isNotBlank())parts += "icc:$icc"}catch(_:SecurityException){}
            info.carrierName?.toString()?.takeIf{it.isNotBlank()}?.let{carriers += it}; info.displayName?.toString()?.takeIf{it.isNotBlank()}?.let{labels += it}
            if(phoneNumberPermission){
                val n=try{if(Build.VERSION.SDK_INT>=33) subscriptionManager.getPhoneNumber(info.subscriptionId) else {@Suppress("DEPRECATION") info.number.orEmpty()}}catch(_:Throwable){""}
                n.takeIf{it.isNotBlank()}?.let{numbers += it}
            }
        }
        parts += "simOperator:${telephony?.simOperator.orEmpty()}"; parts += "simCountry:${telephony?.simCountryIso.orEmpty()}"; parts += "simState:${telephony?.simState ?: -1}"
        val hasActiveSim=subscriptions.isNotEmpty()||telephony?.simState==TelephonyManager.SIM_STATE_READY
        val detail=parts.joinToString("|")
        return SimInfo(sha256(detail),carriers.distinct().joinToString(" / ").ifBlank{telephony?.networkOperatorName.orEmpty()},labels.distinct().joinToString(" / "),numbers.distinct().joinToString(" / "),hasActiveSim,detail)
    }

    fun deviceInfo(context:Context):DeviceInfo{val version=try{context.packageManager.getPackageInfo(context.packageName,0).versionName?:"unknown"}catch(_:Exception){"unknown"};return DeviceInfo(Build.MANUFACTURER?:"",Build.MODEL?:"",Build.VERSION.RELEASE?:Build.VERSION.SDK_INT.toString(),version)}
    private fun sha256(value:String)=MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}
}
