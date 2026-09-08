const express = require("express");
const crypto = require("crypto");

function normalizeUtr(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!/^\d{12}$/.test(digits)) throw new Error("Statement UTR must be exactly 12 digits");
  return digits;
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e8) throw new Error("Invalid statement amount");
  return amount.toFixed(2);
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match) throw new Error("Statement date must be DD/MM/YYYY");
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("Invalid statement date");
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeHash(value) {
  const text = String(value || "").trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(text)) return text;
  return crypto.createHash("sha256").update(text || crypto.randomBytes(24)).digest("hex");
}

async function initStatementTables(pool) {
  if (!pool) return;
  await pool.query(`
    create table if not exists statement_imports (
      id text primary key,
      file_hash text not null unique,
      file_name text not null,
      rows_scanned integer not null default 0,
      transaction_count integer not null default 0,
      imported_at timestamptz not null default now(),
      last_matched_at timestamptz
    )
  `);
  await pool.query(`
    create table if not exists statement_credit_events (
      id bigserial primary key,
      import_id text not null references statement_imports(id) on delete cascade,
      txn_date date not null,
      utr_normalized text not null,
      amount numeric(14,2) not null,
      mode text not null default 'UPI',
      matched_payment_id text references payment_links(id) on delete set null,
      matched_at timestamptz,
      created_at timestamptz not null default now(),
      unique(import_id, txn_date, utr_normalized, amount)
    )
  `);
  await pool.query("create index if not exists statement_credit_match_idx on statement_credit_events(utr_normalized, amount, txn_date desc)");
  await pool.query("create index if not exists statement_import_time_idx on statement_imports(imported_at desc)");
}

