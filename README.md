# Spendkit

Virtual cards for AI agents, funded with stablecoins. You fund a wallet with USDC, give each agent a budget and limits, and the agent pays merchants with a card it never sees.

**Spendkit is a hosted service.** Real cards come only from the hosted service, which holds the card-issuing contract with Miden and carries the PCI obligations. This repository is the code behind it, published so you can check how your money and your agents' limits are handled, and run the whole thing locally in test mode.

## Use Spendkit hosted

> **TODO (hosting not live yet):** `https://api.spendkit.ai` and the package name `@spendkit/checkout` are placeholders until the hosted service and the npm package are published.

1. **Sign up** at https://api.spendkit.ai (TODO) and complete the short card KYC. Your account gets one card.
2. **Get an API key.** The dashboard shows your keys once: `ak_...` for an agent, `mk_...` if you also take payments as a merchant.
3. **Fund with USDC.** Send USDC on Base to the deposit address on your dashboard. It is credited to your balance, then moved onto your card.
4. **Create an agent with limits:** a budget, a per-payment limit, a daily limit and, if you want, allowed merchant categories. Its `ak_` token is shown once.
5. **Let the agent pay.** Install the SDK, or add our MCP server to your agent.

```sh
npm install @spendkit/checkout   # TODO: package not published yet
```

```ts
import { SpendkitAgent } from "@spendkit/checkout";

const agent = new SpendkitAgent({ baseUrl: "https://api.spendkit.ai", token: process.env.SPENDKIT_AGENT_TOKEN! });
await agent.payCheckout(checkoutUrl, { maxAmountCents: 500 }); // refused without charging if the price is higher
```

Or over MCP (the agent gets `get_wallet`, `pay`, `get_checkout`, `pay_checkout` and `list_transactions`):

```sh
claude mcp add --transport http spendkit https://api.spendkit.ai/mcp --header "Authorization: Bearer ak_..."   # TODO: URL
```

The agent's limits and balance are checked on every payment, and paying the same checkout twice never charges twice. Full walkthrough with a merchant side: [docs/getting-started.md](docs/getting-started.md).

## The code is open: check our work, run it locally

Everything that decides whether an agent may spend (the ledger, spend policy, idempotency, deposits, checkout) is in this repo. You can read it, and you can run the whole service on your laptop in **test mode**: a built-in mock card provider, no accounts, no real money. Running this repo does not get you real cards: out of the box it uses the mock provider, or Miden's sandbox if you give it sandbox credentials, and without `APP_ENV=production` it refuses any non-sandbox issuer host (`src/bootstrap.ts`). Real issuing needs an issuer contract and production credentials that are not part of the repo (see [self-hosting](#self-hosting-with-your-own-issuer)).

You need Node 20+, pnpm, and either Docker or a Postgres 16 you can reach.

```
pnpm install
pnpm dev:up              # Postgres (Docker, Homebrew, or your DATABASE_URL) + the service on http://127.0.0.1:8787
pnpm dev:keys            # test keys written to .env.sandbox-keys, then a paid $1.00 test checkout
open http://127.0.0.1:8787   # owner dashboard
pnpm dev:down            # stop the service
```

Connect an agent to your local service (the dashboard shows these with the token filled in):

```
claude mcp add --transport http agent-cards http://127.0.0.1:8787/mcp --header "Authorization: Bearer ak_..."   # MCP over HTTP
AGENT_CARDS_URL=http://127.0.0.1:8787 AGENT_CARDS_TOKEN=ak_... node --import tsx src/startMcpStdio.ts          # MCP over stdio
curl -s http://127.0.0.1:8787/agent/v1/pay -H "Authorization: Bearer ak_..." -H "content-type: application/json" \
  -d '{"amountCents":500,"merchant":"Example API","mcc":"5734","idempotencyKey":"order-1"}'                    # REST
```

| Mode | Needs | Good for |
| --- | --- | --- |
| Mock (default) | Node, pnpm, Postgres | Trying the API, SDK, MCP and dashboard; building and testing your integration |
| Issuer sandbox | Miden sandbox credentials and an allow-listed IP | Seeing real issuer behaviour with test money (no real cards) |
| Circle deposits | Circle API keys ([docs/circle-deposits.md](docs/circle-deposits.md)) | Crediting real testnet USDC deposits |

For the Miden sandbox, export `MIDEN_CLIENT_ID`, `MIDEN_CLIENT_SECRET` and `MIDEN_UNIQUE_KEY` before `pnpm dev:up`; `node --import tsx scripts/sandbox-demo.ts` then runs an end-to-end check with sandbox money. Test USDC: faucet.circle.com, Base Sepolia.

More starting points:

- **Building a product where your users get cards for their agents?** [docs/developers.md](docs/developers.md) and the [developer demos](examples/developer/README.md).
- **Working on Spendkit itself?** Start with the [architecture](docs/architecture.md), then [docs/](docs/README.md).

## How it fits together

[![Spendkit architecture](docs/architecture.png)](docs/architecture.svg)

1. A user signs up and passes card KYC. The card provider issues one card.
2. USDC sent to the user's Base deposit address is credited to our ledger, then moved onto the card.
3. The owner gives agents budgets and limits. Agents pay over MCP or REST.
4. Merchants take agent payments through checkouts and are paid out in USDC.

