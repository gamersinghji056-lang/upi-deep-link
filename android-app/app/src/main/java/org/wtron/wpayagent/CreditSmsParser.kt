package org.wtron.wpayagent

object CreditSmsParser {
    data class CreditEvent(
        val utr: String,
        val amount: Double,
        val sender: String,
        val receivedAt: Long
    )

    data class CreditCandidate(
        val referenceCandidate: String,
        val amount: Double,
        val sender: String,
        val receivedAt: Long
    )

    private val creditWord = Regex("\\b(credited|credit|received|deposited)\\b", RegexOption.IGNORE_CASE)
    private val debitWord = Regex("\\b(debited|debit|withdrawn|spent)\\b", RegexOption.IGNORE_CASE)

    private val amountPatterns = listOf(
        Regex("""(?i)\\bcredited\\b.{0,60}?(?:by|for)?\\s*(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)"""),
        Regex("""(?i)(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?).{0,60}?\\bcredited\\b"""),
        Regex("""(?i)\\breceived\\b.{0,60}?(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)"""),
        Regex("""(?i)(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)""")
    )

    // Capture the reference as printed by the bank. Spaces/hyphens are allowed because
    // some SMS templates split a reference visually. We only auto-verify when this
    // normalizes to exactly 12 digits.
    private val labelledReferencePatterns = listOf(
        Regex("""(?i)\\b(?:UPI\\s*)?(?:Ref(?:erence)?(?:\\s*(?:No\\.?|Number))?|RRN|UTR|Txn(?:\\s*ID)?|Transaction\\s*ID)\\s*[:#\\-]?\\s*([0-9][0-9\\s-]{8,26}[0-9])"""),
        Regex("""(?i)\\bRef\\s*No\\.?\\s*[:#\\-]?\\s*([0-9][0-9\\s-]{8,26}[0-9])""")
    )

    private val upiRoutePatterns = listOf(
        // Axis-style: UPI/P2A/612345678369/NAME/...
        Regex("""(?i)\\bUPI\\s*/\\s*(?:P2A|P2P|PAY|CR|CREDIT)\\s*/\\s*([0-9]{10,14})(?=/|\\b)"""),
        // Other bank templates where a numeric reference sits close to UPI text.
        Regex("""(?i)\\bUPI\\b.{0,40}?(?<!\\d)([0-9]{10,14})(?!\\d)""")
    )

    private fun normalizeText(body: String): String = body
        .replace('\\n', ' ')
        .replace('\\r', ' ')
        .replace(Regex("\\s+"), " ")
        .trim()

    private fun extractAmount(text: String): Double? = amountPatterns.asSequence()
        .mapNotNull { it.find(text)?.groupValues?.getOrNull(1) }
        .mapNotNull { it.replace(",", "").toDoubleOrNull() }
        .firstOrNull { it > 0.0 }

    private fun extractReferenceDigits(text: String): String? {
        val candidates = linkedSetOf<String>()
        for (pattern in labelledReferencePatterns + upiRoutePatterns) {
            pattern.findAll(text).forEach { match ->
                val digits = match.groupValues.getOrNull(1).orEmpty().replace(Regex("\\D"), "")
                if (digits.length in 10..14) candidates.add(digits)
            }
        }
        return candidates.singleOrNull()
    }

    private fun isCreditMessage(text: String): Boolean {
        if (text.isBlank() || !creditWord.containsMatchIn(text)) return false
        if (debitWord.containsMatchIn(text) && !Regex("\\bcredited\\b", RegexOption.IGNORE_CASE).containsMatchIn(text)) return false
        return true
    }

    fun parse(body: String, sender: String, receivedAt: Long): CreditEvent? {
        val text = normalizeText(body)
        if (!isCreditMessage(text)) return null
        val amount = extractAmount(text) ?: return null
        val reference = extractReferenceDigits(text) ?: return null
        if (reference.length != 12) return null

        return CreditEvent(
            utr = reference,
            amount = amount,
            sender = sender.take(80),
            receivedAt = receivedAt
        )
    }

    fun parseCandidate(body: String, sender: String, receivedAt: Long): CreditCandidate? {
        val text = normalizeText(body)
        if (!isCreditMessage(text)) return null
        val amount = extractAmount(text) ?: return null
        val reference = extractReferenceDigits(text) ?: return null
        if (reference.length == 12) return null

        return CreditCandidate(
            referenceCandidate = reference,
            amount = amount,
            sender = sender.take(80),
            receivedAt = receivedAt
        )
    }
}
