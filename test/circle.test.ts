import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, privateDecrypt, sign, constants } from "node:crypto";
import { CircleDeposits } from "../src/adapters/deposits/CircleDeposits.js";
import { CircleClient, CircleError, circleNetwork, usdcToBaseUnits, uuidFrom, type CircleTx } from "../src/lib/clients/circle/CircleClient.js";
import { BASE_SEPOLIA_USDC } from "../src/adapters/deposits/BaseUsdcWatcher.js";
import { Ledger, accounts } from "../src/lib/services/Ledger.js";

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub = ec.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const signBody = (b: string) => sign("sha256", Buffer.from(b), ec.privateKey).toString("base64");

const ADDR = "0x" + "ab".repeat(20);
function setup(tx: Partial<CircleTx> = {}, symbol = "USDC") {
  const ledger = new Ledger();
  const full: CircleTx = { id: "t1", blockchain: "BASE-SEPOLIA", tokenId: "tok", destinationAddress: ADDR, walletId: "w1", transactionType: "INBOUND", state: "COMPLETE", amounts: ["12.345678"], txHash: "0xAAA", ...tx };
  const circle = { ownsWallet: async () => true, notificationKey: async () => ({ algorithm: "ECDSA_SHA_256", publicKey: pub }), transaction: async () => full, token: async () => ({ symbol, blockchain: "BASE-SEPOLIA", tokenAddress: BASE_SEPOLIA_USDC.toUpperCase().replace("0X","0x"), decimals: 6 }) };
  const dust: bigint[] = [];
  const d = new CircleDeposits({ circle, ledger, addresses: { cardFor: async (a) => (a.toLowerCase() === ADDR ? "card1" : undefined) }, onDust: (x) => dust.push(x.dustBase) });
  const body = JSON.stringify({ notificationType: "transactions.inbound", notification: { id: "t1", amounts: ["999"] } });
  return { ledger, d, body, dust };
}
const hdr = (b: string) => ({ signature: signBody(b), keyId: "0b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c0d" });

test("a signed inbound USDC webhook credits the card once, from Circle's own amount", async () => {
  const s = setup();
  const r = await s.d.handle(s.body, hdr(s.body));
  assert.deepEqual(r, { status: "credited", cardId: "card1", amountCents: 1234, chain: "base-sepolia", isNew: true });
  assert.deepEqual(s.dust, [5678n]);
  const again = await s.d.handle(s.body, hdr(s.body)); // Circle delivers at least once
  assert.equal((again as { isNew: boolean }).isNew, false);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 1234);
});

test("bad or missing signatures are refused and credit nothing", async () => {
  const s = setup();
  await assert.rejects(s.d.handle(s.body, { signature: signBody(s.body + " "), keyId: "0b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c0d" }), /bad signature/);
  await assert.rejects(s.d.handle(s.body, {}), /missing signature/);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 0);
});

test("ignored: not complete, not USDC, outbound, unknown address, unsupported chain", async () => {
  for (const [tx, sym, why] of [
    [{ state: "CONFIRMED" }, "USDC", /state/], [{}, "EURC", /pinned USDC/], [{ transactionType: "OUTBOUND" }, "USDC", /not inbound/],
    [{ destinationAddress: "0x" + "cd".repeat(20) }, "USDC", /not one of ours|not one of our/], [{ blockchain: "ETH" }, "USDC", /unsupported/],
  ] as const) {
    const s = setup(tx, sym);
    const r = await s.d.handle(s.body, hdr(s.body));
    assert.equal(r.status, "ignored");
    assert.match((r as { reason: string }).reason, why);
    assert.equal(await s.ledger.balance(accounts.holding("card1")), 0);
  }
});