Full structure, flows and design decisions: [docs/architecture.md](docs/architecture.md). Details: [sandbox-flow.md](docs/sandbox-flow.md), [deposit-watcher.md](docs/deposit-watcher.md), [checkout-payouts.md](docs/checkout-payouts.md).

## Self-hosting with your own issuer

Possible, but it is real work and few teams will want it. Spendkit hosted issues cards under our issuer contract and PCI scope; a self-hosted build has neither. To issue real cards yourself you would need:

- **Your own card-issuing contract** (with Miden or another issuer) and the KYC obligations that come with it.
- **Your own PCI DSS compliance.** The service handles full card numbers (the card vault and the checkout filler), so your deployment is in PCI scope.
- **Your own production credentials and operations.** `APP_ENV=production` lets the service talk to a production Miden host, but you bring the credentials, a provider if your issuer is not Miden ([card providers](docs/card-providers.md)), and the work in [production gaps](docs/production-gaps.md): key custody, the authorization model, webhooks, a paid RPC.

If you are weighing this, open an issue first: we would rather help than have you find the gaps in production.

## Library use

```ts
import { CardService, MidenClient, MidenWalletFunding, configFromEnv, evaluate } from "./src/index.js";

const miden = new MidenClient(configFromEnv());
const cards = new CardService(miden, new MidenWalletFunding(miden));

const card = await cards.issue("agent-42", { perTransactionCents: 5_000, dailyCents: 20_000, allowedMccs: ["5734"] });
await cards.topUp(card, 10_000, "USDC", "topup-agent-42-0001"); // idempotency key: a retry never double-funds
evaluate(card.policy, { amountCents: 2_500, mcc: "5734", spentTodayCents: 0 }); // { ok: true } or { ok: false, reason }
```

Amounts are USD cents throughout.

## Configuration

Every variable, with defaults and which mode needs it: [docs/configuration.md](docs/configuration.md). Copy [`.env.example`](.env.example) to start. The Miden variables below are only for `CARD_PROVIDER=miden`.

`configFromEnv()` throws if a required variable is missing. Nothing loads `.env` automatically: export them or use `node --env-file=.env`.

| Variable | Meaning |
| --- | --- |
| `MIDEN_BASE_URL` | API base URL (required) |
| `MIDEN_TOKEN_URL` | OAuth client-credentials token endpoint (required) |
| `MIDEN_CLIENT_ID`, `MIDEN_CLIENT_SECRET` | Credentials; the secret is also used in every signature (required) |
| `MIDEN_UNIQUE_KEY` | Sent as the `UniqueKey` header (required) |
| `MIDEN_WEBHOOK_HASH` | HMAC key for `x-signature`; only for `scripts/webhook-*.ts` |

Request signing is documented in [docs/miden-api.md](docs/miden-api.md). Smoke check: `node --env-file=.env --import tsx scripts/sandbox-smoke.ts` (read-only; a 401/403 with correct keys usually means this machine's IP is not whitelisted in the Miden dashboard).

## Layout

The code is layered: `routes/ -> controllers/ -> lib/interactors/ -> lib/services/ / adapters/ -> db/repositories/, lib/clients/`. Details in [docs/architecture.md](docs/architecture.md#51-source-layout).

| Path | What it is |
| --- | --- |
| `src/main.ts`, `src/bootstrap.ts`, `src/createApp.ts` | Entry point; env -> clients, repositories, adapters (`AppParams`); `AppParams` -> interactors |
| `src/routes/`, `src/controllers/`, `src/lib/middleware/` | HTTP: route tables, thin controllers, guards and auth |
| `src/lib/interactors/` | Use cases: cardholders (signup, KYC, agents, pay), checkouts, payouts, hosted-checkout swaps, developers |
| `src/lib/services/` | `Ledger`, `AgentWallets`, `SpendPolicy` and `evaluate()`, tiers |
| `src/lib/clients/` | `MidenClient` (token and signed requests), `CircleClient` |
| `src/adapters/` | `CardService` (`issue`, `topUp`), `MidenWalletFunding`, deposit watchers and Circle webhooks, payout rail, checkout fillers, card vault |
| `src/db/` | Repositories (ledger store, chain cursor, deposit addresses) and SQL migrations |
| `src/errors.ts` | `AgentCardsError` and its factories |
| `sdk/checkout/` | `@agent-cards/checkout`, the merchant and agent SDK |
| `test/` | `node:test` tests |

## Dev

Node 20+ and pnpm. `docker compose up -d` starts a local Postgres (see `docker-compose.yml`); the Postgres test suites skip without `DATABASE_URL`.

```
pnpm install
pnpm test        # tsx --test test/*.test.ts
pnpm typecheck
pnpm build
```

## More

| Doc | Covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | **Architecture:** components, ledger, key flows, data model, security, failure handling |
| [docs/README.md](docs/README.md) | Index of all docs |
| [docs/ops.md](docs/ops.md) | Runbooks: checkout or payout held for review |
| [docs/checkout-payouts.md](docs/checkout-payouts.md) | Checkout, settlement, payouts, what blocks mainnet |
| [docs/production-gaps.md](docs/production-gaps.md) | Not production-ready items and the open-items list |

## Contributing, security and licence

- [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities privately: [SECURITY.md](SECURITY.md).
- Licensed under the [Apache License 2.0](LICENSE).
