# Spend intents and real-time authorization

Status: design, 2026-11-20 (Obi). Nothing here is built yet.

## Why

Today our per-agent limits only bind payments that go through `CardholderInteractor.pay`. With real merchants, the money moves when the merchant sends an authorization to the card network. That authorization reaches Miden, not us. Anyone holding the card details can spend past the agent's limits and sub-balance. This is the top production gap in [production-gaps.md](production-gaps.md), item 3.

The fix is Miden's **customer-managed authorization**. Miden POSTs every authorization to our URL, and we approve or decline it. We only approve an authorization that matches an open **spend intent** that one of our agents created first. **Default is decline.**

## Miden callback contract (from docs.miden.co, not yet seen live)

Source: `https://docs.miden.co/cards/customer-managed-authorizations/authorization/authorization-callback.md`.

- **Request:** `POST` JSON to the URL set in Miden Portal → Settings → Developer → Card Transaction Authorizations.
- **Signed:** HMAC, the same scheme as webhooks (`webhookSignature.ts`). The signature does not cover the body.
- **Deadline:** respond within **400 ms**. Otherwise Miden applies our configured *Default Authorization Decision*. That default must be **decline**.
- **Response:** HTTP 200 with `{ responseCode, responseReasonCode, responseMessage }`.
  - `000/APPROVE` approves. Any supported non-000 code declines.
  - Codes we use: `116 INSUFF_FUNDS`, `119 TXN_NOT_PERMIT`, `125 BLK_MRCH`, `127 RESTRICT_MCC`, `129 LIMIT_EXCEED`, `130 VELOCITY_EXCEED`, `131 INVALID_REQ` (unknown requestType), `137 SEC_ERROR` (stale or future eventTime), `143 CRD_CLOSED`, `911 ERROR`. Every code here appears in Miden's "Supported Authorization Decision Codes" table (checked 2026-11-20). Return the code, reason and message exactly as that table lists them, and never invent one.
- **Fields we use:**
  - Identity and money: `requestType` (`Authorization`, `Settlement`, others unknown), `cardId`, `transactionAmount` (always USD), `authorizationAmount` + `transactionCurrencyCode`, `charge` + `chargeType`.
  - Merchant: `merchantCategoryCode`, `merchantName`, `merchantCountry`, `merchantAcceptorId`.
  - References: `reference`, `eventId`, `eventTime`, `switchReference`, `cardTransactionAuthorizationId`, `precedingRelatedToken`, `riskAssessment`.
- **`accountNumber` is the card number.** The endpoint is in PCI scope unless a vault proxy redacts that field first. The vendor is the boss's pick; see `spendkit-hosted/docs/pci/vault-vendor-evaluation.md`. Until then:
  - The field is removed **before** any request logger, error reporter or body-parser hook sees the body. Use a dedicated raw-body route that parses, strips the field, and only then hands the body to the app.
  - The raw body is never logged or stored.
  - The PAN-redacting log formatter (todo tmwj9kvguh) sits in front of the route as a second guard.
  - Cheaper alternative: ask Miden to send a masked `accountNumber` (PCI plan, Q3).
- **Amounts are decimals in dollars** (`3.75`), not cents. Convert the decimal *string* to integer cents with an exact parser, and never multiply floats. The currency of `charge` is not documented; until Miden confirms, assume USD and alert when `charge > 0` on a non-USD transaction.
- **Effect on funding:** under customer-managed authorization, Miden's top-up and balance endpoints do not apply, and **our ledger is the balance**. How Miden settles approved spend with us is UNCONFIRMED (ask Miden). It probably comes from our Miden USD wallet, which replaces per-card top-ups.

## The intent

An intent is an `app_spend` row that has not been authorized yet. We extend `app_spend` rather than adding a table, because checkouts, swaps and reconcile already key on `spend_id`.

New columns (migration 014):