async function verifyClaimFromStatement(pool, { paymentId, utrNormalized, amount, createdAt }) {
  const normalizedUtr = normalizeUtr(utrNormalized);
  const normalizedAmount = normalizeAmount(amount);
  const paymentDate = new Date(createdAt);
  if (Number.isNaN(paymentDate.getTime())) return false;

  const event = await pool.query(
    `select e.id
       from statement_credit_events e
      where e.utr_normalized=$1
        and e.amount=$2
        and e.txn_date between (($3::timestamptz at time zone 'Asia/Kolkata')::date - 1)
                           and (($3::timestamptz at time zone 'Asia/Kolkata')::date + 1)
      order by e.txn_date desc, e.id desc
      limit 1`,
    [normalizedUtr, normalizedAmount, paymentDate.toISOString()]
  );
  if (!event.rowCount) return false;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const claim = await client.query(
      `select c.payment_id,c.status,c.amount,c.utr_normalized,p.status as payment_status
         from payment_claims c
         join payment_links p on p.id=c.payment_id
        where c.payment_id=$1 and c.utr_normalized=$2
        for update`,
      [paymentId, normalizedUtr]
    );
    if (!claim.rowCount) {
      await client.query("rollback");
      return false;
    }
    if (claim.rows[0].status === "success" && claim.rows[0].payment_status === "success") {
      await client.query("commit");
      return true;
    }
    if (Number(claim.rows[0].amount).toFixed(2) !== normalizedAmount) {
      await client.query("rollback");
      return false;
    }

    await client.query(
      `update payment_claims
          set status='success',verified_at=now(),verified_device_id=null,verification_source='bank_statement_upload'
        where payment_id=$1`,
      [paymentId]
    );
    await client.query("update payment_links set status='success' where id=$1", [paymentId]);
    await client.query(
      `update statement_credit_events set matched_payment_id=$2,matched_at=now() where id=$1`,
      [event.rows[0].id, paymentId]
    );
    await client.query("commit");
    return true;
  } catch (error) {
    try { await client.query("rollback"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function recoverMissingUtrFromStatement(pool, { importId, txnDate, utr, amount }) {
  const normalizedUtr = normalizeUtr(utr);
  const normalizedAmount = normalizeAmount(amount);
  const date = String(txnDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid normalized statement date");

  const client = await pool.connect();
  try {
    await client.query("begin");

    // Never move or overwrite a UTR that is already attached to another payment claim.
    const existingUtr = await client.query(
      "select payment_id,status from payment_claims where utr_normalized=$1 for update",
      [normalizedUtr]
    );
    if (existingUtr.rowCount) {
      await client.query("rollback");
      return { matched: false, reason: "utr_already_claimed", candidateCount: 0 };
    }

    // Missing-UTR recovery is intentionally conservative: exact amount, statement date inside
    // the payment-link lifetime, and exactly one pending order with no UTR claim at all.
    const candidates = await client.query(
      `select p.id,p.created_at,p.expires_at,c.payment_id as claim_payment_id
         from payment_links p
         left join payment_claims c on c.payment_id=p.id
        where p.status='pending'
          and coalesce(p.amount,p.requested_amount)=$1
          and $2::date between (p.created_at at time zone 'Asia/Kolkata')::date
                           and (p.expires_at at time zone 'Asia/Kolkata')::date
        order by p.created_at desc
        limit 3
        for update of p`,
      [normalizedAmount, date]
    );

    if (candidates.rowCount !== 1) {
      await client.query("rollback");
      return {
        matched: false,
        reason: candidates.rowCount > 1 ? "ambiguous_missing_utr" : "no_missing_utr_order",
        candidateCount: candidates.rowCount
      };
    }
    if (candidates.rows[0].claim_payment_id) {
      await client.query("rollback");
      return { matched: false, reason: "order_already_has_utr_claim", candidateCount: 1 };
    }

    const paymentId = candidates.rows[0].id;
    const inserted = await client.query(
      `insert into payment_claims
        (payment_id,utr_normalized,utr_display,amount,status,submitted_at,verified_at,verified_device_id,verification_source)
       values($1,$2,$2,$3,'success',now(),now(),null,'bank_statement_missing_utr_recovery')
       on conflict do nothing
       returning payment_id`,
      [paymentId, normalizedUtr, normalizedAmount]
    );
    if (!inserted.rowCount) {
      await client.query("rollback");
      return { matched: false, reason: "claim_conflict", candidateCount: 1 };
    }

    const updatedPayment = await client.query(
      "update payment_links set status='success' where id=$1 and status='pending' returning id",
      [paymentId]
    );
    if (!updatedPayment.rowCount) {
      await client.query("rollback");
      return { matched: false, reason: "payment_not_pending", candidateCount: 1 };
    }

    await client.query(
      `update statement_credit_events
          set matched_payment_id=$4,matched_at=now()
        where import_id=$1 and txn_date=$2 and utr_normalized=$3 and amount=$5`,
      [importId, date, normalizedUtr, paymentId, normalizedAmount]
    );
    await client.query("commit");
    return { matched: true, paymentId, reason: "utr_recovered", candidateCount: 1 };
  } catch (error) {
    try { await client.query("rollback"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function matchImportedTransactions(pool, rows, importId) {
  const results = [];
  for (const row of rows) {
    const candidates = await pool.query(
      `select c.payment_id,p.created_at
         from payment_claims c
         join payment_links p on p.id=c.payment_id
        where c.status in ('pending','success')
          and p.status in ('pending','success')
          and c.utr_normalized=$1
          and c.amount=$2
          and (p.created_at at time zone 'Asia/Kolkata')::date between ($3::date - 1) and ($3::date + 1)
        order by c.submitted_at desc
        limit 1`,
      [row.utr, row.amount, row.txnDate]
    );

    if (candidates.rowCount) {
      const paymentId = candidates.rows[0].payment_id;
      const matched = await verifyClaimFromStatement(pool, {
        paymentId,
        utrNormalized: row.utr,
        amount: row.amount,
        createdAt: candidates.rows[0].created_at
      });
      if (matched) {
        await pool.query(
          `update statement_credit_events
              set matched_payment_id=$4,matched_at=coalesce(matched_at,now())
            where import_id=$1 and txn_date=$2 and utr_normalized=$3 and amount=$5`,
          [importId, row.txnDate, row.utr, paymentId, row.amount]
        );
      }
      results.push({
        ...row,
        status: matched ? "matched" : "unmatched",
        matchType: matched ? "exact_utr_amount" : "exact_claim_failed",
        recoveredUtr: false,
        paymentId: matched ? paymentId : null
      });
      continue;
    }

    const recovered = await recoverMissingUtrFromStatement(pool, {
      importId,
      txnDate: row.txnDate,
      utr: row.utr,
      amount: row.amount
    });
    results.push({
      ...row,
      status: recovered.matched ? "matched" : "unmatched",
      matchType: recovered.reason,
      recoveredUtr: recovered.matched,
      candidateCount: recovered.candidateCount,
      paymentId: recovered.matched ? recovered.paymentId : null
    });
  }
  return results;
}

function createStatementMatchRouter({ pool }) {
  const router = express.Router();

  router.post("/match", async (req, res, next) => {
    try {
      if (!pool) return res.status(503).json({ error: "Database is not configured" });
      const raw = Array.isArray(req.body?.transactions) ? req.body.transactions : [];
      if (!raw.length) return res.status(400).json({ error: "No statement transactions were supplied" });
      if (raw.length > 5000) return res.status(413).json({ error: "Statement contains too many extracted transactions" });

      const dedupe = new Map();
      for (const item of raw) {
        const utr = normalizeUtr(item?.utr);
        const amount = normalizeAmount(item?.amount);
        const txnDate = normalizeDate(item?.date);
        const key = `${txnDate}|${utr}|${amount}`;
        if (!dedupe.has(key)) dedupe.set(key, { date: String(item.date), txnDate, utr, amount, mode: "UPI" });
      }
      const rows = Array.from(dedupe.values());
      const fileName = String(req.body?.fileName || "bank-statement").trim().slice(0, 180) || "bank-statement";
      const fileHash = normalizeHash(req.body?.fileHash || `${fileName}:${JSON.stringify(rows)}`);
      const rowsScanned = Math.max(0, Math.min(100000, Number(req.body?.rowsScanned) || 0));
      const importId = `ST${crypto.randomBytes(8).toString("hex").toUpperCase()}`;

      const existing = await pool.query("select id from statement_imports where file_hash=$1 limit 1", [fileHash]);
      const effectiveImportId = existing.rowCount ? existing.rows[0].id : importId;
      if (!existing.rowCount) {
        await pool.query(
          `insert into statement_imports(id,file_hash,file_name,rows_scanned,transaction_count)
           values($1,$2,$3,$4,$5)`,
          [effectiveImportId, fileHash, fileName, rowsScanned, rows.length]
        );
      } else {
        await pool.query(
          `update statement_imports set file_name=$2,rows_scanned=$3,transaction_count=$4,imported_at=now() where id=$1`,
          [effectiveImportId, fileName, rowsScanned, rows.length]
        );
      }

      for (const row of rows) {
        await pool.query(
          `insert into statement_credit_events(import_id,txn_date,utr_normalized,amount,mode)
           values($1,$2,$3,$4,'UPI')
           on conflict(import_id,txn_date,utr_normalized,amount) do nothing`,
          [effectiveImportId, row.txnDate, row.utr, row.amount]
        );
      }

      const results = await matchImportedTransactions(pool, rows, effectiveImportId);
      const matched = results.filter(x => x.status === "matched").length;
      const recovered = results.filter(x => x.recoveredUtr).length;
      const ambiguous = results.filter(x => x.matchType === "ambiguous_missing_utr").length;
      await pool.query("update statement_imports set last_matched_at=now() where id=$1", [effectiveImportId]);
      res.json({
        ok: true,
        importId: effectiveImportId,
        fileName,
        rowsScanned,
        creditsFound: rows.length,
        matched,
        recovered,
        ambiguous,
        unmatched: rows.length - matched,
        results
      });
    } catch (error) {
      if (/statement|UTR|amount|date|transactions/i.test(error.message || "")) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  router.get("/imports", async (_req, res, next) => {
    try {
      if (!pool) return res.status(503).json({ error: "Database is not configured" });
      const result = await pool.query(
        `select i.id,i.file_name,i.rows_scanned,i.transaction_count,i.imported_at,i.last_matched_at,
                count(e.id) filter (where e.matched_payment_id is not null)::int as matched_count
           from statement_imports i
           left join statement_credit_events e on e.import_id=i.id
          group by i.id
          order by i.imported_at desc
          limit 25`
      );
      res.json({ imports: result.rows });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = {
  initStatementTables,
  createStatementMatchRouter,
  verifyClaimFromStatement,
  recoverMissingUtrFromStatement,
  matchImportedTransactions,
  normalizeUtr,
  normalizeAmount,
  normalizeDate
};
