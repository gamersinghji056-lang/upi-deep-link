package org.wtron.wpayagent

object OtpDetector {
    data class DetectedOtp(
        val code: String,
        val otpLength: Int
    )

    private val otpLabel =
        "(?:OTP|one[\\s-]*time\\s+password|verification\\s+code|security\\s+code|passcode)"

    private val patterns = listOf(
        Regex(
            "(?i)\\b([0-9]{4,8})\\b\\s+is\\s+(?:your\\s+)?" +
                "(?:[A-Za-z][A-Za-z0-9._-]*\\s+){0,5}$otpLabel\\b"
        ),
        Regex(
            "(?i)\\b$otpLabel\\b(?:\\s*\\([^)]*\\))?" +
                "\\s*(?:is|:|=|-)?\\s*([0-9]{4,8})\\b"
        ),
        Regex(
            "(?i)\\b(?:use|enter)\\s+([0-9]{4,8})" +
                "\\s+(?:as|for)\\s+(?:your\\s+)?$otpLabel\\b"
        )
    )

    fun detect(body: String): DetectedOtp? {
        if (body.isBlank()) return null

        for (pattern in patterns) {
            val match = pattern.find(body) ?: continue
            val group = match.groups[1] ?: continue
            val detectedCode = group.value
            if (!detectedCode.matches(Regex("^[0-9]{4,8}$"))) continue
            return DetectedOtp(code = detectedCode, otpLength = detectedCode.length)
        }

        return null
    }
}