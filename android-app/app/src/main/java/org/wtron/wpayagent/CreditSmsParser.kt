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
        // A/c ... credited by Rs. 15.00 / credited for Rs. 5.00
        Regex("""(?i)\\bcredited\\b.{0,60}?(?:by|for)?\\s*(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)"""),
        // INR 95000.00 credited / Rs.2.00 ... credited
        Regex("""(?i)(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?).{0,60}?\\bcredited\\b"""),
        Regex("""(?i)\\breceived\\b.{0,60}?(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)"""),
        // Conservative fallback: only used after a credit keyword is already confirmed.
        Regex("""(?i)(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)""")
    )

    // UPI auto-verification is intentionally strict: a valid UPI reference must resolve
    // to exactly 12 digits. We accept spaces/hyphens inserted by SMS formatting, but we
    // never guess a missing digit or trim an extra digit from an ambiguous reference.
    private val labelledReferencePatterns = listOf(
        Regex("""(?i)\\b(?:UPI\\s*)?(?:Ref(?:erence)?(?:\\s*(?:No\\.?|Number))?|RRN|UTR|Txn(?:\\s*ID)?|Transaction\\s*ID)\\s*[:#\\-]?\\s*([0-9][0-9\\s-]{9,24}[0-9])"""),
        Regex("""(?i)\\bRef\\s*No\\.?\\s*[:#\\-]?\\s*([0-9][0-9\\s-]{9,24}[0-9])""")
    )

    private val upiRoutePatterns = listOf(
        // Axis-style: UPI/P2A/612345678369/NAME/...
        Regex("""(?i)\\bUPI\\s*/\\s*(?:P2A|P2P|PAY|CR|CREDIT)\\s*/\\s*(?<!\\d)([0-9]{12})(?!\\d)"""),
        // Other bank templates where the 12-digit reference sits close to UPI text.
        Regex("""(?i)\\bUPI\\b.{0,40}?(?<!\\d)([0-9]{12})(?!\\d)""")
    )

    private fun normalizeReference(raw: String): String? {
        val digits = raw.replace(Regex("\\D"), "")
        return digits.takeIf { it.length == 12 }
    }

    private fun extractUtr(text: String): String? {
        val candidates = linkedSetOf<String>()

        for (pattern in labelledReferencePatterns) {
            pattern.findAll(text).forEach { match ->
                normalizeReference(match.groupValues.getOrNull(1).orEmpty())?.let(candidates::add)
            }
        }
        for (pattern in upiRoutePatterns) {
            pattern.findAll(text).forEach { match ->
                normalizeReference(match.groupValues.getOrNull(1).orEmpty())?.let(candidates::add)
            }
        }

        // If two different 12-digit references are present, do not guess which one is UTR.
        return candidates.singleOrNull()
    }

    fun parse(body: String, sender: String, receivedAt: Long): CreditEvent? {
        val text = body
            .replace('\\n', ' ')
            .replace('\\r', ' ')
            .replace(Regex("\\s+"), " ")
            .trim()

        if (text.isBlank() || !creditWord.containsMatchIn(text)) return null
        if (debitWord.containsMatchIn(text) && !Regex("\\bcredited\\b", RegexOption.IGNORE_CASE).containsMatchIn(text)) return null

        val amount = amountPatterns.asSequence()
            .mapNotNull { it.find(text)?.groupValues?.getOrNull(1) }
            .mapNotNull { it.replace(",", "").toDoubleOrNull() }
            .firstOrNull { it > 0.0 } ?: return null

        val utr = extractUtr(text) ?: return null

        return CreditEvent(
            utr = utr,
            amount = amount,
            sender = sender.take(80),
            receivedAt = receivedAt
        )
    }
}
