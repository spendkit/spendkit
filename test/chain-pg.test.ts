import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createCursorStore, createDepositAddressRepository } from "../src/db/repositories/createChainRepositories.js";

// Runs only with DATABASE_URL, like test/ledger.test.ts. Each case gets its own schema.
const databaseUrl = process.env.DATABASE_URL;
const admin = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 2 }) : undefined;
const pools: pg.Pool[] = [];
const schemas: string[] = [];

async function fresh(): Promise<pg.Pool> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
  pools.push(pool);
  await migrate(pool);
  return pool;
}

after(async () => {
  for (const p of pools) await p.end();
  for (const s of schemas) await admin!.query(`DROP SCHEMA ${s} CASCADE`);
  await admin?.end();
});

const A = "0x00000000000000000000000000000000000000AA";

test("cursor starts empty, persists, and never moves backwards", { skip: !databaseUrl }, async () => {
  const pool = await fresh();
  const c = createCursorStore(createDatabase(pool), "base:usdc");
  assert.equal(await c.get(), undefined);
  await c.set(100);
  await c.set(90);
  assert.equal(await createCursorStore(createDatabase(pool), "base:usdc").get(), 100);
  assert.equal(await createCursorStore(createDatabase(pool), "other").get(), undefined);
});

test("deposit addresses: case-insensitive, idempotent, one card per address", { skip: !databaseUrl }, async () => {
  const pool = await fresh();
  const d = createDepositAddressRepository(createDatabase(pool));
  await d.add(A, "card-1");
  await d.add(A.toLowerCase(), "card-1");
  await assert.rejects(d.add(A, "card-2"), /already belongs to card card-1/);
  await assert.rejects(d.add(A, " "), /without a card/);
  await assert.rejects(d.add("0x123", "card-1"), /40 hex/);
  assert.deepEqual(await d.all(), [A.toLowerCase()]);
  assert.equal(await d.cardFor(A), "card-1");
  assert.equal(await createDepositAddressRepository(createDatabase(pool), "ethereum").cardFor(A), undefined);
});

// ----- Lin's deposit review, todo tmwg7ufns8: CHAIN_WATCHER=1 with Circle on must credit one transfer once -----

test("a transfer to a Circle wallet is credited once, by Circle, even with the chain watcher running", { skip: !databaseUrl }, async () => {
  const { Ledger, accounts } = await import("../src/lib/services/Ledger.js");
  const { CircleDeposits } = await import("../src/adapters/deposits/CircleDeposits.js");
  const { BASE_SEPOLIA_USDC, MemoryCursor, TRANSFER_TOPIC } = await import("../src/adapters/deposits/BaseUsdcWatcher.js");
  const { createChainWatcher } = await import("../src/startBackgroundWorkers.js");
  const pool = await fresh();
  const addresses = createDepositAddressRepository(createDatabase(pool), "base-sepolia");
  const CIRCLE_WALLET = "0x" + "c1".repeat(20), HD = "0x" + "4d".repeat(20);
  await addresses.assign(CIRCLE_WALLET, "card-c", 0, "circle");
  await addresses.assign(HD, "card-h", 1, "hd");
  const ledger = new Ledger();

  // The same on-chain transfer, as the chain sees it (log index 3) and as Circle reports it.
  const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
  const log = (to: string, tx: string) => ({ address: BASE_SEPOLIA_USDC, topics: [TRANSFER_TOPIC, topic("0x" + "77".repeat(20)), topic(to)], data: `0x${(5_000_000).toString(16).padStart(64, "0")}`, blockNumber: "0x64", transactionHash: tx, logIndex: "0x3" });
  const logs = [log(CIRCLE_WALLET, "0xaaa1"), log(HD, "0xbbb2")];
  const rpc = async (method: string, params: unknown[]) => {
    if (method === "eth_blockNumber") return "0x100";
    const wanted = (params[0] as { topics: [string, null, string[]] }).topics[2];
    return logs.filter((l) => wanted.includes(l.topics[2]!));
  };
  const watcher = createChainWatcher({ label: "base-sepolia", token: BASE_SEPOLIA_USDC, rpc, cursor: new MemoryCursor(99), confirmations: 5 }, { ledger, addresses, log: () => {} });
  await watcher.tick();

  const circle = new CircleDeposits({
    circle: {
      notificationKey: async () => ({ algorithm: "", publicKey: "" }), transaction: async () => ({ id: "x" }), ownsWallet: async () => true,
      token: async () => ({ symbol: "USDC", blockchain: "BASE-SEPOLIA", tokenAddress: BASE_SEPOLIA_USDC, decimals: 6 }),
      recentInbound: async () => [{ id: "c1", walletId: "w1", blockchain: "BASE-SEPOLIA", tokenId: "tok", destinationAddress: CIRCLE_WALLET, transactionType: "INBOUND", state: "COMPLETE", amounts: ["5"], txHash: "0xaaa1" }],
    },
    ledger, addresses: addresses.onRail("circle"),
  });
  await circle.reconcile();

  assert.equal(await ledger.balance(accounts.holding("card-c")), 500); // once, not 1000
  assert.equal(await ledger.balance(accounts.holding("card-h")), 500); // the HD address is still watched
});

