import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import pg from "pg";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createRepositories } from "../src/db/repositories/createRepositories.js";
import { ApprovalInteractor, type IntentReleasePort } from "../src/lib/interactors/ApprovalInteractor.js";
import { loosensApproval } from "../src/lib/interactors/CardholderInteractor.js";
import { approvalRequired, approvalStatement, challengeCommitsTo } from "../src/lib/services/approvalPolicy.js";
import { AgentCardsError } from "../src/errors.js";
import type { AddressInfo } from "node:net";
import { createAppServer } from "../src/createHttpServer.js";
import { AgentWallets } from "../src/lib/services/AgentWallets.js";
import { Ledger } from "../src/lib/services/Ledger.js";
import { DEFAULT_TIERS } from "../src/lib/services/tiers.js";
import { createDepositAddressRepository } from "../src/db/repositories/createChainRepositories.js";
import { CardholderInteractor, type CardholderContext } from "../src/lib/interactors/CardholderInteractor.js";
import { DeveloperInteractor } from "../src/lib/interactors/DeveloperInteractor.js";

// ---------- pure rules (no database) ----------

test("approval is required only above the agent's threshold, judged on the intent's max amount", () => {
  assert.equal(approvalRequired({ approvalAboveCents: null }, 1_000_000), false);
  assert.equal(approvalRequired({ approvalAboveCents: 5000 }, 5000), false);
  assert.equal(approvalRequired({ approvalAboveCents: 5000 }, 5001), true);
  assert.equal(approvalRequired({ approvalAboveCents: 0 }, 1), true);
});

test("raising or switching off the threshold loosens it; lowering or setting one does not", () => {
  assert.equal(loosensApproval(5000, 6000), true);
  assert.equal(loosensApproval(5000, null), true);
  assert.equal(loosensApproval(5000, 4000), false);
  assert.equal(loosensApproval(5000, 5000), false);
  assert.equal(loosensApproval(null, 100), false);
  assert.equal(loosensApproval(null, null), false);
});

// ---------- a software passkey (a real P-256 authenticator, so the library's verification runs for real) ----------

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

/** Minimal CBOR: unsigned/negative ints, byte and text strings, maps. Enough for attestationObject and a COSE key. */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") { const s = Buffer.from(v, "utf8"); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
}

class SoftPasskey {
  readonly id = randomBytes(16);
  private readonly key: KeyObject;
  private readonly pub: KeyObject;
  counter = 0;
  constructor(readonly rpId: string, readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey; this.pub = publicKey;
  }
  private rpHash() { return createHash("sha256").update(this.rpId).digest(); }
  private clientData(type: string, challenge: string, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
  register(challenge: string) {
    const jwk = this.pub.export({ format: "jwk" }) as { x: string; y: string };
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.id.length);
    const count = Buffer.alloc(4); count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([this.rpHash(), Buffer.from([0x45]), count, Buffer.alloc(16), idLen, this.id, cose]);
    const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(this.clientData("webauthn.create", challenge)), attestationObject: b64u(attestationObject), transports: ["internal"] },
    };
  }
  /** `flags` 0x05 = user present + verified. */
  assert(challenge: string, opts: { flags?: number; origin?: string } = {}) {
    this.counter++;
    const count = Buffer.alloc(4); count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([this.rpHash(), Buffer.from([opts.flags ?? 0x05]), count]);
    const clientDataJSON = this.clientData("webauthn.get", challenge, opts.origin);
    const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]), this.key);
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: "" },
    };
  }
}

// ---------- database cases ----------

// Runs only with DATABASE_URL (each case gets its own schema).
const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
const admin = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 2 }) : undefined;
const pools: pg.Pool[] = [];
const schemas: string[] = [];
const servers: { close(): void }[] = [];
after(async () => {
  for (const sv of servers) sv.close();
  for (const p of pools) await p.end();
  for (const s of schemas) await admin!.query(`DROP SCHEMA ${s} CASCADE`);
  await admin?.end();
});

const PUBLIC_URL = "https://app.spendkit.test";

