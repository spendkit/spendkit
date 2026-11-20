import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createIntentRepository } from "../src/db/repositories/createIntentRepository.js";
import { createLedgerStore } from "../src/db/repositories/createLedgerStore.js";
import { Ledger, accounts } from "../src/lib/services/Ledger.js";
import { webhookSignature } from "../src/lib/clients/cardIssuing/miden/webhookSignature.js";
import { DECISIONS, SpendIntents, dollarsToCents, normalizeMerchant, verifyCallbackSignature, type CallbackAnswer } from "../src/lib/services/SpendIntents.js";

// Runs only with DATABASE_URL. Each case gets its own schema.
const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
const admin = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 2 }) : undefined;
const pools: pg.Pool[] = [];
const schemas: string[] = [];
after(async () => {
  for (const p of pools) await p.end();
  for (const s of schemas) await admin!.query(`DROP SCHEMA ${s} CASCADE`);
  await admin?.end();
});

const HASH = "test-webhook-hash";
const A1 = { cardId: "c1", agentId: "a1" };
const A2 = { cardId: "c1", agentId: "a2" };

async function setup(opts: { budgetMs?: number; approvalAbove?: number } = {}) {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 6 });
  pools.push(pool);
  await migrate(pool);
  await pool.query("INSERT INTO app_user (id, email, token_hash) VALUES ('u1', 'a@example.com', 'h1')");
  await pool.query("INSERT INTO app_card (card_id, user_id, customer_id, per_txn_cents, daily_cents) VALUES ('c1', 'u1', 'cu1', 10000, 50000)");
  await pool.query("INSERT INTO app_agent (card_id, agent_id, name, token_hash, per_txn_cents, daily_cents) VALUES ('c1', 'a1', 'A', 't1', 5000, 20000), ('c1', 'a2', 'B', 't2', 5000, 20000)");
  const db = createDatabase(pool);
  const ledger = new Ledger(() => new Date(), createLedgerStore(db));
  await ledger.confirmDeposit({ chain: "base", asset: "USDC", cardId: "c1", amountCents: 20000, txHash: "0xabc", logIndex: 0 });
  await ledger.reserveFunding({ cardId: "c1", amountCents: 20000, fundingId: "f1" });
  await ledger.completeFunding({ cardId: "c1", amountCents: 20000, fundingId: "f1" });
  await ledger.allocateToAgent({ cardId: "c1", agentId: "a1", amountCents: 3000, allocationId: "al1" });
  await ledger.allocateToAgent({ cardId: "c1", agentId: "a2", amountCents: 3000, allocationId: "al2" });
  const alerts: string[] = [];
  const intents = new SpendIntents({
    repo: createIntentRepository(db),
    webhookHash: HASH,
    alerter: { raise: async (_k, m) => void alerts.push(m) },
    budgetMs: opts.budgetMs ?? 2000,
    ...(opts.approvalAbove !== undefined ? {
      approvalRequired: async (_p: unknown, max: number) => max > opts.approvalAbove!,
      approvalUrl: (id: string) => `https://example.test/app/approve/${id}`,
    } : {}),
  });
  const bal = (acct: string) => ledger.balance(acct);
  return { pool, intents, ledger, alerts, bal };
}

let seq = 0;
function event(over: Record<string, unknown> = {}) {
  const eventId = `ev_${++seq}_${randomBytes(3).toString("hex")}`;
  return {
    eventId, eventTime: new Date().toISOString(), requestType: "Authorization", cardId: "c1",
    transactionAmount: 12.5, merchantName: "ACME*Store #12", merchantCategoryCode: "5411", reference: `R${seq}`,
    cardTransactionAuthorizationId: `auth_${seq}`, ...over,
  };
}
const sign = (b: { eventId: string; eventTime: string }) => Buffer.from(webhookSignature(b.eventId, b.eventTime, HASH)).toString("base64");
const call = (i: SpendIntents, b: Record<string, unknown> & { eventId: string; eventTime: string }) => i.handleCallback(b, sign(b));
const code = (a: CallbackAnswer) => (a.httpStatus === 200 ? a.body.responseCode : String(a.httpStatus));

test("helpers: exact cents, merchant normalisation, signature encodings", () => {
  assert.equal(dollarsToCents(3.75), 375);
  assert.equal(dollarsToCents("0.1"), 10);
  assert.equal(dollarsToCents(1.005), undefined);
  assert.equal(dollarsToCents(-1), undefined);
  assert.equal(normalizeMerchant("ACME*Store #12"), "acme store 12");
  const hex = webhookSignature("e", "t", HASH);
  assert.ok(verifyCallbackSignature("e", "t", hex, HASH));
  assert.ok(verifyCallbackSignature("e", "t", Buffer.from(hex).toString("base64"), HASH));
  assert.ok(verifyCallbackSignature("e", "t", Buffer.from(hex, "hex").toString("base64"), HASH));
  assert.ok(!verifyCallbackSignature("e", "t2", hex, HASH));
});