| Column | Meaning |
| --- | --- |
| `expires_at` | After this time, no authorization can match. Default 30 min, maximum 7 days. |
| `max_amount_cents` | Upper bound an authorization may reach: `amount_cents` plus the tolerance for tips and FX (a policy setting, default 0). **The hold and the approval check both use this value.** |
| `merchant_match` | Normalised merchant name and/or acceptor ID the authorization must match. **Required** on the shared reusable card. The MCC allowlist alone is not enough to bind a payment to one agent. |
| `uses_allowed` / `uses` | 1 in v1. Recurring intents come later. |
| `approval` | `none`, `pending` or `approved`. Used by the human-approval work. |
| `auth_ref` | Miden `cardTransactionAuthorizationId` that consumed the intent. |
| `auth_state` | `provisional` (approved by the callback) or `settled` (a settlement arrived). |
| `context` | Agent text shown to the owner. At most 500 characters, plain text only. |

New statuses: `processing` keeps meaning "held, waiting for the authorization", and `expired` is added.

New table `miden_event` (shared by the webhook route and the callback route): `event_id` is the primary key, with `source`, `received_at` and `decision`. It is **inserted first** in the transaction, under its unique constraint.

## Money

- **Creating the intent holds `max_amount_cents`.** It debits `agent:<id>` into `hold:<card>`, so neither a concurrent intent nor an approval inside the tolerance can overspend the sub-balance. Any unused tolerance returns at settlement.
- **An authorization that matches is approved provisionally.** The authorized amount moves from `hold:<card>` to `external:merchant`, the rest of the hold stays until settlement, `auth_ref` is recorded, and `auth_state` becomes `provisional`.
- **On expiry with no authorization,** `releaseIntent(spendId, 'expired')` reverses the hold. The sweeper only acts **after `expires_at + 2 min`**, because a payment authorized just before expiry can reach us just after.
- **Settlement:**
  - Settlement for the same amount: `auth_state` becomes `settled`, and any held remainder returns to `agent:<id>`.
  - Settlement for a different amount (tip, FX, partial): adjust between `agent:<id>` and `external:merchant` within the hold, then alert if the difference exceeds the tolerance.
  - A settlement with no prior authorization (force post): post it **at the owner level** (the card belongs to the owner, not an agent) with `needs_review`, and alert.
- **A reversal or refund** returns the money to `agent:<id>`.
- **Provisional-approval sweeper.** An approval with no settlement after N days (default 7) is checked against Miden's `GET /api/v1/cards/transactions`. If Miden has no approved authorization for it, the approval is undone, which covers an answer that reached Miden too late. If it has one, we wait longer.

## The decision (internal budget 250 ms; Miden's deadline is 400 ms)

The extra 150 ms covers the vault-proxy hop and the network. Postgres `statement_timeout` and `lock_timeout` are set for this route so that the whole decision fits in 250 ms.

1. Verify the signature. If it fails, return HTTP 401, and Miden applies its default, which must be decline.
2. **Freshness:** reject an `eventTime` more than 2 minutes old or in the future (decline `137`). The signature covers only `eventId&eventTime`, not the body (PCI plan, Q4), so a signature replayed from a seen webhook carrying a forged body must not count as new.
3. Unknown `requestType`: decline `131`, move no money, alert.
4. Begin a transaction. **Insert into `miden_event`.** If the event is a duplicate, roll back and return the stored decision. If it is a duplicate across sources (an id first seen on the webhook route), decline and alert. Miden's retry behaviour is undocumented, so we don't assume a retry keeps the same `eventId`. A retry with a new id matches nothing, because the first answer already used the intent.
5. Look up the card. If it is unknown or closed, decline `143`.
6. Find the open intents on this card, `FOR UPDATE SKIP LOCKED`: `processing`, `expires_at > now()`, `uses < uses_allowed`, `approval` not `pending`.
7. Keep only the intents where `transactionAmount + charge <= max_amount_cents`, the MCC is allowed, and the merchant matches.
8. With no match, decline `119 TXN_NOT_PERMIT` and record it. This is the bypass case: someone used the card outside our flow. Alert the owner, **rate-limited** so card testing cannot flood them: one alert per card per 10 minutes plus a count.
9. If the candidates belong to **more than one agent**, decline `119` and alert. We never guess which agent pays.
10. If they belong to one agent, take the oldest intent whose amount is closest, consume it, move the money, and set `auth_state = provisional`.
11. **Commit, then answer.** If the 250 ms timer fires before the commit, roll back and decline `911`. We never answer before the commit, and never commit after a decline. If the database is slow or unavailable, decline `911`. Never approve when unsure.