test("reconcile credits a missed deposit once and is a no-op on the next pass", async () => {
  const s = setup();
  const credited: number[] = [];
  const full: CircleTx = { id: "t9", blockchain: "BASE-SEPOLIA", tokenId: "tok", destinationAddress: ADDR, walletId: "w1", transactionType: "INBOUND", state: "COMPLETE", amounts: ["5"], txHash: "0xBBB" };
  const other: CircleTx = { ...full, id: "t8", txHash: "0xCCC", destinationAddress: "0x" + "cd".repeat(20) };
  const d = new CircleDeposits({
    circle: { ownsWallet: async () => true, notificationKey: async () => ({ algorithm: "", publicKey: pub }), transaction: async () => full, token: async () => ({ symbol: "USDC", blockchain: "BASE-SEPOLIA", tokenAddress: BASE_SEPOLIA_USDC, decimals: 6 }), recentInbound: async () => [full, other] },
    ledger: s.ledger, addresses: { cardFor: async (a) => (a.toLowerCase() === ADDR ? "card1" : undefined) }, onCredited: (r) => credited.push(r.amountCents),
  });
  assert.deepEqual(await d.reconcile(), { checked: 2, credited: 1, ignored: [] });
  assert.deepEqual(await d.reconcile(), { checked: 2, credited: 0, ignored: [] });
  assert.deepEqual(credited, [500]);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 500);
});

test("a sub-cent-only transfer is logged as dust once, and reconcile neither repeats it nor lists it as ignored", async () => {
  const s = setup();
  const tiny: CircleTx = { id: "t7", blockchain: "BASE-SEPOLIA", tokenId: "tok", destinationAddress: ADDR, walletId: "w1", transactionType: "INBOUND", state: "COMPLETE", amounts: ["0.004"], txHash: "0xEEE" };
  const dust: bigint[] = [];
  const d = new CircleDeposits({
    circle: { ownsWallet: async () => true, notificationKey: async () => ({ algorithm: "", publicKey: pub }), transaction: async () => tiny, token: async () => ({ symbol: "USDC", blockchain: "BASE-SEPOLIA", tokenAddress: BASE_SEPOLIA_USDC, decimals: 6 }), recentInbound: async () => [tiny] },
    ledger: s.ledger, addresses: { cardFor: async (a) => (a.toLowerCase() === ADDR ? "card1" : undefined) }, onDust: (x) => dust.push(x.dustBase),
  });
  assert.deepEqual(await d.reconcile(), { checked: 1, credited: 0, ignored: [] });
  assert.deepEqual(await d.reconcile(), { checked: 1, credited: 0, ignored: [] });
  assert.equal(((await d.handle(s.body, hdr(s.body))) as { reason: string }).reason, "under one cent"); // webhook path too
  assert.deepEqual(dust, [4000n]);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 0);
});

test("a token called USDC at the wrong contract is not credited", async () => {
  const s = setup();
  const bad = new CircleDeposits({
    circle: { ownsWallet: async () => true, notificationKey: async () => ({ algorithm: "", publicKey: pub }), transaction: async () => ({ id: "t1", blockchain: "BASE-SEPOLIA", tokenId: "tok", destinationAddress: ADDR, walletId: "w1", transactionType: "INBOUND", state: "COMPLETE", amounts: ["5"], txHash: "0xDDD" }), token: async () => ({ symbol: "USDC", blockchain: "BASE-SEPOLIA", tokenAddress: "0x" + "11".repeat(20), decimals: 6 }) },
    ledger: s.ledger, addresses: { cardFor: async () => "card1" },
  });
  assert.match(((await bad.handle(s.body, hdr(s.body))) as { reason: string }).reason, /pinned USDC/);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 0);
});

