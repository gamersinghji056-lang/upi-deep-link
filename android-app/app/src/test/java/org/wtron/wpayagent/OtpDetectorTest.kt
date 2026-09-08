package org.wtron.wpayagent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class OtpDetectorTest {
    @Test
    fun detectsNaviStyleOtp() {
        val result = OtpDetector.detect("703007 is your Navi login OTP. Do not share with anyone.")
        assertNotNull(result)
        assertEquals("703007", result!!.code)
        assertEquals(6, result!!.otpLength)
    }

    @Test
    fun detectsIobTransferOtp() {
        val result = OtpDetector.detect("Dear Customer,991499 is OTP to approve IMPS Fund trf of Rs.11.00 from A/c ending 05057 to Vishvajeet. Do not share OTP to any one-IOB")
        assertNotNull(result)
        assertEquals(6, result!!.otpLength)
    }

    @Test
    fun detectsOneTimePasswordStyle() {
        val result = OtpDetector.detect("Dear Customer, 291653 is One Time Password(OTP) for the request.")
        assertNotNull(result)
        assertEquals(6, result!!.otpLength)
    }

    @Test
    fun detectsOtpAfterLabelAndKeepsLength() {
        val result = OtpDetector.detect("Your verification code is 84726190. Valid for 5 minutes.")
        assertNotNull(result)
        assertEquals(8, result!!.otpLength)
    }

    @Test
    fun detectsFourDigitOtp() {
        val result = OtpDetector.detect("OTP: 8642 for login")
        assertNotNull(result)
        assertEquals(4, result!!.otpLength)
    }

    @Test
    fun detectsUseOtpStyle() {
        val result = OtpDetector.detect("Use 735921 as your OTP.")
        assertNotNull(result)
        assertEquals(6, result!!.otpLength)
    }

    @Test
    fun detectsEnterVerificationCodeStyle() {
        val result = OtpDetector.detect("Enter 483920 for verification code.")
        assertNotNull(result)
        assertEquals(6, result!!.otpLength)
    }

    @Test
    fun doesNotTreatOrdinaryBankNumbersAsOtp() {
        assertNull(OtpDetector.detect("A/c XX8852 credited by Rs. 15.00 via UPI Ref No. 611611827740."))
        assertNull(OtpDetector.detect("Contact Helpdesk 044-28519460.IOB."))
        assertNull(OtpDetector.detect("You have done a Transaction on 26-07-2026 for Rs.11.00."))
    }

    @Test
    fun blankMessageIsNotOtp() {
        assertNull(OtpDetector.detect(""))
        assertNull(OtpDetector.detect("   "))
    }
}