## Cards

Miden caps a customer at **3 cards, one-time cards included** (architecture.md, limit 9). So "one card per intent" is not possible. We keep one reusable card per owner, plus one-time cards for hosted checkout as today. The card is shared by all of an owner's agents, so the per-agent binding comes from the **required merchant match** plus the rule in step 9, not from the card. Ask Miden whether the cap can be raised.

## Who builds what

| Item | Owner | Depends on |
| --- | --- | --- |
| Migration 014, intent create/expire, holds, the callback route, settlement and reversal | Obi | none |
| Human approval of intents above a per-agent threshold (passkey / WebAuthn, owner dashboard) | Mira (backend) + Amara (UI) | `approval` column, intent API |
| Per-agent scoped sub-keys; developer API key can only create intents within owner limits | Val | none |
| x402 (HTTP 402 + USDC on Base) on our merchant checkout | Val, after sub-keys | none |
| Replace Basis Theory (Evervault if a one-week sandbox test passes, else VGS; see the evaluation): Miden response redaction, cardholder reveal, browser-proxy checkout | Lin evaluated; build after the pick | boss picks a vendor |

## Open questions for Miden

1. How does settlement work under customer-managed authorization? Which wallet pays, and what happens to the existing card balances?
2. Every `requestType` value, and whether reversals and refunds come through the callback or only as webhooks.
3. Can the 3-card-per-customer cap be raised?
4. Can our BINs be enrolled for Visa Intelligent Commerce / network tokens (VTS)?
5. Can the default decision be set to decline, and what is the real latency budget in production?

## Interface agreed with Mira (approval), 2026-11-20

`SpendIntents` (`src/lib/services/SpendIntents.ts`, wired as `app.intents`):

- `createIntent(input)`. Sets `approval='pending'` when `approvalRequired(agent, maxAmountCents)` is true. That helper belongs to Mira and compares against **max_amount_cents**, not `amount_cents`, so the tolerance cannot get around approval. A pending intent returns `{ status: 'pending_approval', spendId, expiresAt, approvalUrl }`, where `approvalUrl` comes from `app.approvals.approvalUrl(spendId)`.
- `getIntent(cardId, agentId, spendId)`. The result includes `approval`, so an agent can poll it.
- `releaseIntent(spendId, 'owner_denied' | 'expired')`. Runs in one transaction with `FOR UPDATE`. It acts only when `status='processing'` and `auth_ref IS NULL`, reverses the hold, and sets the status to `declined` (reason `owner_denied`) or `expired`. It is idempotent and returns `{ released, status }`. The expiry sweeper uses the same function.
- `context` is capped at 500 characters, control characters are stripped, and an empty value is rejected. It is shown as plain text only.
- v1 intents are single-use only (`uses_allowed = 1`).
- Migrations: 014 is spend intents (Obi), 015 is Val's work, and 016 is Mira's approval work (`app_agent.approval_above_cents`, `app_passkey`, `app_spend_approval`). Mira only changes `approval` from `pending` to `approved`. Approval evidence lives in her table.
- Mira's paths: `src/lib/services/approvalPolicy.ts` (`approvalRequired(agent: { approvalAboveCents: number | null }, maxAmountCents)`) and `src/lib/interactors/ApprovalInteractor.ts` (`app.approvals.approvalUrl(spendId)`, which returns `${publicUrl}/app/approve/<spendId>`). Until this branch lands, she codes against `IntentPort = { releaseIntent }`.