test("create holds the maximum; a matching authorization is approved and captures; settlement returns the rest", { skip }, async () => {
  const { intents, bal } = await setup();
  const it = await intents.createIntent(A1, { amountCents: 1200, maxAmountCents: 1400, merchant: "Acme Store", idempotencyKey: "k1", context: "groceries\u0007 for\nthe team" });
  assert.equal(it.status, "processing");
  assert.equal(it.context, "groceries for the team");
  assert.equal(await bal(accounts.agent("c1", "a1")), 1600);
  assert.equal(await bal(accounts.hold("c1")), 1400);
  // Replay of the same key returns the same intent, holds nothing more.
  assert.equal((await intents.createIntent(A1, { amountCents: 1200, maxAmountCents: 1400, merchant: "Acme Store", idempotencyKey: "k1", context: "groceries for the team" })).spendId, it.spendId);
  await assert.rejects(intents.createIntent(A1, { amountCents: 999, merchant: "Acme Store", idempotencyKey: "k1" }), /already used/);

  const auth = event({ transactionAmount: "12.50", charge: 0.5 });
  assert.equal(code(await call(intents, auth)), "000");
  assert.equal(await bal(accounts.hold("c1")), 100);
  assert.equal(await bal(accounts.merchant()), 1300);
  const got = await intents.getIntent(A1, it.spendId);
  assert.equal(got.status, "approved");
  assert.equal(got.authState, "provisional");
  // The same eventId again returns the stored answer and moves nothing.
  assert.equal(code(await call(intents, auth)), "000");
  assert.equal(await bal(accounts.merchant()), 1300);

  const settle = event({ requestType: "Settlement", transactionAmount: 13.25, cardTransactionAuthorizationId: auth.cardTransactionAuthorizationId });
  assert.equal(code(await call(intents, settle)), "000");
  assert.equal(await bal(accounts.hold("c1")), 0);
  assert.equal(await bal(accounts.merchant()), 1325);
  assert.equal(await bal(accounts.agent("c1", "a1")), 1675);
  assert.equal((await intents.getIntent(A1, it.spendId)).authState, "settled");
});

test("default is decline: no intent, wrong merchant, over max, wrong MCC, stale or unsigned", { skip }, async () => {
  const { intents, alerts, bal } = await setup();
  assert.equal(code(await call(intents, event())), "119");
  assert.equal(alerts.length, 1);
  assert.equal(code(await call(intents, event())), "119");
  assert.equal(alerts.length, 1, "bypass alerts are throttled per card");
  await intents.createIntent(A1, { amountCents: 1000, merchant: "Acme", mcc: "5411" });
  assert.equal(code(await call(intents, event({ merchantName: "Other Shop", transactionAmount: 10 }))), "119");
  assert.equal(code(await call(intents, event({ transactionAmount: 10.01 }))), "119");
  assert.equal(code(await call(intents, event({ transactionAmount: 10, merchantCategoryCode: "7995" }))), "119");
  assert.equal(code(await call(intents, event({ transactionAmount: 10, eventTime: new Date(Date.now() - 180_000).toISOString() }))), "137");
  assert.equal(code(await call(intents, event({ requestType: "Teleport" }))), "131");
  assert.equal(code(await call(intents, event({ requestType: "CashWithdrawal", transactionAmount: 10 }))), "119");
  assert.equal(code(await call(intents, event({ transactionAmount: "10.001" }))), "111");
  assert.equal(code(await call(intents, event({ cardId: "unknown" }))), "143");
  const b = event({ transactionAmount: 10 });
  assert.equal(code(await intents.handleCallback(b, "bad")), "401");
  assert.equal(await bal(accounts.merchant()), 0);
  assert.equal(code(await call(intents, b)), "000");
});

test("two agents matching the same authorization: decline, never guess", { skip }, async () => {
  const { intents, alerts } = await setup();
  await intents.createIntent(A1, { amountCents: 1000, merchant: "Acme" });
  await intents.createIntent(A2, { amountCents: 1000, merchant: "Acme" });
  assert.equal(code(await call(intents, event({ transactionAmount: 10 }))), "119");
  assert.ok(alerts.some((a) => /2 agents/.test(a)));
});

