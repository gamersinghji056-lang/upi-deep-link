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

    data class CreditWithoutReference(
        val amount: Double,
        val sender: String,
        val receivedAt: Long
    )

    private val creditedWord = Regex("(?i)\\bcredited\\b")
    private val explicitUpiWord = Regex("(?i)\\bUPI\\b")
    private val vpaPattern = Regex("(?i)(?<![A-Za-z0-9._-])[A-Za-z0-9._-]{2,}@[A-Za-z][A-Za-z0-9.-]{1,}(?![A-Za-z0-9.-])")
    private val upiRoutePattern = Regex("(?i)\\bUPI\\s*/\\s*(?:P2A|P2P|PAY|CR|CREDIT)\\s*/")

    private val amountPatterns = listOf(
        Regex("""(?i)\bcredited\b.{0,120}?(?:by|for|with|of)?\s*(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)"""),
        Regex("""(?i)(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?).{0,120}?\bcredited\b"""),
        Regex("""(?i)\bcredited\b.{0,80}?\b(?:amount|amt)\s*[:=\-]?\s*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)"""),
        Regex("""(?i)\bcredited\b\s*(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)""")
    )

    private val labelledReferencePatterns = listOf(
        Regex("""(?i)\bRRN\s*(?:No\.?|Number)?\s*[:#=\-]?\s*([0-9][0-9\s-]{8,26}[0-9])"""),
        Regex("""(?i)\bUTR(?:\s*(?:No\.?|Number))?\s*[:#=\-]?\s*([0-9][0-9\s-]{8,26}[0-9])"""),
        Regex("""(?i)\bUPI\s*(?:Ref(?:erence)?(?:\s*(?:No\.?|Number))?|RRN|UTR)\s*[:#=\-]?\s*([0-9][0-9\s-]{8,26}[0-9])"""),
        Regex("""(?i)\bRef(?:erence)?\s*(?:No\.?|Number)?\s*[:#=\-]?\s*([0-9][0-9\s-]{8,26}[0-9])"""),
        Regex("""(?i)\bTxn(?:saction)?\s*(?:ID|No\.?|Number)?\s*[:#=\-]?\s*([0-9][0-9\s-]{8,26}[0-9])"""),
        Regex("""(?i)\bTransaction\s*(?:ID|No\.?|Number)\s*[:#=\-]?\s*([0-9][0-9\s-]{8,26}[0-9])""")
    )

    private val upiReferenceRoutePatterns = listOf(
        Regex("""(?i)\bUPI\s*/\s*(?:P2A|P2P|PAY|CR|CREDIT)\s*/\s*([0-9]{10,14})(?=/|\b)"""),
        Regex("""(?i)\bUPI\b.{0,80}?(?<!\d)([0-9]{10,14})(?!\d)""")
    )

    private fun normalizeText(body: String): String = body
        .replace('\u00A0', ' ')
        .replace('\\', ' ')
        .lines()
        .joinToString(" ")
        .replace(Regex("\\s+"), " ")
        .trim()

    private fun hasUpiSignal(text: String): Boolean =
        explicitUpiWord.containsMatchIn(text) ||
            vpaPattern.containsMatchIn(text) ||
            upiRoutePattern.containsMatchIn(text)

    fun isLikelyUpiCredit(body: String): Boolean {
        val text = normalizeText(body)
        return text.isNotBlank() && creditedWord.containsMatchIn(text) && hasUpiSignal(text)
    }

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

        val routed = collect(upiReferenceRoutePatterns, text)
        routed.firstOrNull { it.length == 12 }?.let { return it }
        return routed.singleOrNull()
    }

    fun parse(body: String, sender: String, receivedAt: Long): CreditEvent? {
        val text = normalizeText(body)
        if (!isLikelyUpiCredit(text)) return null
        val amount = extractAmount(text) ?: return null
        val reference = extractReferenceDigits(text) ?: return null
        if (reference.length != 12) return null
        return CreditEvent(reference, amount, sender.take(80), receivedAt)
    }

    fun parseCandidate(body: String, sender: String, receivedAt: Long): CreditCandidate? {
        val text = normalizeText(body)
        if (!isLikelyUpiCredit(text)) return null
        val amount = extractAmount(text) ?: return null
        val reference = extractReferenceDigits(text) ?: return null
        if (reference.length == 12) return null
        return CreditCandidate(reference, amount, sender.take(80), receivedAt)
    }

    fun parseWithoutReference(body: String, sender: String, receivedAt: Long): CreditWithoutReference? {
        val text = normalizeText(body)
        if (!isLikelyUpiCredit(text)) return null
        val amount = extractAmount(text) ?: return null
        if (extractReferenceDigits(text) != null) return null
        return CreditWithoutReference(amount, sender.take(80), receivedAt)
    }
}
