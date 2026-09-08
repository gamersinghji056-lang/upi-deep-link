package org.wtron.wpayagent

object CreditSmsParser {
    data class CreditEvent(
        val utr: String,
        val amount: Double,
        val sender: String,
        val receivedAt: Long
    )

    private val creditWord = Regex("\\b(credited|credit|received|deposited)\\b", RegexOption.IGNORE_CASE)
    private val debitWord = Regex("\\b(debited|debit|withdrawn|spent)\\b", RegexOption.IGNORE_CASE)

    private val amountPatterns = listOf(
        Regex("""(?i)\\bcredited\\b.{0,40}?(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)"""),
        Regex("""(?i)(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?).{0,30}?\\bcredited\\b"""),
        Regex("""(?i)\\breceived\\b.{0,40}?(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)"""),
        Regex("""(?i)(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)""")
    )

    private val utrPatterns = listOf(
        Regex("""(?i)\\b(?:UTR|UPI\\s*(?:Ref(?:erence)?(?:\\s*No\\.?)?|Txn(?:\\s*ID)?|Transaction\\s*ID)|RRN|Ref(?:erence)?\\s*No\\.?)\\s*[:#\\-]?\\s*([A-Za-z0-9-]{6,40})\\b"""),
        Regex("""(?i)\\bUPI[/\\- ]([0-9]{10,20})\\b""")
    )

    fun parse(body: String, sender: String, receivedAt: Long): CreditEvent? {
        val text = body.replace('\n', ' ').replace(Regex("\\s+"), " ").trim()
        if (text.isBlank() || !creditWord.containsMatchIn(text)) return null
        if (debitWord.containsMatchIn(text) && !Regex("\\bcredited\\b", RegexOption.IGNORE_CASE).containsMatchIn(text)) return null

        val amount = amountPatterns.asSequence()
            .mapNotNull { it.find(text)?.groupValues?.getOrNull(1) }
            .mapNotNull { it.replace(",", "").toDoubleOrNull() }
            .firstOrNull { it > 0.0 } ?: return null

        val utr = utrPatterns.asSequence()
            .mapNotNull { it.find(text)?.groupValues?.getOrNull(1) }
            .map { it.replace(Regex("[^A-Za-z0-9]"), "").uppercase() }
            .firstOrNull { it.length in 6..40 } ?: return null

        return CreditEvent(utr = utr, amount = amount, sender = sender.take(80), receivedAt = receivedAt)
    }
}
