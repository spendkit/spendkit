import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapApplication } from "../src/bootstrap.js";
import { MidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { WalletBalanceMonitor } from "../src/adapters/funding/WalletBalanceMonitor.js";
import { Alerter } from "../src/lib/services/Alerter.js";

// Every guard case below must throw before bootstrap opens a database connection.
const prod = {
  APP_ENV: "production", CARD_PROVIDER: "miden", MIDEN_CLIENT_ID: "id", MIDEN_CLIENT_SECRET: "s", MIDEN_UNIQUE_KEY: "u",
  MIDEN_BASE_URL: "https://api.miden.example/miden", MIDEN_TOKEN_URL: "https://id.miden.example/connect/token",
};
const rejects = (env: Record<string, string>, re: RegExp) => assert.rejects(bootstrapApplication(env as NodeJS.ProcessEnv), re);

test("production refuses simulated deposits, even when asked", () => rejects({ ...prod, ALLOW_SIMULATED_DEPOSITS: "1" }, /ALLOW_SIMULATED_DEPOSITS=1 is not allowed/));
test("production refuses the Stripe test-card swap", () => rejects({ ...prod, SWAP_STRIPE_TEST_CARD: "1" }, /SWAP_STRIPE_TEST_CARD=1 is not allowed/));
test("production refuses a sandbox Miden host", () => rejects({ ...prod, MIDEN_BASE_URL: "https://sandbox-api.midencards.io/miden" }, /sandbox host/));
test("production has no sandbox URL defaults", () => rejects({ ...prod, MIDEN_TOKEN_URL: "" }, /needs MIDEN_TOKEN_URL/));
test("production refuses http", () => rejects({ ...prod, MIDEN_BASE_URL: "http://api.miden.example/miden" }, /must be https/));
test("production refuses the mock provider", () => rejects({ ...prod, CARD_PROVIDER: "mock" }, /needs CARD_PROVIDER=miden/));
test("without APP_ENV=production a non-sandbox Miden host is refused", () =>
  rejects({ ...prod, APP_ENV: "sandbox", MIDEN_BASE_URL: "https://api.miden.example/miden" }, /sandbox-only unless APP_ENV=production/));
test("unknown APP_ENV is refused", () => rejects({ ...prod, APP_ENV: "prod" }, /APP_ENV must be/));

function monitor(balances: () => Response, minUsd = 100) {
  const logs: string[] = [];
  const hooks: string[] = [];
  let t = 0;
  const f = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/connect/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
    return balances();
  }) as typeof fetch;
  const miden = new MidenClient({ baseUrl: "https://api.test/miden", tokenUrl: "https://id.test/connect/token", clientId: "i", clientSecret: "s", uniqueKey: "u", fetch: f });
  const hookFetch = (async (_u: string, init: RequestInit) => { hooks.push(JSON.parse(init.body as string).text); return new Response("ok"); }) as unknown as typeof fetch;
  const clock = { advance: (ms: number) => { t += ms; } };
  const now = () => (t += 61_000); // every check is past the 60 s read throttle
  const alerts = new Alerter({ log: (s) => logs.push(s), webhookUrl: "https://hook.test/x", fetch: hookFetch, now: () => t });
  const m = new WalletBalanceMonitor({ miden, minUsd, alerts, now });
  return { m, logs, hooks, clock };
}
const bal = (usd: number) => () => Response.json({ isSuccessful: true, responseCode: "000", data: [{ walletCurrency: "USD", walletAvailableBalance: usd }] });

test("monitor alerts on low, stays quiet within the hour, says when recovered", async () => {
  let cur = bal(50);
  const { m, logs, hooks } = monitor(() => cur());
  await m.check(); await m.check();
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^ALERT LOW BALANCE.*\$50\.00.*\$100\.00/);
  assert.equal(hooks.length, 1);
  cur = bal(500);
  await m.check();
  assert.match(logs[1]!, /^RECOVERED .*ok again.*\$500\.00/);
  assert.equal(hooks.length, 2);
});

test("monitor keeps reminding, at most hourly, while the wallet stays low", async () => {
  const { m, logs, clock } = monitor(bal(20));
  await m.check();
  for (let i = 0; i < 5; i++) await m.check(); // about 5 minutes later: still one alert
  assert.equal(logs.filter((l) => /LOW BALANCE/.test(l)).length, 1);
  clock.advance(3_600_000);
  await m.check();
  assert.equal(logs.filter((l) => /LOW BALANCE/.test(l)).length, 2);
  assert.match(logs.at(-1)!, /\$20\.00/);
});

test("an unreadable balance does not count as recovered", async () => {
  let cur = bal(20);
  const { m, logs } = monitor(() => cur());
  await m.check();
  cur = () => new Response("nope", { status: 500 });
  await m.check();
  assert.ok(!logs.some((l) => /^RECOVERED .*ok again/.test(l)));
  assert.match(logs.at(-1)!, /could not be read/);
  cur = bal(20);
  await m.check();
  assert.match(logs.at(-1)!, /^RECOVERED .*can be read again/);
});

test("monitor is silent when healthy at boot", async () => {
  const { m, logs } = monitor(bal(500));
  await m.check();
  assert.deepEqual(logs, []);
});

test("monitor alerts when the balance cannot be read", async () => {
  const { m, logs } = monitor(() => new Response("nope", { status: 500 }));
  await m.check();
  assert.match(logs[0]!, /could not be read/);
});
