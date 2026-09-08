package org.wtron.wpayagent

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class SmsEventStore(context: Context) {
    data class Event(
        val id: String,
        val kind: String,
        val reference: String,
        val amount: Double,
        val sender: String,
        val body: String,
        val receivedAt: Long,
        val status: String,
        val attempts: Int,
        val lastError: String,
        val serverState: String
    )

    private val prefs = context.getSharedPreferences("wpay_agent", Context.MODE_PRIVATE)

    companion object {
        private const val KEY = "credit_sms_events_v2"
        private const val MAX_EVENTS = 100
        private val LOCK = Any()
    }

    fun add(kind: String, reference: String, amount: Double, sender: String, body: String, receivedAt: Long): Event {
        synchronized(LOCK) {
            val existing = readAllMutable()
            val duplicate = existing.firstOrNull {
                it.optString("reference") == reference &&
                    kotlin.math.abs(it.optDouble("amount") - amount) < 0.001 &&
                    kotlin.math.abs(it.optLong("receivedAt") - receivedAt) < 60_000
            }
            if (duplicate != null) return fromJson(duplicate)

            val event = JSONObject()
                .put("id", UUID.randomUUID().toString())
                .put("kind", kind)
                .put("reference", reference)
                .put("amount", amount)
                .put("sender", sender.take(120))
                .put("body", body.take(3000))
                .put("receivedAt", receivedAt)
                .put("status", "PENDING")
                .put("attempts", 0)
                .put("lastError", "")
                .put("serverState", "")

            existing.add(0, event)
            persist(existing.take(MAX_EVENTS))
            return fromJson(event)
        }
    }

    fun list(): List<Event> = synchronized(LOCK) { readAllMutable().map(::fromJson) }

    fun pending(): List<Event> = list().filter { it.status != "SENT" }

    fun markSent(id: String, serverState: String) {
        update(id) {
            it.put("status", "SENT")
            it.put("lastError", "")
            it.put("serverState", serverState.take(80))
            it.put("attempts", it.optInt("attempts") + 1)
        }
    }

    fun markPending(id: String, error: String) {
        update(id) {
            it.put("status", "PENDING")
            it.put("lastError", error.take(180))
            it.put("attempts", it.optInt("attempts") + 1)
        }
    }

    private fun update(id: String, block: (JSONObject) -> Unit) {
        synchronized(LOCK) {
            val all = readAllMutable()
            val row = all.firstOrNull { it.optString("id") == id } ?: return
            block(row)
            persist(all)
        }
    }

    private fun readAllMutable(): MutableList<JSONObject> {
        val raw = prefs.getString(KEY, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
        return MutableList(arr.length()) { index -> arr.optJSONObject(index) ?: JSONObject() }
    }

    private fun persist(items: List<JSONObject>) {
        val arr = JSONArray()
        items.forEach { arr.put(it) }
        prefs.edit().putString(KEY, arr.toString()).apply()
    }

    private fun fromJson(obj: JSONObject): Event = Event(
        id = obj.optString("id"),
        kind = obj.optString("kind"),
        reference = obj.optString("reference"),
        amount = obj.optDouble("amount"),
        sender = obj.optString("sender"),
        body = obj.optString("body"),
        receivedAt = obj.optLong("receivedAt"),
        status = obj.optString("status", "PENDING"),
        attempts = obj.optInt("attempts"),
        lastError = obj.optString("lastError"),
        serverState = obj.optString("serverState")
    )
}
