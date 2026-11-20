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
  - Codes we use: `116 INSUFF_FUNDS`, `119 TXN_NOT_PERMIT`, `125 BLK_MRCH`, `127 RESTRICT_MCC`, `129 LIMIT_EXCEED`, `130 VELOCITY_EXCEED`, `143 CRD_CLOSED`, `911 ERROR`.
- **Fields we use:**
  - Identity and money: `requestType` (`Authorization`, `Settlement`, others unknown), `cardId`, `transactionAmount` (always USD), `authorizationAmount` + `transactionCurrencyCode`, `charge` + `chargeType`.
  - Merchant: `merchantCategoryCode`, `merchantName`, `merchantCountry`, `merchantAcceptorId`.
  - References: `reference`, `eventId`, `eventTime`, `switchReference`, `cardTransactionAuthorizationId`, `precedingRelatedToken`, `riskAssessment`.
- **`accountNumber` is the card number.** The endpoint is therefore in PCI scope unless a vault proxy redacts the field first (VGS inbound route or Evervault Relay). Until then:
  - Never log or store the raw body.
  - Drop `accountNumber` at parse time.
  - The PAN-redacting log formatter (todo tmwj9kvguh) must be in front of this route.
- **Effect on funding:** under customer-managed authorization, Miden's top-up and balance endpoints do not apply, and **our ledger is the balance**. How Miden settles approved spend with us is UNCONFIRMED (ask Miden). It probably comes from our Miden USD wallet, which replaces per-card top-ups.

## The intent

An intent is an `app_spend` row that has not been authorized yet. We extend `app_spend` rather than adding a table, because checkouts, swaps and reconcile already key on `spend_id`.

New columns (migration 014):

| Column | Meaning |
| --- | --- |
| `expires_at` | After this time, no authorization can match. Default 30 min, maximum 7 days. |
| `max_amount_cents` | Upper bound an authorization may reach. Defaults to `amount_cents`. The tolerance for tips and FX is a policy setting, default 0. |
| `merchant_match` | Optional normalised merchant name or acceptor ID the authorization must match. |
| `uses_allowed` / `uses` | Default 1. Above 1 only for a recurring intent. |
| `approval` | `none`, `pending` or `approved`. Used by the human-approval work. |
| `auth_ref` | Miden `cardTransactionAuthorizationId` that consumed the intent. |
| `context` | Free text shown to the owner, from the agent. |

New statuses: `processing` keeps meaning "held, waiting for the authorization", and `expired` is added.

## Money

- **Creating the intent holds the money.** It debits `agent:<id>` into `hold:<card>`, so concurrent intents cannot overspend the sub-balance. This is the same ledger move `pay` already makes, just earlier.
- **An authorization that matches is approved.** `hold:<card>` moves to `external:merchant`, the status becomes `approved`, and `auth_ref` is recorded.
- **On expiry with no authorization,** the hold is reversed and the status becomes `expired`. The sweeper runs in the background workers.
- **Settlement:**
  - Settlement for the same amount: no money moves, and we record the settlement ID.
  - Settlement for a different amount (tip, FX, partial): adjust between `agent:<id>` and `external:merchant`, then alert if the difference exceeds the tolerance.
  - A settlement with no prior authorization (force post): post it against the agent that owns the card and raise `needs_review`.
- **A reversal or refund** returns the money to `agent:<id>`.

## The decision (must finish within 400 ms)

Everything below runs on indexed reads plus one transaction:

1. Verify the signature. If it fails, return HTTP 401, and Miden applies the default, which is decline.
2. Dedupe on `eventId`. If we have already answered this event, return the same answer.
3. Look up the card. If it is unknown or closed, decline `143`.
4. Find the open intents on this card: `processing`, `expires_at > now()`, `uses < uses_allowed`, and `approval` not `pending`.
5. Keep only the intents where `transactionAmount + charge <= max_amount_cents`, the MCC is allowed, and the merchant matches if a match is set.
6. With no match, decline `119 TXN_NOT_PERMIT`, store the decline, and alert the owner. This is the bypass case: someone used the card outside our flow.
7. With exactly one match, approve `000`. With several matches, pick the oldest whose amount is closest and approve that one.
8. If the database is slow or unavailable, decline `911` before the deadline. Never approve when unsure.

## Cards

Miden caps a customer at **3 cards, one-time cards included** (architecture.md, limit 9). So "one card per intent" is not possible. We keep one reusable card per owner, plus one-time cards for hosted checkout as today. The intent match carries the per-agent binding, and the card does not need to. Ask Miden whether the cap can be raised.

## Who builds what

| Item | Owner | Depends on |
| --- | --- | --- |
| Migration 014, intent create/expire, holds, the callback route, settlement and reversal | Obi | none |
| Human approval of intents above a per-agent threshold (passkey / WebAuthn, owner dashboard) | Mira (backend) + Amara (UI) | `approval` column, intent API |
| Per-agent scoped sub-keys; developer API key can only create intents within owner limits | Val | none |
| x402 (HTTP 402 + USDC on Base) on our merchant checkout | Val, after sub-keys | none |
| Replace Basis Theory with VGS or Evervault: Miden response redaction, cardholder reveal, browser-proxy checkout | Lin (evaluation) | boss picks a vendor |

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
