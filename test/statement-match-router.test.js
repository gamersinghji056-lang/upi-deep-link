const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { initDb } = require("../server");
const { initDeviceTables } = require("../lib/device-pairing");
const { initPaymentVerificationTables } = require("../lib/payment-verification");
const { initStatementTables, matchImportedTransactions } = require("../lib/statement-match-router");

async function insertImport(pool, { id, hashChar, txnDate, utr, amount }) {
  await pool.query(
    `insert into statement_imports(id,file_hash,file_name,rows_scanned,transaction_count)
     values($1,$2,$3,1,1)`,
    [id, String(hashChar).repeat(64), `${id}.csv`]
  );
  await pool.query(
    `insert into statement_credit_events(import_id,txn_date,utr_normalized,amount,mode)
     values($1,$2,$3,$4,'UPI')`,
    [id, txnDate, utr, amount]
  );
}

async function insertPayment(pool, { id, amount, createdAt = "2026-09-08T05:00:00.000Z", expiresAt = "2026-09-09T05:00:00.000Z" }) {
  await pool.query(
    `insert into payment_links
      (id,upi_uri,source,profile,amount,status,created_at,expires_at,original_upi_uri,provider,requested_amount)
     values($1,'upi://pay?pa=test%40bank&pn=Test','merchant','scan',$2,'pending',$3,$4,'upi://pay?pa=test%40bank&pn=Test','static_qr',$2)`,
    [id, amount, createdAt, expiresAt]
  );
}

function row(date, txnDate, utr, amount) {
  return { date, txnDate, utr, amount: Number(amount).toFixed(2), mode: "UPI" };
}

test("statement matching recovers a missing UTR only when amount/date identify one pending order", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "statement_test_" + crypto.randomBytes(8).toString("hex");
  await admin.query('create schema "' + schema + '"');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c search_path=" + schema });
  t.after(async () => {
    await pool.end();
    await admin.query('drop schema "' + schema + '" cascade');
    await admin.end();
  });

  await initDb(pool);
  await initDeviceTables(pool);
  await initPaymentVerificationTables(pool);
  await initStatementTables(pool);

  // 1) Customer never submitted a UTR. A unique statement credit with the exact
  // amount and a transaction date inside the order lifetime recovers the real UTR.
  await insertPayment(pool, { id: "WPRECOVER1", amount: "125.00" });
  await insertImport(pool, { id: "STRECOVER", hashChar: "a", txnDate: "2026-09-08", utr: "123456789012", amount: "125.00" });
  const recovered = await matchImportedTransactions(
    pool,
    [row("08/09/2026", "2026-09-08", "123456789012", 125)],
    "STRECOVER"
  );
  assert.equal(recovered[0].status, "matched");
  assert.equal(recovered[0].recoveredUtr, true);
  assert.equal(recovered[0].matchType, "utr_recovered");
  assert.equal(recovered[0].paymentId, "WPRECOVER1");

  const recoveredClaim = await pool.query(
    "select utr_normalized,amount,status,verification_source from payment_claims where payment_id=$1",
    ["WPRECOVER1"]
  );
  assert.equal(recoveredClaim.rowCount, 1);
  assert.equal(recoveredClaim.rows[0].utr_normalized, "123456789012");
  assert.equal(Number(recoveredClaim.rows[0].amount).toFixed(2), "125.00");
  assert.equal(recoveredClaim.rows[0].status, "success");
  assert.equal(recoveredClaim.rows[0].verification_source, "bank_statement_missing_utr_recovery");
  assert.equal((await pool.query("select status from payment_links where id='WPRECOVER1'")).rows[0].status, "success");
  assert.equal((await pool.query("select matched_payment_id from statement_credit_events where import_id='STRECOVER'")).rows[0].matched_payment_id, "WPRECOVER1");

  // 2) Same amount/date can belong to more than one pending order. Do not guess a UTR.
  await insertPayment(pool, { id: "WPAMBIG001", amount: "250.00" });
  await insertPayment(pool, { id: "WPAMBIG002", amount: "250.00" });
  await insertImport(pool, { id: "STAMBIG", hashChar: "b", txnDate: "2026-09-08", utr: "234567890123", amount: "250.00" });
  const ambiguous = await matchImportedTransactions(
    pool,
    [row("08/09/2026", "2026-09-08", "234567890123", 250)],
    "STAMBIG"
  );
  assert.equal(ambiguous[0].status, "unmatched");
  assert.equal(ambiguous[0].recoveredUtr, false);
  assert.equal(ambiguous[0].matchType, "ambiguous_missing_utr");
  assert.equal(ambiguous[0].candidateCount, 2);
  assert.equal((await pool.query("select count(*)::int as n from payment_claims where payment_id in ('WPAMBIG001','WPAMBIG002')")).rows[0].n, 0);
  assert.deepEqual(
    (await pool.query("select status from payment_links where id in ('WPAMBIG001','WPAMBIG002') order by id")).rows.map(x => x.status),
    ["pending", "pending"]
  );

  // 3) Existing customer UTR still follows the original exact UTR + exact amount path.
  await insertPayment(pool, { id: "WPEXACT001", amount: "375.00" });
  await pool.query(
    `insert into payment_claims(payment_id,utr_normalized,utr_display,amount,status,submitted_at)
     values('WPEXACT001','345678901234','345678901234',375.00,'pending',now())`
  );
  await insertImport(pool, { id: "STEXACT", hashChar: "c", txnDate: "2026-09-08", utr: "345678901234", amount: "375.00" });
  const exact = await matchImportedTransactions(
    pool,
    [row("08/09/2026", "2026-09-08", "345678901234", 375)],
    "STEXACT"
  );
  assert.equal(exact[0].status, "matched");
  assert.equal(exact[0].recoveredUtr, false);
  assert.equal(exact[0].matchType, "exact_utr_amount");
  assert.equal(exact[0].paymentId, "WPEXACT001");
  assert.equal((await pool.query("select verification_source from payment_claims where payment_id='WPEXACT001'")).rows[0].verification_source, "bank_statement_upload");
});