test("a key id that is not a UUID, or that Circle does not know, is a 401 without a lookup storm", async () => {
  const s = setup();
  await assert.rejects(s.d.handle(s.body, { signature: signBody(s.body), keyId: "../x" }), /bad key id/);
  const unknown = new CircleDeposits({
    circle: { ownsWallet: async () => true, notificationKey: async () => { throw new CircleError("Circle GET -> 404", 404); }, transaction: async () => ({ id: "t" }), token: async () => ({}) },
    ledger: s.ledger, addresses: { cardFor: async () => undefined },
  });
  await assert.rejects(unknown.handle(s.body, { signature: signBody(s.body), keyId: "0b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c0d" }), (e: unknown) => e instanceof CircleError && e.status === 401);
  // Circle refusing our own API key is our fault: not disguised as "unknown key id".
  const refused = new CircleDeposits({
    circle: { ownsWallet: async () => true, notificationKey: async () => { throw new CircleError("Circle GET -> 403", 403); }, transaction: async () => ({ id: "t" }), token: async () => ({}) },
    ledger: s.ledger, addresses: { cardFor: async () => undefined },
  });
  await assert.rejects(refused.handle(s.body, { signature: signBody(s.body), keyId: "0b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c0d" }), (e: unknown) => e instanceof CircleError && e.status === 403);
});

test("circleNetwork pairs key type and network and needs CIRCLE_LIVE=1 for mainnet", () => {
  const T = "TEST_API_KEY:a:b", L = "LIVEKEY:a:b";
  assert.equal(circleNetwork({ CIRCLE_API_KEY: T }), "BASE-SEPOLIA");
  assert.throws(() => circleNetwork({ CIRCLE_API_KEY: L }), /not a TEST_API_KEY/);
  assert.throws(() => circleNetwork({ CIRCLE_API_KEY: T, CIRCLE_NETWORK: "BASE", CIRCLE_LIVE: "1" }), /live Circle API key/);
  assert.throws(() => circleNetwork({ CIRCLE_API_KEY: L, CIRCLE_NETWORK: "BASE" }), /CIRCLE_LIVE=1/);
  assert.throws(() => circleNetwork({ CIRCLE_API_KEY: L, CIRCLE_NETWORK: "ETH" }), /must be/);
  assert.equal(circleNetwork({ CIRCLE_API_KEY: L, CIRCLE_NETWORK: "BASE", CIRCLE_LIVE: "1" }), "BASE");
});

test("amount parsing is strict", () => {
  assert.equal(usdcToBaseUnits("1"), 1_000_000n);
  assert.equal(usdcToBaseUnits("0.01"), 10_000n);
  for (const bad of ["-1", "1e6", "1.1234567", "", "abc", "1,5"]) assert.equal(usdcToBaseUnits(bad), null);
});