test("rows from before the rail column are classified by whether our HD wallet derives them", { skip: !databaseUrl }, async () => {
  const pool = await fresh();
  const addresses = createDepositAddressRepository(createDatabase(pool), "base-sepolia");
  const HD = "0x" + "4d".repeat(20), CIRCLE_WALLET = "0x" + "c1".repeat(20), OLD = "0x" + "0d".repeat(20);
  await pool.query(`INSERT INTO deposit_address (chain, address, card_id, derivation_index) VALUES ('base-sepolia', $1, 'h', 4), ('base-sepolia', $2, 'c', 5)`, [HD, CIRCLE_WALLET]);
  await pool.query(`INSERT INTO deposit_address (chain, address, card_id) VALUES ('base-sepolia', $1, 'o')`, [OLD]);
  assert.deepEqual(await addresses.onRail("hd").all(), []); // unclassified rows belong to no rail
  assert.equal(await addresses.classifyUnrailed((a, i) => i === 4 && a === HD), 3);
  assert.deepEqual((await addresses.onRail("hd").all()).sort(), [OLD, HD].sort());
  assert.deepEqual(await addresses.onRail("circle").all(), [CIRCLE_WALLET]);
  assert.equal(await addresses.onRail("hd").cardFor(CIRCLE_WALLET), undefined);
  assert.equal(await addresses.cardFor(CIRCLE_WALLET), "c"); // the unfiltered view still knows it (isOwnAddress, sim deposits)
  assert.equal(await addresses.classifyUnrailed(() => true), 0);
  await assert.rejects(addresses.add(CIRCLE_WALLET, "c", "hd"), /already on the circle rail/);
});

test("derivedSample: lowest and highest derived addresses on this chain, Circle (non-derived) ones left out", { skip: !databaseUrl }, async () => {
  const pool = await fresh();
  const d = createDepositAddressRepository(createDatabase(pool), "base-sepolia");
  assert.deepEqual(await d.derivedSample(10), []);
  const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
  for (const i of [3, 1, 9, 5, 7]) await d.assign(addr(i), `card-${i}`, i);
  await d.add(addr(100), "card-circle");
  // Circle wallets carry a derivation index too (from the shared sequence), but our seed does not derive them.
  await d.assign(addr(150), "card-circle-2", 150, "circle");
  await createDepositAddressRepository(createDatabase(pool), "ethereum").assign(addr(200), "card-eth", 200);
  const all = await d.derivedSample(10);
  assert.deepEqual(all.map((r) => r.derivationIndex).sort((a, b) => a - b), [1, 3, 5, 7, 9]);
  assert.ok(all.every((r) => r.address === addr(r.derivationIndex)));
  assert.deepEqual((await d.derivedSample(2)).map((r) => r.derivationIndex).sort((a, b) => a - b), [1, 9]);
});
