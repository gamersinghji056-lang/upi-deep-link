package org.wtron.wpayagent

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

object ApiClient {
    data class PairResult(val deviceId: String, val deviceToken: String)

    fun pair(
        pairingCode: String,
        deviceId: String,
        sim: DeviceIdentity.SimInfo,
        device: DeviceIdentity.DeviceInfo
    ): PairResult {
        val body = JSONObject()
            .put("pairingCode", pairingCode)
            .put("deviceId", deviceId)
            .put("simFingerprint", sim.fingerprint)
            .put("simCarrier", sim.carrier)
            .put("simSubscriptionLabel", sim.label)
            .put("manufacturer", device.manufacturer)
            .put("model", device.model)
            .put("androidVersion", device.androidVersion)
            .put("appVersion", device.appVersion)
        val response = post("/api/devices/pair", body, null, null)
        val token = response.optString("deviceToken")
        val returnedId = response.optString("deviceId", deviceId)
        if (token.isBlank()) throw IOException("Pairing response did not include a device token")
        return PairResult(returnedId, token)
    }

    fun heartbeat(store: AgentStore, simFingerprint: String): JSONObject {
        return postDevice(store, "/api/devices/heartbeat", JSONObject().put("simFingerprint", simFingerprint))
    }

    fun diagnostics(store: AgentStore, body: JSONObject): JSONObject {
        return postDevice(store, "/api/devices/diagnostics", body)
    }

    fun creditSms(store: AgentStore, body: JSONObject): JSONObject {
        return postDevice(store, "/api/devices/credit-sms", body)
    }

    private fun postDevice(store: AgentStore, path: String, body: JSONObject): JSONObject {
        val deviceId = store.deviceId ?: throw IOException("Device is not paired")
        val token = store.deviceToken ?: throw IOException("Device is not paired")
        return post(path, body, deviceId, token)
    }

    private fun post(path: String, body: JSONObject, deviceId: String?, token: String?): JSONObject {
        val url = URL(BuildConfig.API_BASE_URL.trimEnd('/') + path)
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 10_000
            readTimeout = 12_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Accept", "application/json")
            if (!deviceId.isNullOrBlank()) setRequestProperty("x-device-id", deviceId)
            if (!token.isNullOrBlank()) setRequestProperty("Authorization", "Bearer $token")
        }

        try {
            val bytes = body.toString().toByteArray(Charsets.UTF_8)
            connection.outputStream.use { it.write(bytes) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = if (text.isBlank()) JSONObject() else JSONObject(text)
            if (code !in 200..299) {
                throw IOException(json.optString("error").ifBlank { "Server request failed ($code)" })
            }
            return json
        } finally {
            connection.disconnect()
        }
    }
}