/**
 * Stand-in for migration 014 (spend-intents branch): only the columns this feature reads. Removed once 014 lands;
 * IF NOT EXISTS keeps it harmless if 014 is already in the tree.
 */
const MIGRATION_014_STANDIN = `
  ALTER TABLE app_spend ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 minutes';
  ALTER TABLE app_spend ADD COLUMN IF NOT EXISTS max_amount_cents BIGINT;
  ALTER TABLE app_spend ADD COLUMN IF NOT EXISTS approval TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE app_spend ADD COLUMN IF NOT EXISTS context TEXT;
  ALTER TABLE app_spend ADD COLUMN IF NOT EXISTS merchant_match TEXT;
  ALTER TABLE app_spend ADD COLUMN IF NOT EXISTS merchant_acceptor_id TEXT;
  ALTER TABLE app_spend ADD COLUMN IF NOT EXISTS uses_allowed INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE app_spend ADD COLUMN IF NOT EXISTS auth_ref TEXT;
  ALTER TABLE app_spend DROP CONSTRAINT IF EXISTS app_spend_status_check;
  ALTER TABLE app_spend ADD CONSTRAINT app_spend_status_check CHECK (status IN ('processing', 'approved', 'declined', 'voided', 'expired'));`;

async function setup() {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
  pools.push(pool);
  await migrate(pool);
  await pool.query(MIGRATION_014_STANDIN);
  const repos = createRepositories(createDatabase(pool));
  const released: { spendId: string; reason: string }[] = [];
  // Fake of SpendIntents.releaseIntent with the agreed semantics: acts only on a processing, unauthorized intent.
  const intents: IntentReleasePort = {
    async releaseIntent(spendId, reason) {
      released.push({ spendId, reason });
      const r = await pool.query(
        `UPDATE app_spend SET status = $2, reason = $3 WHERE spend_id = $1 AND status = 'processing' AND auth_ref IS NULL RETURNING status`,
        [spendId, reason === "expired" ? "expired" : "declined", reason]);
      return r.rowCount ? { released: true, status: r.rows[0].status } : { released: false, status: (await pool.query(`SELECT status FROM app_spend WHERE spend_id = $1`, [spendId])).rows[0].status };
    },
  };
  let clock = new Date();
  const approvals = new ApprovalInteractor({ approvals: repos.approvals, users: repos.users, intents, publicUrl: PUBLIC_URL, now: () => clock });

  async function owner(n: string) {
    const userId = `u_${n}`, cardId = `c_${n}`;
    await pool.query(`INSERT INTO app_user (id, email, token_hash) VALUES ($1, $2, $3)`, [userId, `${n}@example.com`, `h_${n}`]);
    await pool.query(`INSERT INTO app_card (card_id, user_id, customer_id, per_txn_cents, daily_cents) VALUES ($1, $2, 'cust', 100000, 100000)`, [cardId, userId]);
    await pool.query(`INSERT INTO app_agent (card_id, agent_id, name, token_hash, per_txn_cents, daily_cents, approval_above_cents)
      VALUES ($1, 'a_1', 'Shopper', $2, 100000, 100000, 5000)`, [cardId, `ah_${n}`]);
    return { userId, cardId };
  }
  let seq = 0;
  async function intent(cardId: string, o: { amount?: number; max?: number; expiresInMs?: number; approval?: string; context?: string } = {}) {
    const spendId = `sp_${++seq}${randomBytes(3).toString("hex")}`;
    await pool.query(
      `INSERT INTO app_spend (spend_id, card_id, agent_id, idempotency_key, amount_cents, max_amount_cents, merchant, merchant_match, mcc, status, approval, context, expires_at)
       VALUES ($1, $2, 'a_1', $1, $3, $4, 'Acme Flights', 'acme flights', '4511', 'processing', $5, $6, $7)`,
      [spendId, cardId, o.amount ?? 12000, o.max ?? o.amount ?? 12000, o.approval ?? "pending", o.context ?? "Flight LOS to NBO for the offsite <b>", new Date(clock.getTime() + (o.expiresInMs ?? 30 * 60_000))]);
    return spendId;
  }
  async function enrol(userId: string) {
    const pk = new SoftPasskey("app.spendkit.test", PUBLIC_URL);
    const opts = await approvals.registrationOptions(userId);
    await approvals.register(userId, "owner_token", pk.register(opts.challenge));
    return pk;
  }
  const row = async (spendId: string) => (await pool.query(`SELECT status, approval, reason FROM app_spend WHERE spend_id = $1`, [spendId])).rows[0];
  return { pool, repos, approvals, released, owner, intent, enrol, row, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

async function rejects(p: Promise<unknown>, status: number, re?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AgentCardsError, `expected AgentCardsError, got ${e}`);
    assert.equal(e.status, status, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

test("first-use passkey enrolment, and a second enrolment is refused", { skip }, async () => {
  const t = await setup();
  const { userId } = await t.owner("a");
  assert.equal((await t.approvals.passkeys(userId)).hasPasskey, false);
  await t.enrol(userId);
  const keys = await t.approvals.passkeys(userId);
  assert.equal(keys.passkeys.length, 1);
  assert.equal(keys.passkeys[0]!.registeredVia, "owner_token");
  await rejects(t.approvals.registrationOptions(userId), 409);
});

test("a registration signed for another origin is rejected", { skip }, async () => {
  const t = await setup();
  const { userId } = await t.owner("a");
  const pk = new SoftPasskey("app.spendkit.test", "https://evil.test");
  const opts = await t.approvals.registrationOptions(userId);
  await rejects(t.approvals.register(userId, "owner_token", pk.register(opts.challenge)), 401);
  assert.equal((await t.approvals.passkeys(userId)).hasPasskey, false);
});

test("owner approves a pending intent; the signed statement is stored as evidence", { skip }, async () => {
  const t = await setup();
  const { userId, cardId } = await t.owner("a");
  const pk = await t.enrol(userId);
  const spendId = await t.intent(cardId, { amount: 12000, max: 12500 });

  const pending = await t.approvals.listPending(userId);
  assert.deepEqual(pending.map((i) => i.spendId), [spendId]);
  assert.equal(pending[0]!.context, "Flight LOS to NBO for the offsite <b>");

  const { options, statement } = await t.approvals.decisionOptions(userId, spendId, "approve");
  assert.equal(statement.maxAmountCents, 12500);
  assert.equal(statement.merchantMatch, "acme flights");
  assert.equal(statement.mcc, "4511");
  assert.equal(statement.usesAllowed, 1);
  assert.deepEqual(statement.shown, { agentName: "Shopper", amountCents: 12000, merchant: "Acme Flights", context: "Flight LOS to NBO for the offsite <b>" });
  assert.equal(statement.decision, "approved");
  assert.equal(options.userVerification, "required");

  const assertion = pk.assert(options.challenge);
  const v = await t.approvals.decide(userId, spendId, "approve", assertion);
  assert.equal(v.approval, "approved");
  assert.equal(v.decision?.decision, "approved");
  assert.deepEqual(await t.row(spendId), { status: "processing", approval: "approved", reason: null });
  assert.equal(t.released.length, 0);

  const ev = (await t.repos.approvals.decisionFor(spendId))!;
  assert.equal(ev.decision, "approved");
  assert.equal(ev.challenge, options.challenge);
  assert.ok(challengeCommitsTo(ev.challenge, ev.statement), "challenge commits to the stored statement");
  assert.deepEqual(JSON.parse(ev.statement), statement);
  assert.deepEqual(ev.assertion, assertion);
  assert.equal((await t.approvals.listPending(userId)).length, 0);

  // Evidence is append-only.
  await assert.rejects(t.pool.query(`UPDATE app_spend_approval SET decision = 'denied'`), /append-only/);
  await assert.rejects(t.pool.query(`DELETE FROM app_spend_approval`), /append-only/);
});

test("a replayed assertion is refused (challenges are single use)", { skip }, async () => {
  const t = await setup();
  const { userId, cardId } = await t.owner("a");
  const pk = await t.enrol(userId);
  const spendId = await t.intent(cardId);
  const { options } = await t.approvals.decisionOptions(userId, spendId, "approve");
  const assertion = pk.assert(options.challenge);
  await t.approvals.decide(userId, spendId, "approve", assertion);
  await rejects(t.approvals.decide(userId, spendId, "approve", assertion), 401);
});

test("owner denies: evidence stored and the hold released through SpendIntents", { skip }, async () => {
  const t = await setup();
  const { userId, cardId } = await t.owner("a");
  const pk = await t.enrol(userId);
  const spendId = await t.intent(cardId);
  const { options, statement } = await t.approvals.decisionOptions(userId, spendId, "deny");
  assert.equal(statement.decision, "denied");
  const v = await t.approvals.decide(userId, spendId, "deny", pk.assert(options.challenge));
  assert.equal(v.decision?.decision, "denied");
  assert.equal(v.status, "declined");
  assert.deepEqual(t.released, [{ spendId, reason: "owner_denied" }]);
  assert.deepEqual(await t.row(spendId), { status: "declined", approval: "pending", reason: "owner_denied" });
  assert.equal((await t.repos.approvals.decisionFor(spendId))!.decision, "denied");
});

test("a denial whose release failed still counts as decided", { skip }, async () => {
  const t = await setup();
  const { userId, cardId } = await t.owner("a");
  const pk = await t.enrol(userId);
  const spendId = await t.intent(cardId);
  const failing = new ApprovalInteractor({
    approvals: t.repos.approvals, users: t.repos.users, publicUrl: PUBLIC_URL,
    intents: { releaseIntent: async () => { throw new Error("db blip"); } },
  });
  const { options } = await failing.decisionOptions(userId, spendId, "deny");
  await failing.decide(userId, spendId, "deny", pk.assert(options.challenge));
  // Still pending in app_spend (nothing can authorize against it), but no longer listed and cannot be approved now.
  assert.equal((await t.row(spendId)).approval, "pending");
  assert.equal((await failing.listPending(userId)).length, 0);
  await rejects(failing.decisionOptions(userId, spendId, "approve"), 409, /already been decided/);
});

test("an approve challenge cannot be used to deny, nor for another intent", { skip }, async () => {
  const t = await setup();
  const { userId, cardId } = await t.owner("a");
  const pk = await t.enrol(userId);
  const a = await t.intent(cardId);
  const b = await t.intent(cardId);
  const { options } = await t.approvals.decisionOptions(userId, a, "approve");
  await rejects(t.approvals.decide(userId, a, "deny", pk.assert(options.challenge)), 401);
  const again = await t.approvals.decisionOptions(userId, a, "approve");
  await rejects(t.approvals.decide(userId, b, "approve", pk.assert(again.options.challenge)), 401);
  assert.equal((await t.row(a)).approval, "pending");
  assert.equal((await t.row(b)).approval, "pending");
});

test("an assertion without user verification is refused", { skip }, async () => {
  const t = await setup();
  const { userId, cardId } = await t.owner("a");
  const pk = await t.enrol(userId);
  const spendId = await t.intent(cardId);
  const { options } = await t.approvals.decisionOptions(userId, spendId, "approve");
  await rejects(t.approvals.decide(userId, spendId, "approve", pk.assert(options.challenge, { flags: 0x01 })), 401);
  assert.equal((await t.row(spendId)).approval, "pending");
});

test("another owner can neither see, approve with, nor lend a passkey to an intent", { skip }, async () => {
  const t = await setup();
  const a = await t.owner("a");
  const b = await t.owner("b");
  await t.enrol(a.userId);
  const pkB = await t.enrol(b.userId);
  const spendId = await t.intent(a.cardId);
  await rejects(t.approvals.getIntent(b.userId, spendId), 404);
  await rejects(t.approvals.decisionOptions(b.userId, spendId, "approve"), 404);
  // B signs A's challenge with B's passkey: the challenge is A's, so it is unknown to B.
  const { options } = await t.approvals.decisionOptions(a.userId, spendId, "approve");
  await rejects(t.approvals.decide(b.userId, spendId, "approve", pkB.assert(options.challenge)), 401);
  // ... and under A's session, B's passkey is not A's.
  const again = await t.approvals.decisionOptions(a.userId, spendId, "approve");
  await rejects(t.approvals.decide(a.userId, spendId, "approve", pkB.assert(again.options.challenge)), 403);
  assert.equal((await t.row(spendId)).approval, "pending");
});

test("expired intents and intents that do not need approval cannot be decided", { skip }, async () => {
  const t = await setup();
  const { userId, cardId } = await t.owner("a");
  const pk = await t.enrol(userId);
  const none = await t.intent(cardId, { approval: "none" });
  await rejects(t.approvals.decisionOptions(userId, none, "approve"), 409);
  const soon = await t.intent(cardId, { expiresInMs: 60_000 });
  const { options } = await t.approvals.decisionOptions(userId, soon, "approve");
  t.advance(61_000);
  // The challenge expired with the intent.
  await rejects(t.approvals.decide(userId, soon, "approve", pk.assert(options.challenge)), 401);
  await rejects(t.approvals.decisionOptions(userId, soon, "approve"), 409, /expired/);
  assert.equal((await t.approvals.listPending(userId)).length, 0);
});

test("an intent that changed after the options were made is not approved", { skip }, async () => {
  const t = await setup();
  const { userId, cardId } = await t.owner("a");
  const pk = await t.enrol(userId);
  const spendId = await t.intent(cardId, { amount: 12000 });
  const { options } = await t.approvals.decisionOptions(userId, spendId, "approve");
  await t.pool.query(`UPDATE app_spend SET max_amount_cents = 99000 WHERE spend_id = $1`, [spendId]);
  await rejects(t.approvals.decide(userId, spendId, "approve", pk.assert(options.challenge)), 409, /changed/);
  assert.equal((await t.row(spendId)).approval, "pending");
  assert.equal(await t.repos.approvals.decisionFor(spendId), undefined);
});

test("approve and expiry racing: exactly one wins", { skip }, async () => {
  const t = await setup();
  const { userId, cardId } = await t.owner("a");
  const pk = await t.enrol(userId);
  const spendId = await t.intent(cardId);
  const { options } = await t.approvals.decisionOptions(userId, spendId, "approve");
  const assertion = pk.assert(options.challenge);
  const expire = (async () => {
    const c = await t.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT 1 FROM app_spend WHERE spend_id = $1 FOR UPDATE`, [spendId]);
      await new Promise((r) => setTimeout(r, 50));
      await c.query(`UPDATE app_spend SET status = 'expired' WHERE spend_id = $1 AND status = 'processing'`, [spendId]);
      await c.query("COMMIT");
    } finally { c.release(); }
  })();
  await new Promise((r) => setTimeout(r, 10));
  const approve = t.approvals.decide(userId, spendId, "approve", assertion).then(() => "approved", (e: AgentCardsError) => `refused ${e.status}`);
  const [, outcome] = await Promise.all([expire, approve]);
  const r = await t.row(spendId);
  assert.equal(outcome, "refused 409");
  assert.deepEqual([r.status, r.approval], ["expired", "pending"]);
});

test("a stored challenge whose statement was swapped is refused", { skip }, async () => {
  const t = await setup();
  const { userId, cardId } = await t.owner("a");
  const pk = await t.enrol(userId);
  const spendId = await t.intent(cardId, { amount: 12000 });
  const { options, statement } = await t.approvals.decisionOptions(userId, spendId, "approve");
  // Someone with database write access rewrites what the owner "saw"; the signed challenge no longer commits to it.
  const forged = JSON.stringify({ ...statement, context: "something else" });
  await t.pool.query(`UPDATE app_webauthn_challenge SET statement = $1 WHERE challenge = $2`, [forged, options.challenge]);
  await rejects(t.approvals.decide(userId, spendId, "approve", pk.assert(options.challenge)), 401);
  assert.equal((await t.row(spendId)).approval, "pending");
});

test("the statement is deterministic and signs every field the authorization binds on", () => {
  const i = {
    spendId: "sp_1", cardId: "c_1", agentId: "a_1", agentName: "Shopper", amountCents: 100, maxAmountCents: 110, merchant: "M",
    merchantMatch: "acme", merchantAcceptorId: null, usesAllowed: 1,
    mcc: null, context: "ctx", expiresAt: new Date("2026-11-20T12:00:00Z"), status: "processing", approval: "pending" as const, createdAt: new Date(),
  };
  const s = approvalStatement("approved", i, "rp.test");
  assert.equal(s, approvalStatement("approved", { ...i, createdAt: new Date(0) }, "rp.test"));
  assert.notEqual(s, approvalStatement("denied", i, "rp.test"));
  assert.deepEqual(Object.keys(JSON.parse(s)), ["v", "type", "decision", "rpId", "spendId", "cardId", "agentId", "currency", "maxAmountCents",
    "merchantMatch", "merchantAcceptorId", "mcc", "usesAllowed", "expiresAt", "shown"]);
  // Each binding field changes what is signed.
  for (const change of [{ maxAmountCents: 111 }, { merchantMatch: "acme2" }, { merchantAcceptorId: "MID1" }, { mcc: "5411" }, { usesAllowed: 2 },
    { expiresAt: new Date("2026-11-20T12:00:01Z") }]) {
    assert.notEqual(approvalStatement("approved", { ...i, ...change }, "rp.test"), s, JSON.stringify(change));
  }
});

// ---------- loosening an agent's threshold (Lin's review #1) and challenge hygiene (#5) ----------

/** The whole HTTP stack (owner, developer and approval routes) over one schema, plus a JSON caller. */
async function httpSetup() {
  const t = await setup();
  const db = createDatabase(t.pool);
  const ledger = new Ledger(undefined, t.repos.ledger);
  const wallets = new AgentWallets(ledger);
  const cardholders = new CardholderInteractor({
    users: t.repos.users, cards: t.repos.cards, agents: t.repos.agents, spends: t.repos.spends, fundings: t.repos.fundings, oneTimeCards: t.repos.oneTimeCards,
    ledger, wallets, addresses: createDepositAddressRepository(db, "base-sepolia"),
    deriveAddress: (i: number) => `0x${i.toString(16).padStart(40, "0")}`, tiers: DEFAULT_TIERS, chain: "base-sepolia", sandbox: true, simulatedDeposits: true,
    lifecycle: { submitKyc: async () => ({ kycStatus: "Initiated" }), kycStatus: async () => ({ status: "Approved", customerId: "cust", kycToken: "kt" }), cardBalance: async () => 0, transactions: async () => [] },
    cardIssuer: { issue: async () => ({ id: "card-x", agentId: "x", policy: {} }) },
    funding: { fund: async () => ({ id: "m1", status: "confirmed" as const }) },
  } as unknown as CardholderContext);
  const developers = new DeveloperInteractor({
    developers: t.repos.developers, webhookEvents: t.repos.webhookEvents, app: cardholders, allowLocalWebhooks: false, publicUrl: PUBLIC_URL,
    resolve: async () => ["93.184.216.34"],
  });
  const probe = createAppServer({ cardholders }, { allowedHosts: [] });
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createAppServer({ cardholders, developers, approvals: t.approvals }, { allowedHosts: [`127.0.0.1:${port}`] });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  servers.push(server);
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  /** A card and agent a_1 (threshold 5000) for an existing user. */
  const giveCard = async (userId: string) => {
    const cardId = `c_${userId}`;
    await t.pool.query(`INSERT INTO app_card (card_id, user_id, customer_id, per_txn_cents, daily_cents) VALUES ($1, $2, 'cust', 100000, 100000)`, [cardId, userId]);
    await t.pool.query(`INSERT INTO app_agent (card_id, agent_id, name, token_hash, per_txn_cents, daily_cents, approval_above_cents)
      VALUES ($1, 'a_1', 'Shopper', $2, 100000, 100000, 5000)`, [cardId, `ah_${userId}`]);
    wallets.create(cardId, "a_1", { perTransactionCents: 100000, dailyCents: 100000 });
    return cardId;
  };
  const threshold = async (cardId: string) => (await t.pool.query(`SELECT approval_above_cents AS v FROM app_agent WHERE card_id = $1`, [cardId])).rows[0].v;
  const changes = async (cardId: string) => (await t.pool.query(
    `SELECT from_cents, to_cents, via, credential_id IS NOT NULL AS signed FROM app_agent_approval_change WHERE card_id = $1 ORDER BY id`, [cardId])).rows;
  return { ...t, call, giveCard, threshold, changes };
}

test("HTTP: a developer key cannot loosen approval, directly or through a session it mints (dk_ -> us_ -> loosen)", { skip }, async () => {
  const t = await httpSetup();
  const key = (await t.call("POST", "/developer/v1/signup", undefined, { name: "Dev", email: "d@dev.example" })).json.key as string;
  const uid = (await t.call("POST", "/developer/v1/users", key, { externalId: "x1", email: "x1@example.com" })).json.userId as string;
  const cardId = await t.giveCard(uid);
  const limits = `/api/me/agents/a_1/limits`;

  // Directly with the developer key.
  assert.equal((await t.call("POST", `/developer/v1/users/${uid}/agents/a_1/limits`, key, { approvalAboveCents: null })).status, 403);
  // Through a session the developer mints: no passkey yet, so a session may not loosen at all.
  const us = (await t.call("POST", `/developer/v1/users/${uid}/sessions`, key, {})).json.token as string;
  assert.match(us, /^us_/);
  assert.equal((await t.call("POST", limits, us, { approvalAboveCents: null })).status, 403);
  assert.equal((await t.call("POST", limits, us, { approvalAboveCents: 9000 })).status, 403);
  assert.equal(await t.threshold(cardId), "5000");
  // Tightening is fine from either.
  assert.equal((await t.call("POST", limits, us, { approvalAboveCents: 4000 })).status, 200);
  assert.equal(await t.threshold(cardId), "4000");

  // Once the user has a passkey, the session needs a passkey assertion over this exact change.
  const pk = new SoftPasskey("app.spendkit.test", PUBLIC_URL);
  const reg = await t.call("POST", "/api/me/passkeys/options", us, {});
  assert.equal((await t.call("POST", "/api/me/passkeys", us, { credential: pk.register(reg.json.challenge) })).status, 201);
  const refused = await t.call("POST", limits, us, { approvalAboveCents: null });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /passkey/);
  // A passkey a developer session just enrolled cannot authorize a loosening for 24 hours (dk_ -> us_ -> enrol -> loosen).
  const tooSoon = await t.call("POST", "/api/me/agents/a_1/approval-threshold/options", us, { approvalAboveCents: null });
  assert.equal(tooSoon.status, 403);
  assert.match(tooSoon.json.error, /24 hours/);
  assert.equal(await t.threshold(cardId), "4000");
  await t.pool.query(`UPDATE app_passkey SET created_at = now() - interval '25 hours' WHERE user_id = $1`, [uid]);
  const opts = await t.call("POST", "/api/me/agents/a_1/approval-threshold/options", us, { approvalAboveCents: null });
  assert.equal(opts.status, 200);
  assert.deepEqual([opts.json.statement.fromCents, opts.json.statement.toCents, opts.json.statement.agentId], [4000, null, "a_1"]);
  // The signature covers {from, to}: it cannot be spent on a different change.
  const forOther = pk.assert(opts.json.options.challenge);
  assert.equal((await t.call("POST", limits, us, { approvalAboveCents: 999999, credential: forOther })).status, 409);
  assert.equal(await t.threshold(cardId), "4000");
  const opts2 = await t.call("POST", "/api/me/agents/a_1/approval-threshold/options", us, { approvalAboveCents: null });
  const ok = await t.call("POST", limits, us, { approvalAboveCents: null, credential: pk.assert(opts2.json.options.challenge) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.approvalAboveCents, null);
  assert.equal(await t.threshold(cardId), null);
  assert.deepEqual(await t.changes(cardId), [{ from_cents: "4000", to_cents: null, via: "passkey", signed: true }]);
  await assert.rejects(t.pool.query(`DELETE FROM app_agent_approval_change`), /append-only/);
});

test("HTTP: the owner's own token loosens without a passkey, but needs the passkey once there is one", { skip }, async () => {
  const t = await httpSetup();
  const signup = await t.call("POST", "/api/signup", undefined, { email: "own@example.com" });
  assert.equal(signup.status, 201);
  const uk = signup.json.token as string;
  const cardId = await t.giveCard(signup.json.userId);
  const limits = `/api/me/agents/a_1/limits`;
  assert.equal((await t.call("POST", limits, uk, { approvalAboveCents: 8000 })).status, 200);
  assert.deepEqual(await t.changes(cardId), [{ from_cents: "5000", to_cents: "8000", via: "owner_token", signed: false }]);

  const pk = new SoftPasskey("app.spendkit.test", PUBLIC_URL);
  const reg = await t.call("POST", "/api/me/passkeys/options", uk, {});
  assert.equal((await t.call("POST", "/api/me/passkeys", uk, { credential: pk.register(reg.json.challenge) })).status, 201);
  assert.equal((await t.call("POST", limits, uk, { approvalAboveCents: 9000 })).status, 403);
  // Options made, then someone tightens it: the signed {from, to} is stale and is refused.
  const opts = await t.call("POST", "/api/me/agents/a_1/approval-threshold/options", uk, { approvalAboveCents: 9000 });
  assert.equal((await t.call("POST", limits, uk, { approvalAboveCents: 7000 })).status, 200);
  assert.equal((await t.call("POST", limits, uk, { approvalAboveCents: 9000, credential: pk.assert(opts.json.options.challenge) })).status, 409);
  assert.equal(await t.threshold(cardId), "7000");
  // Asking for options for a change that is not a loosening is a 400.
  assert.equal((await t.call("POST", "/api/me/agents/a_1/approval-threshold/options", uk, { approvalAboveCents: 100 })).status, 400);
});

test("a user cannot burn another user's challenge", { skip }, async () => {
  const t = await setup();
  const a = await t.owner("a");
  const b = await t.owner("b");
  const pk = await t.enrol(a.userId);
  const spendId = await t.intent(a.cardId);
  const { options } = await t.approvals.decisionOptions(a.userId, spendId, "approve");
  assert.equal(await t.repos.approvals.takeChallenge(options.challenge, b.userId, new Date()), undefined);
  const v = await t.approvals.decide(a.userId, spendId, "approve", pk.assert(options.challenge));
  assert.equal(v.approval, "approved");
});

test("the sign count only moves forward: a stale count loses the race", { skip }, async () => {
  const t = await setup();
  const { userId, cardId } = await t.owner("a");
  const pk = await t.enrol(userId);
  const credentialId = Buffer.from(pk.id).toString("base64url");
  await t.pool.query(`UPDATE app_passkey SET sign_count = 7 WHERE credential_id = $1`, [credentialId]);
  const base = { cardId, agentId: "a_1", userId, fromCents: 5000, toCents: null, via: "passkey" as const, now: new Date() };
  const sig = { credentialId, statement: "{}", challenge: "c", assertion: {} };
  assert.equal(await t.repos.approvals.recordApprovalChange({ ...base, passkey: { ...sig, newSignCount: 7 } }), "counter_race");
  assert.equal(await t.repos.approvals.recordApprovalChange({ ...base, passkey: { ...sig, newSignCount: 8 } }), "recorded");
  assert.equal((await t.pool.query(`SELECT sign_count FROM app_passkey`)).rows[0].sign_count, "8");
});
