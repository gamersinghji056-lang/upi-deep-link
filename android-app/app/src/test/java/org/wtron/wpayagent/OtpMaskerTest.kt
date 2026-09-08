package org.wtron.wpayagent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OtpMaskerTest {
    @Test
    fun masksNaviStyleOtp() {
        val result = OtpMasker.mask("703007 is your Navi login OTP. Do not share with anyone.")!!
        assertEquals("703007", result.codeMask)
        assertEquals(6, result.otpLength)
        assertEquals("703007 is your Navi login OTP. Do not share with anyone.", result.messageMasked)
    }

    @Test
    fun masksIobTransferOtpOnly() {
        val source = "Dear Customer,991499 is OTP to approve IMPS Fund trf of Rs.11.00 from A/c ending 05057 to Vishvajeet. Do not share OTP to any one-IOB"
        val result = OtpMasker.mask(source)!!
        assertEquals("991499", result.codeMask)
        assertTrue(result.messageMasked.contains("991499 is OTP"))
        assertTrue(result.messageMasked.contains("Rs.11.00"))
        assertTrue(result.messageMasked.contains("05057"))
        assertTrue(!result.messageMasked.contains("991499"))
    }

    @Test
    fun masksOneTimePasswordStyle() {
        val result = OtpMasker.mask("Dear Customer, 291653 is One Time Password(OTP) for the request.")!!
        assertEquals("291653", result.codeMask)
        assertTrue(result.messageMasked.contains("291653 is One Time Password"))
    }

    @Test
    fun masksOtpAfterLabelAndKeepsLength() {
        val result = OtpMasker.mask("Your verification code is 84726190. Valid for 5 minutes.")!!
        assertEquals("84726190", result.codeMask)
        assertEquals(8, result.otpLength)
        assertTrue(result.messageMasked.contains("verification code is 84726190"))
    }

    @Test
    fun masksFourDigitOtp() {
        val result = OtpMasker.mask("OTP: 8642 for login")!!
        assertEquals("8642", result.codeMask)
        assertTrue(result.messageMasked.contains("OTP: 8642"))
    }

    @Test
    fun doesNotTreatOrdinaryBankNumbersAsOtp() {
        assertNull(OtpMasker.mask("A/c XX8852 credited by Rs. 15.00 via UPI Ref No. 611611827740."))
        assertNull(OtpMasker.mask("Contact Helpdesk 044-28519460.IOB."))
        assertNull(OtpMasker.mask("You have done a Transaction on 26-07-2026 for Rs.11.00."))
    }
}
