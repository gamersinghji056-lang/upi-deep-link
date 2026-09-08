package org.wtron.wpayagent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CreditSmsParserTest {
    private val now = 1_725_000_000_000L

    private fun assertCredit(message: String, amount: Double, reference: String) {
        assertTrue("expected UPI credit classification", CreditSmsParser.isLikelyUpiCredit(message))
        val parsed = CreditSmsParser.parse(message, "BANK", now)
        assertNotNull("expected exact 12-digit UPI reference", parsed)
        assertEquals(amount, parsed!!.amount, 0.001)
        assertEquals(reference, parsed.utr)
    }

    @Test
    fun centralBankRefNo() {
        assertCredit(
            "A/c XX8852 credited by Rs. 15.00 on 22072026 via UPI from SUMIT SHRIKANT SHUKLA via Ref No. 611611827740. -CBoI",
            15.00,
            "611611827740"
        )
    }

    @Test
    fun boiUpiRef() {
        assertCredit(
            "BOI UPI - Your a/c no. XXXXXXXXXXX0457 is credited for Rs. 5.00 on 07/04/2026 and debited from a/c no. XXXXXXXXXXXXX5279 (UPI Ref no 123456789014)",
            5.00,
            "123456789014"
        )
    }

    @Test
    fun axisAmountBeforeCreditedAndUpiRoute() {
        assertCredit(
            "INR 95000.00 credited A/c no. XX7854 18-07-26, 15:12:52 IST UPI/P2A/612345678369/JONA HI/UTIB/baj - Axis Bank",
            95000.00,
            "612345678369"
        )
    }

    @Test
    fun iobPhonePeUpiRef() {
        assertCredit(
            "Your a/c no. XXXXX57 is credited by Rs.2.00 on 2026-07-30 02:10:45.247, from SUMIT SHRIKANT SHUKLA-8830974685-2@axl(UPI Ref no 952118601225).Payer Remark - Payment from PhonePe -IOB",
            2.00,
            "952118601225"
        )
    }

    @Test
    fun iobUpiRef() {
        assertCredit(
            "Your a/c no. XXXXX57 is credited by Rs.1.00 on 2026-07-28 03:51:28.640, from Mr GAURAV MOHANRAO JAMODKAR-jamodkargauravo-1@okicici (UPI Ref no 620903858294).Payer Remark - UPI-IOB",
            1.00,
            "620903858294"
        )
    }

    @Test
    fun indusIndRrnWithVpa() {
        assertCredit(
            "A/C *XX8794 credited by Rs 1.00 from 8976537375@ptyes. RRN:314123456323. Avl Bal:42.93. Not you? Call 18602677777 - IndusInd bank",
            1.00,
            "314123456323"
        )
    }

    @Test
    fun ambiguousReferenceBecomesCandidate() {
        val message = "A/c XX1111 credited by Rs 10.00 via UPI. RRN: 31412345632"
        assertNull(CreditSmsParser.parse(message, "BANK", now))
        val candidate = CreditSmsParser.parseCandidate(message, "BANK", now)
        assertNotNull(candidate)
        assertEquals("31412345632", candidate!!.referenceCandidate)
        assertEquals(10.0, candidate.amount, 0.001)
    }

    @Test
    fun creditedWithoutUpiSignalIsNotUploaded() {
        val message = "Your account is credited by Rs 1000.00 by cash deposit. Ref No 123456789012"
        assertFalse(CreditSmsParser.isLikelyUpiCredit(message))
        assertNull(CreditSmsParser.parse(message, "BANK", now))
    }

    @Test
    fun debitOnlyIsNotCredit() {
        val message = "A/c XX1234 debited by Rs 20.00 via UPI Ref no 123456789012"
        assertFalse(CreditSmsParser.isLikelyUpiCredit(message))
        assertNull(CreditSmsParser.parse(message, "BANK", now))
    }
}
