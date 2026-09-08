package org.wtron.wpayagent

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import java.security.MessageDigest
import java.util.UUID

class SmsEventStore(private val context: Context) {
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

    private class Db(context: Context) : SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                """
                CREATE TABLE sms_events (
                    id TEXT PRIMARY KEY,
                    source_key TEXT NOT NULL UNIQUE,
                    kind TEXT NOT NULL,
                    reference TEXT NOT NULL DEFAULT '',
                    amount REAL NOT NULL DEFAULT 0,
                    sender TEXT NOT NULL DEFAULT '',
                    body TEXT NOT NULL,
                    received_at INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    server_state TEXT NOT NULL DEFAULT ''
                )
                """.trimIndent()
            )
            db.execSQL("CREATE INDEX sms_events_received_idx ON sms_events(received_at DESC)")
            db.execSQL("CREATE INDEX sms_events_pending_idx ON sms_events(status, kind, received_at ASC)")
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            if (oldVersion < 1) onCreate(db)
        }
    }

    companion object {
        private const val DB_NAME = "wpay_sms.db"
        private const val DB_VERSION = 1
        private const val LEGACY_KEY = "credit_sms_events_v2"
        private const val MIGRATED_KEY = "sms_sqlite_migrated_v1"
        private val LOCK = Any()

        @Volatile
        private var sharedDb: Db? = null

        private fun helper(context: Context): Db {
            sharedDb?.let { return it }
            return synchronized(LOCK) {
                sharedDb ?: Db(context.applicationContext).also { sharedDb = it }
            }
        }
    }

    private val db = helper(context)

    init {
        migrateLegacyOnce()
    }

    fun add(
        kind: String,
        reference: String,
        amount: Double,
        sender: String,
        body: String,
        receivedAt: Long,
        uploadable: Boolean
    ): Event {
        val cleanSender = sender.take(120)
        val cleanBody = body.take(3000)
        val key = sourceKey(cleanSender, cleanBody, receivedAt)
        synchronized(LOCK) {
            val values = ContentValues().apply {
                put("id", UUID.randomUUID().toString())
                put("source_key", key)
                put("kind", kind)
                put("reference", reference)
                put("amount", amount)
                put("sender", cleanSender)
                put("body", cleanBody)
                put("received_at", receivedAt)
                put("status", if (uploadable) "PENDING" else "LOCAL_ONLY")
                put("attempts", 0)
                put("last_error", "")
                put("server_state", "")
            }
            db.writableDatabase.insertWithOnConflict(
                "sms_events",
                null,
                values,
                SQLiteDatabase.CONFLICT_IGNORE
            )
            return findBySourceKey(key) ?: error("Could not persist SMS event")
        }
    }

    fun list(limit: Int = 500): List<Event> = synchronized(LOCK) {
        val safeLimit = limit.coerceIn(1, 2000)
        queryEvents(
            selection = null,
            args = null,
            orderBy = "received_at DESC, rowid DESC",
            limit = safeLimit.toString()
        )
    }

    fun pending(limit: Int = 50): List<Event> = synchronized(LOCK) {
        val safeLimit = limit.coerceIn(1, 200)
        queryEvents(
            selection = "kind IN ('EXACT','CANDIDATE') AND status <> 'SENT'",
            args = null,
            orderBy = "received_at ASC, rowid ASC",
            limit = safeLimit.toString()
        )
    }

    fun markSent(id: String, serverState: String) {
        updateStatus(id, "SENT", "", serverState.take(80))
    }

    fun markPending(id: String, error: String) {
        updateStatus(id, "PENDING", error.take(180), "")
    }

    private fun updateStatus(id: String, status: String, error: String, serverState: String) {
        synchronized(LOCK) {
            val current = db.readableDatabase.query(
                "sms_events",
                arrayOf("attempts"),
                "id=?",
                arrayOf(id),
                null,
                null,
                null,
                "1"
            ).use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) else 0 }
            val values = ContentValues().apply {
                put("status", status)
                put("last_error", error)
                put("server_state", serverState)
                put("attempts", current + 1)
            }
            db.writableDatabase.update("sms_events", values, "id=?", arrayOf(id))
        }
    }

    private fun findBySourceKey(key: String): Event? = queryEvents(
        selection = "source_key=?",
        args = arrayOf(key),
        orderBy = null,
        limit = "1"
    ).firstOrNull()

    private fun queryEvents(
        selection: String?,
        args: Array<String>?,
        orderBy: String?,
        limit: String?
    ): List<Event> {
        val columns = arrayOf(
            "id", "kind", "reference", "amount", "sender", "body", "received_at",
            "status", "attempts", "last_error", "server_state"
        )
        return db.readableDatabase.query(
            "sms_events",
            columns,
            selection,
            args,
            null,
            null,
            orderBy,
            limit
        ).use { cursor ->
            val out = ArrayList<Event>(cursor.count.coerceAtLeast(0))
            while (cursor.moveToNext()) {
                out += Event(
                    id = cursor.getString(0),
                    kind = cursor.getString(1),
                    reference = cursor.getString(2),
                    amount = cursor.getDouble(3),
                    sender = cursor.getString(4),
                    body = cursor.getString(5),
                    receivedAt = cursor.getLong(6),
                    status = cursor.getString(7),
                    attempts = cursor.getInt(8),
                    lastError = cursor.getString(9),
                    serverState = cursor.getString(10)
                )
            }
            out
        }
    }

    private fun migrateLegacyOnce() {
        val prefs = context.getSharedPreferences("wpay_agent", Context.MODE_PRIVATE)
        if (prefs.getBoolean(MIGRATED_KEY, false)) return
        synchronized(LOCK) {
            if (prefs.getBoolean(MIGRATED_KEY, false)) return
            val raw = prefs.getString(LEGACY_KEY, "[]") ?: "[]"
            val arr = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
            for (index in 0 until arr.length()) {
                val obj = arr.optJSONObject(index) ?: continue
                val kind = obj.optString("kind", "LOCAL_ONLY")
                val status = obj.optString("status", if (kind == "LOCAL_ONLY") "LOCAL_ONLY" else "PENDING")
                val event = add(
                    kind = kind,
                    reference = obj.optString("reference"),
                    amount = obj.optDouble("amount"),
                    sender = obj.optString("sender"),
                    body = obj.optString("body"),
                    receivedAt = obj.optLong("receivedAt"),
                    uploadable = kind == "EXACT" || kind == "CANDIDATE"
                )
                if (status == "SENT") {
                    val values = ContentValues().apply {
                        put("status", "SENT")
                        put("attempts", obj.optInt("attempts"))
                        put("last_error", obj.optString("lastError"))
                        put("server_state", obj.optString("serverState"))
                    }
                    db.writableDatabase.update("sms_events", values, "id=?", arrayOf(event.id))
                }
            }
            prefs.edit().putBoolean(MIGRATED_KEY, true).apply()
        }
    }

    private fun sourceKey(sender: String, body: String, receivedAt: Long): String {
        val input = "$sender\u0000$body\u0000$receivedAt"
        return MessageDigest.getInstance("SHA-256")
            .digest(input.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
