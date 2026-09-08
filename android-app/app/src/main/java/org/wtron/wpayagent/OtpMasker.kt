package org.wtron.wpayagent

object OtpMasker {
    data class MaskedOtp(
        val codeMask: String,
        val otpLength: Int,
        val messageMasked: String
    )

    private val otpLabel = "(?:OTP|one[\\s-]*time\\s+password|verification\\s+code|security\\s+code|passcode)"

    private val patterns = listOf(
        // 703007 is your Navi login OTP / 991499 is OTP / 291653 is One Time Password(OTP)
        Regex("(?i)\\b([0-9]{4,8})\\b\\s+is\\s+(?:your\\s+)?(?:[A-Za-z][A-Za-z0-9._-]*\\s+){0,5}$otpLabel\\b"),
        // Your OTP is 703007 / OTP: 703007 / verification code 703007
        Regex("(?i)\\b$otpLabel\\b(?:\\s*\\([^)]*\\))?\\s*(?:is|:|=|-)?\\s*([0-9]{4,8})\\b"),
        // Use 703007 as your OTP / Enter 703007 for verification code
        Regex("(?i)\\b(?:use|enter)\\s+([0-9]{4,8})\\s+(?:as|for)\\s+(?:your\\s+)?$otpLabel\\b")
    )

    fun dummyCode(length: Int): String {
        require(length in 4..8) { "OTP length must be 4-8 digits" }
        return "12345678".substring(0, length)
    }

    fun mask(body: String): MaskedOtp? {
        if (body.isBlank()) return null
        for (pattern in patterns) {
            val match = pattern.find(body) ?: continue
            val group = match.groups[1] ?: continue
            val actual = group.value
            if (!actual.matches(Regex("^[0-9]{4,8}$"))) continue
            val masked = dummyCode(actual.length)
            val sanitized = body.replaceRange(group.range, masked)
            return MaskedOtp(masked, actual.length, sanitized)
        }
        return null
    }
}
