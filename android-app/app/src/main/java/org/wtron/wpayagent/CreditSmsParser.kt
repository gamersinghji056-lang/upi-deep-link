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
        Regex("""(?i)\\bcredited\\b.{0,80}?(?:by|for)?\\s*(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)"""),
        Regex("""(?i)(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?).{0,80}?\\bcredited\\b"""),
        Regex("""(?i)\\breceived\\b.{0,80}?(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)"""),
        Regex("""(?i)(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)""")
    )

    private val labelledReferencePatterns = listOf(
        // IndusInd style: RRN:314123456323
        Regex("""(?i)\\bRRN\\s*[:#\\-]?\\s*([0-9][0-9\\s-]{8,26}[0-9])"""),
        // BOI / IOB / CBoI: UPI Ref no 123456789014, Ref No. 611611827740
        Regex("""(?i)\\b(?:UPI\\s*)?(?:Ref(?:erence)?(?:\\s*(?:No\\.?|Number))?|UTR|Txn(?:\\s*ID)?|Transaction\\s*ID)\\s*[:#\\-]?\\s*([0-9][0-9\\s-]{8,26}[0-9])"""),
        Regex("""(?i)\\bRef\\s*No\\.?\\s*[:#\\-]?\\s*([0-9][0-9\\s-]{8,26}[0-9])""")
    )

    private val upiRoutePatterns = listOf(
        // Axis-style: UPI/P2A/612345678369/NAME/...
        Regex("""(?i)\\bUPI\\s*/\\s*(?:P2A|P2P|PAY|CR|CREDIT)\\s*/\\s*([0-9]{10,14})(?=/|\\b)"""),
        Regex("""(?i)\\bUPI\\b.{0,50}?(?<!\\d)([0-9]{10,14})(?!\\d)""")
    )

    private fun normalizeText(body: String): String = body
        .lines()
        .joinToString(" ")
        .replace(Regex("\\s+"), " ")
        .trim()

    private fun extractAmount(text: String): Double? = amountPatterns.asSequence()
        .mapNotNull { it.find(text)?.groupValues?.getOrNull(1) }
        .mapNotNull { it.replace(",", "").toDoubleOrNull() }
        .firstOrNull { it > 0.0 }

    private fun collect(patterns: List<Regex>, text: String): List<String> {
        val values = linkedSetOf<String>()
        patterns.forEach { pattern ->
            pattern.findAll(text).forEach { match ->
                val digits = match.groupValues.getOrNull(1).orEmpty().replace(Regex("\\D"), "")
                if (digits.length in 10..14) values.add(digits)
            }
        }
        return values.toList()
    }

    private fun extractReferenceDigits(text: String): String? {
        val labelled = collect(labelledReferencePatterns, text)
        labelled.firstOrNull { it.length == 12 }?.let { return it }
        if (labelled.size == 1) return labelled.first()

        val routed = collect(upiRoutePatterns, text)
        routed.firstOrNull { it.length == 12 }?.let { return it }
        return routed.singleOrNull()
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
        return CreditEvent(reference, amount, sender.take(80), receivedAt)
    }

    fun parseCandidate(body: String, sender: String, receivedAt: Long): CreditCandidate? {
        val text = normalizeText(body)
        if (!isCreditMessage(text)) return null
        val amount = extractAmount(text) ?: return null
        val reference = extractReferenceDigits(text) ?: return null
        if (reference.length == 12) return null
        return CreditCandidate(reference, amount, sender.take(80), receivedAt)
    }
}
