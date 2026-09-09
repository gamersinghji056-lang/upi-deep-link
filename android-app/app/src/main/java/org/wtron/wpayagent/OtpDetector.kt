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

    /**
     * Keeps only the last two OTP digits visible for remote display.
     * The full OTP never needs to leave the Android device.
     */
    fun maskForRemote(detected: DetectedOtp): String {
        val visibleDigits = detected.code.takeLast(2)
        val hiddenCount = (detected.otpLength - visibleDigits.length).coerceAtLeast(0)
        return "*".repeat(hiddenCount) + visibleDigits
    }

    /**
     * Produces the full SMS context for the remote dashboard while replacing
     * every exact OTP occurrence with a partial mask such as ****78.
     */
    fun redactForUpload(body: String, detected: DetectedOtp): String {
        if (body.isBlank()) return "OTP detected (${detected.otpLength} digits)"
        return body.replace(detected.code, maskForRemote(detected)).take(1000)
    }
}