test("wallet creation sends a decryptable entity secret and a stable idempotency key", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const secret = "ab".repeat(32);
  const calls: { url: string; body?: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    const data = url.endsWith("/publicKey") ? { publicKey: rsa.publicKey.export({ type: "spki", format: "pem" }) } : { wallets: [{ id: "w1", address: ADDR.toUpperCase().replace("0X", "0x") }] };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  const c = new CircleClient({ apiKey: "TEST_API_KEY:a:b", entitySecretHex: secret, walletSetId: "ws", fetch: f });
  assert.deepEqual(await c.createDepositWallet(7), { id: "w1", address: ADDR });
  await c.createDepositWallet(7);
  const posts = calls.filter((x) => x.body);
  assert.equal(posts[0]!.body.idempotencyKey, posts[1]!.body.idempotencyKey);
  assert.equal(posts[0]!.body.idempotencyKey, uuidFrom("agent-cards-deposit-wallet:ws:7"));
  assert.notEqual(posts[0]!.body.entitySecretCiphertext, posts[1]!.body.entitySecretCiphertext); // fresh per request
  const plain = privateDecrypt({ key: rsa.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(posts[0]!.body.entitySecretCiphertext, "base64"));
  assert.equal(plain.toString("hex"), secret);
  assert.deepEqual(posts[0]!.body.blockchains, ["BASE-SEPOLIA"]);
});

test("only failed key lookups use the budget, so unknown ids cannot starve a good key", async () => {
  const good = "0b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c0d";
  const f = (async (url: string) => (String(url).endsWith(good)
    ? new Response(JSON.stringify({ data: { algorithm: "x", publicKey: "k" } }), { status: 200 })
    : new Response(JSON.stringify({ message: "nope" }), { status: 404 }))) as typeof fetch;
  const c = new CircleClient({ apiKey: "TEST_API_KEY:a:b", entitySecretHex: "ab".repeat(32), walletSetId: "ws", fetch: f });
  for (let i = 0; i < 20; i++) await assert.rejects(c.notificationKey(`1b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c${String(i).padStart(2, "0")}`), /404/);
  await assert.rejects(c.notificationKey("2b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c0d"), (e: unknown) => e instanceof CircleError && e.status === 429);
  // Successful lookups are cached and never counted, so a good key is unaffected by the failures above.
  const fresh = new CircleClient({ apiKey: "TEST_API_KEY:a:b", entitySecretHex: "ab".repeat(32), walletSetId: "ws", fetch: f });
  for (let i = 0; i < 5; i++) await fresh.notificationKey(good); // successes never count
  assert.equal((await fresh.notificationKey(good)).publicKey, "k");
});

test("recentInbound follows pageAfter and stops when a page adds nothing", async () => {
  const mk = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: `t${from + i}` }));
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(String(url));
    const after = new URL(String(url)).searchParams.get("pageAfter");
    const txs = after === null ? mk(50, 0) : after === "t49" ? mk(10, 50) : [];
    return new Response(JSON.stringify({ data: { transactions: txs } }), { status: 200 });
  }) as typeof fetch;
  const c = new CircleClient({ apiKey: "TEST_API_KEY:a:b", entitySecretHex: "ab".repeat(32), walletSetId: "ws", fetch: f });
  assert.equal((await c.recentInbound(new Date())).length, 60);
  assert.equal(urls.length, 2);
});

// ----- Lin's deposit review (todos tmwg7ufns9, tmwg7ufnsa) -----

