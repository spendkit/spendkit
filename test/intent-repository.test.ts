import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createIntentRepository } from "../src/db/repositories/createIntentRepository.js";

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

async function fresh() {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
  pools.push(pool);
  await migrate(pool);
  await pool.query("INSERT INTO app_user (id, email, token_hash) VALUES ('u1', 'a@example.com', 'h1')");
  await pool.query("INSERT INTO app_card (card_id, user_id, customer_id, per_txn_cents, daily_cents) VALUES ('c1', 'u1', 'cu1', 10000, 50000)");
  await pool.query("INSERT INTO app_agent (card_id, agent_id, name, token_hash, per_txn_cents, daily_cents) VALUES ('c1', 'a1', 'A', 'th1', 5000, 20000)");
  return { pool, repo: createIntentRepository(createDatabase(pool)) };
}

const intent = (spendId: string, over: Record<string, unknown> = {}) => ({
  spendId, cardId: "c1", agentId: "a1", idempotencyKey: `intent:${spendId}`, amountCents: 500, maxAmountCents: 600,
  merchant: "Acme", merchantMatch: "acme", status: "processing" as const, expiresAt: new Date(Date.now() + 60_000), ...over,
});

test("claimEvent: a duplicate returns the stored event and leaves the transaction usable", { skip }, async () => {
  const { repo } = await fresh();
  await repo.transaction(async (tx) => {
    assert.equal(await tx.claimEvent({ eventId: "e1", source: "callback", requestType: "Authorization", cardId: "c1" }), undefined);
    await tx.setEventDecision("e1", "{\"responseCode\":\"000\"}", null);
  });
  const again = await repo.transaction(async (tx) => {
    const stored = await tx.claimEvent({ eventId: "e1", source: "webhook", requestType: null, cardId: null });
    // Still usable after the conflict: a unique violation would have aborted it.
    assert.ok(await tx.findCard("c1"));
    return stored;
  });
  assert.deepEqual(again, { eventId: "e1", source: "callback", decision: "{\"responseCode\":\"000\"}" });
});

test("openIntentsForUpdate filters closed rows, and waits on a locked row instead of skipping it", { skip }, async () => {
  const { repo } = await fresh();
  await repo.transaction(async (tx) => {
    await tx.insert(intent("s1"));
    await tx.insert(intent("s2"));
    await tx.insert(intent("pending", { approval: "pending" }));
    await tx.insert(intent("old", { expiresAt: new Date(Date.now() - 1000) }));
    await tx.insert(intent("plain", { expiresAt: null, maxAmountCents: null, merchantMatch: null, idempotencyKey: "k" }));
  });
  const all = await repo.transaction((tx) => tx.openIntentsForUpdate("c1", new Date()));
  assert.deepEqual(all.map((s) => s.spendId).sort(), ["s1", "s2"]);
  assert.equal(all[0]!.agent.perTxnCents, 5000);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const holder = repo.transaction(async (tx) => {
    await tx.lockSpend("s1");
    locked();
    await held;
  });
  await isLocked;
  // Never SKIP LOCKED: a skipped row could let another agent's intent win. lock_timeout turns the wait into an error.
  await assert.rejects(repo.transaction((tx) => tx.openIntentsForUpdate("c1", new Date()), { timeoutMs: 100 }));
  release();
  await holder;
});

test("findCard knows one-time cards", { skip }, async () => {
  const { pool, repo } = await fresh();
  await pool.query("INSERT INTO app_one_time_card (one_time_id, user_id, spend_id, card_id, amount_cents, status) VALUES ('o1', 'u1', 'sx', 'otc1', 100, 'ready')");
  assert.deepEqual(await repo.transaction((tx) => tx.findCard("otc1")), { kind: "one_time", cardId: "otc1", spendId: "sx" });
  assert.deepEqual(await repo.transaction((tx) => tx.findCard("c1")), { kind: "reusable", cardId: "c1" });
  assert.equal(await repo.transaction((tx) => tx.findCard("nope")), undefined);
});

test("dailyTotals counts an intent at its maximum; expiredIds lists unused expired intents", { skip }, async () => {
  const { repo } = await fresh();
  await repo.transaction(async (tx) => {
    await tx.insert(intent("s1"));
    await tx.insert(intent("gone", { expiresAt: new Date(Date.now() - 600_000) }));
  });
  const totals = await repo.transaction((tx) => tx.dailyTotals("c1", "a1", [new Date(Date.now() - 86_400_000), new Date(Date.now() + 1000)]));
  assert.deepEqual(totals, { cardDailyCents: 50000, cardSpentCents: 1200, agentSpentCents: 1200 });
  assert.deepEqual(await repo.expiredIds(new Date(Date.now() - 120_000), 10), ["gone"]);
});

test("lock_timeout from timeoutMs fails fast instead of waiting on the card row", { skip }, async () => {
  const { pool, repo } = await fresh();
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM app_card WHERE card_id = 'c1' FOR UPDATE");
    const t0 = Date.now();
    await assert.rejects(repo.transaction((tx) => tx.dailyTotals("c1", "a1", [new Date(0), new Date()]), { timeoutMs: 100 }));
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});