test("limits and funds at create: per-transaction, daily, sub-balance", { skip }, async () => {
  const { intents, bal } = await setup();
  assert.equal((await intents.createIntent(A1, { amountCents: 100, maxAmountCents: 5001, merchant: "Acme" })).reason, "per-transaction limit exceeded");
  const short = await intents.createIntent(A1, { amountCents: 3001, merchant: "Acme" });
  assert.equal(short.status, "declined");
  assert.equal(short.reason, "insufficient sub-balance");
  assert.equal(await bal(accounts.hold("c1")), 0);
  await assert.rejects(intents.createIntent(A1, { amountCents: 100, merchant: "Ac" }), /at least 3/);
  await assert.rejects(intents.createIntent(A1, { amountCents: 100, merchant: "Acme", context: " \u0000 " }), /empty/);
});

test("pending approval: not matchable until approved; owner deny and expiry release the hold once", { skip }, async () => {
  const { intents, pool, bal } = await setup({ approvalAbove: 500 });
  const it = await intents.createIntent(A1, { amountCents: 1000, merchant: "Acme" });
  assert.equal(it.status, "pending_approval");
  assert.ok("approvalUrl" in it && it.approvalUrl?.endsWith(it.spendId));
  assert.equal(await bal(accounts.hold("c1")), 1000);
  assert.equal(code(await call(intents, event({ transactionAmount: 10 }))), "119");
  assert.deepEqual(await intents.releaseIntent(it.spendId, "owner_denied"), { released: true, status: "declined" });
  assert.deepEqual(await intents.releaseIntent(it.spendId, "owner_denied"), { released: false, status: "declined" });
  assert.equal(await bal(accounts.hold("c1")), 0);
  assert.equal(await bal(accounts.agent("c1", "a1")), 3000);

  const small = await intents.createIntent(A1, { amountCents: 400, merchant: "Acme", expiresInSeconds: 60 });
  assert.equal(small.status, "processing");
  await pool.query("UPDATE app_spend SET expires_at = now() - interval '3 minutes' WHERE spend_id = $1", [small.spendId]);
  assert.equal(await intents.sweepExpired(), 1);
  assert.equal((await intents.getIntent(A1, small.spendId)).status, "expired");
  assert.equal(await bal(accounts.agent("c1", "a1")), 3000);
});

test("full reversal before settlement returns everything; refund after settlement returns the refund", { skip }, async () => {
  const { intents, bal } = await setup();
  const one = await intents.createIntent(A1, { amountCents: 1000, maxAmountCents: 1200, merchant: "Acme" });
  const auth = event({ transactionAmount: 10 });
  assert.equal(code(await call(intents, auth)), "000");
  await call(intents, event({ requestType: "Reversal", transactionAmount: 10, cardTransactionAuthorizationId: auth.cardTransactionAuthorizationId }));
  assert.equal(await bal(accounts.agent("c1", "a1")), 3000);
  assert.equal(await bal(accounts.hold("c1")), 0);
  assert.equal((await intents.getIntent(A1, one.spendId)).status, "voided");

  await intents.createIntent(A1, { amountCents: 1000, merchant: "Acme" });
  const auth2 = event({ transactionAmount: 10 });
  assert.equal(code(await call(intents, auth2)), "000");
  await call(intents, event({ requestType: "Settlement", transactionAmount: 10, cardTransactionAuthorizationId: auth2.cardTransactionAuthorizationId }));
  await call(intents, event({ requestType: "Refund", transactionAmount: 4, cardTransactionAuthorizationId: auth2.cardTransactionAuthorizationId }));
  assert.equal(await bal(accounts.agent("c1", "a1")), 2400);
  assert.equal(await bal(accounts.merchant()), 600);
});

test("concurrent authorizations for one intent: exactly one approves", { skip }, async () => {
  const { intents, bal } = await setup();
  await intents.createIntent(A1, { amountCents: 1000, merchant: "Acme" });
  const answers = await Promise.all([1, 2, 3, 4].map(() => call(intents, event({ transactionAmount: 10 }))));
  assert.deepEqual(answers.map(code).sort(), ["000", "119", "119", "119"]);
  assert.equal(await bal(accounts.merchant()), 1000);
});

test("over budget: declines 911 and commits nothing", { skip }, async () => {
  const { intents, pool, bal } = await setup({ budgetMs: 150 });
  await intents.createIntent(A1, { amountCents: 1000, merchant: "Acme" });
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM app_spend FOR UPDATE");
    // The intent is locked elsewhere: SKIP LOCKED finds nothing, so make the event row itself the wait instead.
    const b = event({ transactionAmount: 10 });
    await blocker.query("INSERT INTO miden_event (event_id, source, decision) VALUES ($1, 'callback', 'pending')", [b.eventId]);
    const t0 = Date.now();
    assert.equal(code(await call(intents, b)), "911");
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  assert.equal(await bal(accounts.merchant()), 0);
  assert.equal(code(await call(intents, event({ transactionAmount: 10 }))), "000");
});