const ADDR2 = "0x" + "ef".repeat(20);
const OURS = new Map([[ADDR, "card1"], [ADDR2, "card2"]]);
const usdc = async () => ({ symbol: "USDC", blockchain: "BASE-SEPOLIA", tokenAddress: BASE_SEPOLIA_USDC, decimals: 6 });
const inbound = (o: Partial<CircleTx>): CircleTx => ({ id: "c0", blockchain: "BASE-SEPOLIA", tokenId: "tok", walletId: "w-" + (o.destinationAddress ?? ADDR).slice(2, 6), destinationAddress: ADDR, transactionType: "INBOUND", state: "COMPLETE", amounts: ["5"], txHash: "0xBATCH", ...o });
function circleWith(txs: CircleTx[], opts: { owns?: (walletId: string, address: string) => boolean; isOwnAddress?: (a: string) => Promise<boolean>; log?: (m: string) => void } = {}) {
  const ledger = new Ledger();
  const d = new CircleDeposits({
    circle: {
      notificationKey: async () => ({ algorithm: "", publicKey: pub }), transaction: async (id: string) => txs.find((t) => t.id === id)!, token: usdc,
      recentInbound: async () => txs,
      // Our wallets are w-<first 4 hex of the address>, all in our set.
      ownsWallet: async (w: string, a: string) => (opts.owns ?? ((w2, a2) => w2 === "w-" + a2.slice(2, 6)))(w, a.toLowerCase()),
    },
    ledger, addresses: { cardFor: async (a) => OURS.get(a.toLowerCase()) },
    ...(opts.isOwnAddress ? { isOwnAddress: opts.isOwnAddress } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  return { ledger, d };
}

test("one batched tx paying two of our wallets credits both, and reconcile does not stall on it (tmwg7ufns9)", async () => {
  const a = inbound({ id: "c1", destinationAddress: ADDR, amounts: ["5"] });
  const b = inbound({ id: "c2", destinationAddress: ADDR2, amounts: ["7"] }); // same txHash, different log
  const { ledger, d } = circleWith([a, b]);
  assert.deepEqual(await d.reconcile(), { checked: 2, credited: 2, ignored: [] });
  assert.deepEqual(await d.reconcile(), { checked: 2, credited: 0, ignored: [] }); // and again: no throw, no re-credit
  assert.equal(await ledger.balance(accounts.holding("card1")), 500);
  assert.equal(await ledger.balance(accounts.holding("card2")), 700);
});

test("a deposit credited under the old <txHash>:0 key is not credited again under the Circle-id key", async () => {
  const a = inbound({ id: "c1", destinationAddress: ADDR, amounts: ["5"] });
  const logs: string[] = [];
  const { ledger, d } = circleWith([a], { log: (m) => logs.push(m) });
  await ledger.confirmDeposit({ chain: "circle-base-sepolia", asset: "USDC", cardId: "card1", amountCents: 500, txHash: "0xBATCH", logIndex: 0 });
  assert.deepEqual(await d.reconcile(), { checked: 1, credited: 0, ignored: [] });
  assert.equal(await ledger.balance(accounts.holding("card1")), 500);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /old key: txHash 0xBATCH, card card1, 500 cents/);
});

test("an inbound transfer whose walletId is not one of our wallets is not credited (tmwg7ufnsa)", async () => {
  for (const tx of [inbound({ id: "c3", walletId: "someone-elses-wallet" }), inbound({ id: "c4", walletId: undefined })]) {
    const { ledger, d } = circleWith([tx]);
    const r = await d.reconcile();
    assert.equal(r.credited, 0, `walletId ${tx.walletId}`);
    assert.equal(await ledger.balance(accounts.holding("card1")), 0);
  }
});

test("an inbound transfer from one of our own addresses is not a deposit (tmwg7ufnsa)", async () => {
  const PAYOUT = "0x" + "99".repeat(20);
  const fromUs = inbound({ id: "c5", sourceAddress: PAYOUT.toUpperCase().replace("0X", "0x") });
  const { ledger, d } = circleWith([fromUs], { isOwnAddress: async (a) => a === PAYOUT || OURS.has(a) });
  const r = await d.reconcile();
  assert.equal(r.credited, 0);
  assert.equal(await ledger.balance(accounts.holding("card1")), 0);
  // A stranger's transfer still credits.
  const { ledger: l2, d: d2 } = circleWith([inbound({ id: "c6", sourceAddress: "0x" + "12".repeat(20) })], { isOwnAddress: async (a) => a === PAYOUT || OURS.has(a) });
  assert.equal((await d2.reconcile()).credited, 1);
  assert.equal(await l2.balance(accounts.holding("card1")), 500);
});

test("ownsWallet: only a wallet of our wallet set at that address; unknown ids are not ours, outages throw", async () => {
  const wallets: Record<string, object> = { w1: { walletSetId: "ws", address: ADDR.toUpperCase().replace("0X", "0x") }, w2: { walletSetId: "other", address: ADDR } };
  let calls = 0;
  let down = false;
  const f = (async (url: string) => {
    calls++;
    if (down) return new Response("{}", { status: 503 });
    const id = String(url).split("/").pop()!;
    return wallets[id] ? Response.json({ data: { wallet: wallets[id] } }) : new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as typeof fetch;
  const c = new CircleClient({ apiKey: "TEST_API_KEY:a:b", entitySecretHex: "ab".repeat(32), walletSetId: "ws", fetch: f });
  assert.equal(await c.ownsWallet("w1", ADDR), true);
  assert.equal(await c.ownsWallet("w1", ADDR2), false); // ours, but not that address
  assert.equal(await c.ownsWallet("w2", ADDR), false); // another wallet set
  assert.equal(await c.ownsWallet("w9", ADDR), false); // Circle does not know it
  const before = calls;
  assert.equal(await c.ownsWallet("w1", ADDR), true); // cached
  assert.equal(calls, before);
  down = true;
  await assert.rejects(c.ownsWallet("w3", ADDR), /503/);
});
